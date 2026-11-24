/**
 * CleanStream API Routes
 * REST API for skip data, community contributions, voting and statistics.
 */

const crypto = require('crypto');
const express = require('express');
const db = require('../database');
const cache = require('../cache');
const { generateSkips, generatePendingSkips, generateSkipVTT, generateSkipJSON } = require('../utils/skipGenerator');
const trust = require('../community/trust');
const { getDigitalRelease, imdbIdForTmdb, imdbIdForTmdbShow } = require('../utils/digitalRelease');
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
// Secret salt for anonymous voter ids. Without CLEANSTREAM_VOTE_SALT a random one is
// made at start-up (more private than a public default, but votes can repeat after a restart).
const VOTE_SALT = process.env.CLEANSTREAM_VOTE_SALT || crypto.randomBytes(32).toString('hex');
if (!process.env.CLEANSTREAM_VOTE_SALT) {
  console.warn('[API] CLEANSTREAM_VOTE_SALT is not set: using a random salt until the next restart');
}

function visitorIdFor(req) {
  const salt = VOTE_SALT;
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
 * Admin access: Authorization: Bearer <ADMIN_TOKEN>. Disabled when ADMIN_TOKEN is not set.
 */
function requireAdmin(req, res, next) {
  const token = process.env.ADMIN_TOKEN || '';
  const given = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const ok = token.length >= 16 && given.length === token.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
  if (!ok) return res.status(401).json({ error: 'Admin token required' });
  next();
}

/**
 * Record that one of a contributor's skips was approved or rejected.
 */
async function creditContributor(hash, newStatus) {
  if (!hash) return;
  const current = await db.getContributor(hash);
  await db.saveContributor(hash, trust.contributorAfterDecision(current, newStatus));
}

/**
 * Change a segment's status and update its contributor's reputation.
 */
async function decideSegment(imdbId, segment, newStatus) {
  if (trust.statusOf(segment) === newStatus) return;
  await db.setSegmentStatus(imdbId, segment.id, newStatus);
  await creditContributor(segment.contributorHash, newStatus);
}

/** Public copy of a segment: never reveal who contributed it. */
const publicSegment = ({ contributorHash, voters, ...seg }) => seg;

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
 * Check a timing fingerprint sent with a skip: the subtitle cue times of the
 * copy it was marked on. Returns { refId, ref } or null when absent or invalid.
 * Only times are stored, never subtitle text.
 */
const REF_KINDS = ['embedded', 'subtitle'];
function validateRef(input) {
  if (!input || typeof input !== 'object') return null;
  const { kind, cues } = input;
  const durationMs = Number(input.durationMs);
  if (!REF_KINDS.includes(kind) || !Array.isArray(cues)) return null;
  if (cues.length < 50 || cues.length > 6000) return null;
  const clean = [];
  let last = -1;
  for (const c of cues) {
    if (!Array.isArray(c) || c.length !== 2) return null;
    const [start, end] = c.map(Number);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > MAX_POSITION_MS) return null;
    if (start < last) return null; // must be in time order
    last = start;
    clean.push([start, end]);
  }
  const ref = {
    kind,
    durationMs: Number.isInteger(durationMs) && durationMs > 0 && durationMs <= MAX_POSITION_MS ? durationMs : null,
    cues: clean,
  };
  const refId = crypto.createHash('sha256').update(JSON.stringify(clean)).digest('hex').slice(0, 16);
  return { refId, ref };
}

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
    res.json({ ...filterData, segments: filterData.segments.map(publicSegment) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get filter data' });
  }
});

async function sendSkipJSON(req, res) {
  try {
    const { imdbId } = req.params;
    const config = parseConfig(req.query);
    const requesterHash = visitorIdFor(req);
    const [skips, filterData] = await Promise.all([
      generateSkips(imdbId, config, { requesterHash }),
      db.getFilters(imdbId),
    ]);
    const metadata = filterData ? { title: filterData.title, year: filterData.year, type: filterData.type } : {};
    const body = generateSkipJSON(skips, imdbId, metadata);
    // ?pending=1 adds other viewers' unconfirmed skips, for "Skip / Not a scene" prompts
    if (req.query.pending === '1') {
      body.pending = await generatePendingSkips(imdbId, config, { requesterHash });
    }
    res.json(body);
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate skips' });
  }
}

router.get('/skips/:imdbId', sendSkipJSON);

