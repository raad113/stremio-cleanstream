/**
 * CleanStream API Routes
 * REST API for skip data, community contributions, voting and statistics.
 */

const crypto = require('crypto');
const express = require('express');
const db = require('../database');
const cache = require('../cache');
const { generateSkips, generateSkipVTT, generateSkipJSON } = require('../utils/skipGenerator');
const { parseMCF, generateMCF, mcfToDBSegments, dbToMCFSegments } = require('../utils/mcf');

const router = express.Router();

const FILTER_KEYS = ['nudity', 'sex', 'violence', 'language', 'drugs', 'fear'];
const VALID_CATEGORIES = ['nudity', 'sex', 'violence', 'language', 'drugs', 'fear', 'discrimination', 'dispensable', 'commercial'];
const VALID_SEVERITIES = ['low', 'medium', 'high'];
const VALID_CHANNELS = ['both', 'video', 'audio'];

// Limits for community input
const MAX_SEGMENT_MS = 30 * 60 * 1000;   // a single skip may last at most 30 minutes
const MAX_POSITION_MS = 8 * 60 * 60 * 1000; // and must start within the first 8 hours
const DEFAULT_CONFIG = { nudity: 'high', sex: 'high', violence: 'medium', language: 'off', drugs: 'off', fear: 'off' };

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Read filter preferences from ?config={json} or from individual query params.
 */
function parseConfig(query, defaults = DEFAULT_CONFIG) {
  const config = { ...defaults };
  if (query.config) {
    try {
      Object.assign(config, JSON.parse(query.config));
    } catch (e) {
      // fall through to individual params
    }
  }
  for (const key of FILTER_KEYS) {
    if (typeof query[key] === 'string') config[key] = query[key];
  }
  return config;
}

/**
 * Anonymous, stable identifier for a visitor (used to stop repeat voting).
 * Only a salted hash is stored, never the IP address itself.
 */