/** GET /api/refs/:refId: a timing fingerprint (cue times only). Never changes once saved. */
router.get('/refs/:refId', async (req, res) => {
  const { refId } = req.params;
  if (!/^[0-9a-f]{16}$/.test(refId)) return res.status(400).json({ error: 'Invalid reference id' });
  try {
    const ref = await db.getTimingRef(refId);
    if (!ref) return res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.json({ refId, ...ref });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load reference' });
  }
});

/**
 * GET /api/badges?ids=tt1,tmdb:movie:2,tmdb:tv:3,...  (at most 40)
 * For poster tags in the app: whether a title has confirmed skips ("clean"),
 * how many unconfirmed ones it has ("pending"), and for movies its digital
 * release status. Catalogs that use TMDB
 * numbers instead of IMDb ids are looked up through TMDB. Answers are keyed
 * by the id exactly as asked.
 */
router.get('/badges', async (req, res) => {
  const keys = String(req.query.ids || '')
    .split(',')
    .map(s => s.trim())
    .filter(id => /^(tt\d{1,10}|tmdb:(movie|tv):\d{1,10})$/.test(id))
    .slice(0, 40);
  try {
    const entries = await Promise.all(keys.map(async key => {
      let imdbId = key;
      let isShow = false;
      if (key.startsWith('tmdb:')) {
        const [, kind, tmdbId] = key.split(':');
        isShow = kind === 'tv';
        imdbId = await (isShow ? imdbIdForTmdbShow(tmdbId) : imdbIdForTmdb(tmdbId)).catch(() => null);
        if (!imdbId) return [key, { clean: false, skips: 0, digital: null }];
      }
      const [filters, digital, episodes] = await Promise.all([
        db.getFilters(imdbId).catch(() => null),
        isShow ? null : getDigitalRelease(imdbId).catch(() => null),
        // A show counts as clean when any of its episodes has skips
        db.searchTitles(imdbId).catch(() => []),
      ]);
      let approved = filters ? filters.segments.filter(seg => trust.statusOf(seg) === 'approved').length : 0;
      // Unconfirmed skips (marked by one viewer, or imported) that nobody has voted down
      const pending = filters
        ? filters.segments.filter(seg => trust.statusOf(seg) === 'pending' && ((seg.votes?.down || 0) - (seg.votes?.up || 0)) < 3).length
        : 0;
      if (approved === 0) {
        approved = (episodes || [])
          .filter(t => String(t.imdbId).startsWith(imdbId + ':'))
          .reduce((sum, t) => sum + (t.segmentCount || 0), 0);
      }
      return [key, {
        imdbId,
        clean: approved > 0,
        skips: approved,
        pending,
        digital: digital ? { status: digital.status, date: digital.date } : null,
      }];
    }));
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(Object.fromEntries(entries));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load badges' });
  }
});
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
router.post('/contribute/:imdbId', contributeLimiter, express.json({ limit: '400kb' }), async (req, res) => {
  const { segment, error } = validateSegment(req.body || {});
  if (error) {
    return res.status(400).json({ error });
  }

  try {
    const { imdbId } = req.params;
    const contributorHash = visitorIdFor(req);
    const [contributor, filterData] = await Promise.all([db.getContributor(contributorHash), db.getFilters(imdbId)]);
    const existing = filterData ? filterData.segments : [];
    const timing = validateRef(req.body.ref);
    const candidate = {
      ...segment,
      contributorHash,
      refId: timing ? timing.refId : null,
      durationMs: timing && timing.ref.durationMs ? timing.ref.durationMs : null,
    };

    const limitError = trust.checkLimits(candidate, contributor, existing);
    if (limitError) {
      return res.status(contributor && contributor.blocked ? 403 : 400).json({ error: limitError });
    }

    const { status, corroborates } = trust.decideNewStatus(candidate, contributor, existing);
    if (timing) await db.saveTimingRef(timing.refId, timing.ref);
    const saved = await db.addSegment(imdbId, { ...candidate, status });

    // A matching mark from another viewer confirms both
    for (const other of corroborates) {
      await decideSegment(imdbId, other, 'approved');
    }
    if (corroborates.length > 0) await creditContributor(contributorHash, 'approved');
    await cache.invalidateTitle?.(imdbId);

    res.status(201).json({
      message: status === 'approved'
        ? 'Skip added and applied for everyone'
        : 'Skip added. It applies to you now and to everyone once another viewer confirms it',
      status,
      segment: publicSegment(saved),
    });
  } catch (err) {
    console.error('[API] Contribution failed:', err.message);
    res.status(500).json({ error: 'Failed to save segment' });
  }
});

/**
 * POST /api/contribute/:imdbId/mcf
 * Bulk import a MovieContentFilter (MCF) file.
 */
router.post('/contribute/:imdbId/mcf', requireAdmin, express.text({ type: '*/*', limit: '200kb' }), async (req, res) => {
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
router.post('/vote/:imdbId/:segmentId', voteLimiter, express.json({ limit: '400kb' }), async (req, res) => {
  const { imdbId, segmentId } = req.params;
  const { vote } = req.body || {};

  if (!['up', 'down'].includes(vote)) {
    return res.status(400).json({ error: 'Vote must be "up" or "down"' });
  }

  try {
    const visitorId = visitorIdFor(req);
    const before = await db.getFilters(imdbId);
    const target = before && before.segments.find(s => s.id === segmentId);
    if (!target) {
      return res.status(404).json({ error: 'Segment not found' });
    }
    if (target.contributorHash && target.contributorHash === visitorId) {
      return res.status(403).json({ error: 'You cannot vote on your own skip' });
    }

    const result = await db.voteSegment(imdbId, segmentId, vote, visitorId);
    if (result.reason === 'not_found') {
      return res.status(404).json({ error: 'Segment not found' });
    }
    if (result.reason === 'already_voted') {
      return res.status(409).json({ error: 'You already voted on this segment' });
    }

    // A viewer who confirms a skip that has no timing fingerprint yet supplies
    // theirs, so the skip can be lined up on other copies from now on
    if (vote === 'up' && !target.refId) {
      const timing = validateRef(req.body.ref);
      if (timing) {
        await db.saveTimingRef(timing.refId, timing.ref);
        await db.setSegmentRef(imdbId, segmentId, timing.refId, timing.ref.durationMs);
      }
    }

    // Votes can confirm a pending skip or hide a wrong one
    const after = await db.getFilters(imdbId);
    const updated = after && after.segments.find(s => s.id === segmentId);
    const newStatus = updated && trust.statusAfterVotes(updated);
    if (newStatus) await decideSegment(imdbId, updated, newStatus);

    await cache.invalidateTitle?.(imdbId);
    res.json({ message: result.changed ? 'Vote changed' : 'Vote recorded', status: newStatus || trust.statusOf(updated || target) });
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

/* ------------------------------------------------------------------ */
/* Admin (moderation)                                                  */
/* ------------------------------------------------------------------ */

/** GET /api/admin/pending: unconfirmed skips, newest first, with contributor standing. */
router.get('/admin/pending', requireAdmin, async (req, res) => {
  const items = await db.listPending({ limit: Math.min(Number(req.query.limit) || 100, 500) });
  const withStanding = await Promise.all(items.map(async item => {
    const c = await db.getContributor(item.segment.contributorHash);
    return {
      imdbId: item.imdbId,
      title: item.title,
      segment: publicSegment(item.segment),
      contributor: {
        id: (item.segment.contributorHash || '').slice(0, 8) || null,
        approved: c?.approved || 0,
        rejected: c?.rejected || 0,
        blocked: !!c?.blocked,
      },
    };
  }));
  res.json({ count: withStanding.length, items: withStanding });
});

/** POST /api/admin/segments/:imdbId/:segmentId  body: { action: "approve" | "reject" | "block" } */
router.post('/admin/segments/:imdbId/:segmentId', requireAdmin, express.json({ limit: '1kb' }), async (req, res) => {
  const { imdbId, segmentId } = req.params;
  const { action } = req.body || {};
  if (!['approve', 'reject', 'block'].includes(action)) {
    return res.status(400).json({ error: 'action must be approve, reject or block' });
  }
  const filterData = await db.getFilters(imdbId);
  const segment = filterData && filterData.segments.find(s => s.id === segmentId);
  if (!segment) return res.status(404).json({ error: 'Segment not found' });

  await decideSegment(imdbId, segment, action === 'approve' ? 'approved' : 'rejected');
  if (action === 'block' && segment.contributorHash) {
    const c = await db.getContributor(segment.contributorHash);
    await db.saveContributor(segment.contributorHash, { approved: 0, rejected: 0, ...c, blocked: true });
  }
  await cache.invalidateTitle?.(imdbId);
  res.json({ message: `Done: ${action}` });
});

module.exports = router;
module.exports.parseConfig = parseConfig;
module.exports.validateSegment = validateSegment;