function visitorIdFor(req) {
  const salt = process.env.CLEANSTREAM_VOTE_SALT || 'cleanstream';
  return crypto
    .createHash('sha256')
    .update(`${salt}|${req.ip}|${req.get('user-agent') || ''}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Very small in-memory rate limiter (per IP, per action).
 */
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const count = (hits.get(req.ip) || 0) + 1;
    hits.set(req.ip, count);
    if (count > max) {
      return res.status(429).json({ error: 'Too many requests, please try again later' });
    }
    next();
  };
}

const contributeLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: Number(process.env.CONTRIBUTE_LIMIT_PER_HOUR) || 60 });
const voteLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: Number(process.env.VOTE_LIMIT_PER_HOUR) || 300 });

/**
 * Reject malformed ids early (also protects the JSON file storage).
 */
router.param('imdbId', (req, res, next, imdbId) => {
  if (!db.isValidContentId(imdbId)) {
    return res.status(400).json({ error: 'Invalid id. Use tt1234567 or tt1234567:season:episode' });
  }
  next();
});

/**
 * Check and normalise one contributed segment. Returns { segment } or { error }.
 */
function validateSegment(body) {
  const startMs = Number(body.startMs);
  const endMs = Number(body.endMs);
  const { category, severity } = body;
  const channel = body.channel || 'both';

  if (!Number.isInteger(startMs) || !Number.isInteger(endMs)) {
    return { error: 'startMs and endMs must be whole numbers of milliseconds' };
  }
  if (startMs < 0 || endMs <= startMs) {
    return { error: 'endMs must be greater than startMs, and startMs cannot be negative' };
  }
  if (endMs - startMs > MAX_SEGMENT_MS || startMs > MAX_POSITION_MS) {
    return { error: 'Segment is too long or starts too late in the video' };
  }
  if (!VALID_CATEGORIES.includes(category)) {
    return { error: `Invalid category. Use one of: ${VALID_CATEGORIES.join(', ')}` };
  }
  if (!VALID_SEVERITIES.includes(severity)) {
    return { error: 'Invalid severity. Must be: low, medium, or high' };
  }
  if (!VALID_CHANNELS.includes(channel)) {
    return { error: 'Invalid channel. Must be: both, video, or audio' };
  }

  const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

  return {
    segment: {
      startMs,
      endMs,
      category,
      subcategory: text(body.subcategory, 40) || category,
      severity,
      channel,
      comment: text(body.comment, 200),
      contributor: text(body.contributor, 40) || 'anonymous',
      titleName: text(body.title, 200),
      year: Number.isInteger(Number(body.year)) ? Number(body.year) : undefined,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Read endpoints                                                      */
/* ------------------------------------------------------------------ */

router.get('/health', async (req, res) => {
  const [dbHealth, cacheHealth] = await Promise.all([db.healthCheck(), cache.healthCheck()]);
  const isHealthy = dbHealth.status === 'healthy' || !process.env.DATABASE_URL;

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'degraded',
    version: require('../../package.json').version,
    storage: process.env.DATABASE_URL ? 'postgresql' : 'json',
    database: dbHealth,
    cache: cacheHealth,
  });
});

router.get('/stats', async (req, res) => {
  try {
    const stats = await db.getStats();
    res.json({
      totalMovies: stats.totalTitles || 0,
      totalSegments: stats.totalSegments || 0,
      verifiedSegments: stats.verifiedSegments || 0,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

router.get('/filters', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const titles = await db.listTitles({ limit, offset, sortBy: req.query.sort || 'title' });
    res.json({ count: titles.length, filters: titles });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list filters' });
  }
});

router.get('/filters/:imdbId', async (req, res) => {
  try {
    const filterData = await db.getFilters(req.params.imdbId);
    if (!filterData) {
      return res.status(404).json({ error: 'No filter data found for this ID' });
    }
    res.json(filterData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get filter data' });
  }
});

async function sendSkipJSON(req, res) {
  try {
    const { imdbId } = req.params;
    const config = parseConfig(req.query);
    const [skips, filterData] = await Promise.all([generateSkips(imdbId, config), db.getFilters(imdbId)]);
    const metadata = filterData ? { title: filterData.title, year: filterData.year, type: filterData.type } : {};
    res.json(generateSkipJSON(skips, imdbId, metadata));
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate skips' });
  }
}

router.get('/skips/:imdbId', sendSkipJSON);
router.get('/skips/:imdbId/json', sendSkipJSON);

router.get('/skips/:imdbId/vtt', async (req, res) => {
  try {
    const { imdbId } = req.params;
    const skips = await generateSkips(imdbId, parseConfig(req.query));
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.send(generateSkipVTT(skips, imdbId));
  } catch (error) {
    res.status(500).send('WEBVTT\n\n');
  }
});

router.get('/skips/:imdbId/mcf', async (req, res) => {
  const { imdbId } = req.params;
  const filterData = await db.getFilters(imdbId);

  if (!filterData) {
    return res.status(404).json({ error: 'No filter data found for this ID' });
  }

  const mcf = generateMCF({
    metadata: {
      title: filterData.title,
      year: filterData.year,
      type: filterData.type,
      imdb: `https://www.imdb.com/title/${imdbId.split(':')[0]}/`,
    },
    markers: { start: 0, end: null },
    segments: dbToMCFSegments(filterData.segments),
  });

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${imdbId.replace(/:/g, '_')}.mcf"`);
  res.send(mcf);
});

/* ------------------------------------------------------------------ */
/* Community endpoints                                                 */
/* ------------------------------------------------------------------ */

/**
 * POST /api/contribute/:imdbId
 * Add a new skip segment. It is used straight away and can be voted on.
 */
router.post('/contribute/:imdbId', contributeLimiter, express.json({ limit: '10kb' }), async (req, res) => {
  const { segment, error } = validateSegment(req.body || {});
  if (error) {
    return res.status(400).json({ error });
  }

  try {
    const saved = await db.addSegment(req.params.imdbId, segment);
    await cache.invalidateTitle?.(req.params.imdbId);
    res.status(201).json({ message: 'Segment added successfully', segment: saved });
  } catch (err) {
    console.error('[API] Contribution failed:', err.message);
    res.status(500).json({ error: 'Failed to save segment' });
  }
});

/**
 * POST /api/contribute/:imdbId/mcf
 * Bulk import a MovieContentFilter (MCF) file.
 */
router.post('/contribute/:imdbId/mcf', contributeLimiter, express.text({ type: '*/*', limit: '200kb' }), async (req, res) => {
  const { imdbId } = req.params;

  let mcfData;
  try {
    mcfData = parseMCF(req.body);
  } catch (err) {
    return res.status(400).json({ error: `Invalid MCF format: ${err.message}` });
  }

  const contributor = String(req.query.contributor || 'mcf-import').slice(0, 40);
  const segments = [];
  for (const seg of mcfToDBSegments(mcfData.segments)) {
    const { segment } = validateSegment({ ...seg, contributor });
    if (segment) segments.push(segment);
  }

  if (segments.length === 0) {
    return res.status(400).json({ error: 'The MCF file contained no valid segments' });
  }

  try {
    if (mcfData.metadata) await db.updateTitleMetadata(imdbId, {
      title: mcfData.metadata.title || undefined,
      year: mcfData.metadata.year ? Number(mcfData.metadata.year) : undefined,
    });
    const result = await db.bulkImportSegments(imdbId, segments);
    await cache.invalidateTitle?.(imdbId);
    res.status(201).json({ message: 'MCF imported successfully', segmentsAdded: result.imported });
  } catch (err) {
    console.error('[API] MCF import failed:', err.message);
    res.status(500).json({ error: 'Failed to import MCF' });
  }
});

/**
 * POST /api/vote/:imdbId/:segmentId   body: { "vote": "up" | "down" }
 * One vote per visitor per segment. Segments with 3+ more downvotes than
 * upvotes stop being served.
 */
router.post('/vote/:imdbId/:segmentId', voteLimiter, express.json({ limit: '1kb' }), async (req, res) => {
  const { imdbId, segmentId } = req.params;
  const { vote } = req.body || {};

  if (!['up', 'down'].includes(vote)) {
    return res.status(400).json({ error: 'Vote must be "up" or "down"' });
  }

  try {
    const result = await db.voteSegment(imdbId, segmentId, vote, visitorIdFor(req));
    if (result.reason === 'not_found') {
      return res.status(404).json({ error: 'Segment not found' });
    }
    if (result.reason === 'already_voted') {
      return res.status(409).json({ error: 'You already voted on this segment' });
    }
    await cache.invalidateTitle?.(imdbId);
    res.json({ message: result.changed ? 'Vote changed' : 'Vote recorded' });
  } catch (err) {
    console.error('[API] Vote failed:', err.message);
    res.status(500).json({ error: 'Failed to record vote' });
  }
});

/**
 * PUT /api/filters/:imdbId/metadata
 * Update title name/year/type.
 */
router.put('/filters/:imdbId/metadata', contributeLimiter, express.json({ limit: '2kb' }), async (req, res) => {
  const { title, year, type } = req.body || {};
  const metadata = {};
  if (typeof title === 'string' && title.trim()) metadata.title = title.trim().slice(0, 200);
  if (Number.isInteger(Number(year))) metadata.year = Number(year);
  if (['movie', 'series', 'episode'].includes(type)) metadata.type = type;

  try {
    const updated = await db.updateTitleMetadata(req.params.imdbId, metadata);
    res.json({ message: 'Metadata updated', filterData: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update metadata' });
  }
});

module.exports = router;
module.exports.parseConfig = parseConfig;
module.exports.validateSegment = validateSegment;
