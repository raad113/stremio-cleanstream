/**
 * CleanStream JSON storage
 *
 * File-based storage used when DATABASE_URL is not set. Each title lives in
 * data/filters/<id>.json. Episode ids such as "tt0944947:1:2" are stored as
 * "tt0944947_1_2.json" so the file names are valid on every operating system.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.CLEANSTREAM_DATA_DIR || path.join(__dirname, '../../data/filters');

// Movie ids look like tt1234567; episode ids add :season:episode.
const CONTENT_ID_PATTERN = /^tt\d{1,10}(:\d{1,4}:\d{1,5})?$/;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// In-memory copy of every title, built on first use and kept in sync on writes.
let index = null;

function isValidContentId(id) {
  return typeof id === 'string' && CONTENT_ID_PATTERN.test(id);
}

function fileFor(imdbId) {
  if (!isValidContentId(imdbId)) {
    throw new Error(`Invalid content id: ${imdbId}`);
  }
  return path.join(DATA_DIR, `${imdbId.replace(/:/g, '_')}.json`);
}

function loadIndex() {
  if (index) return index;
  index = new Map();
  for (const file of fs.readdirSync(DATA_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
      if (data && data.imdbId) index.set(data.imdbId, data);
    } catch (error) {
      console.error(`[JSON storage] Could not read ${file}:`, error.message);
    }
  }
  return index;
}

/**
 * Get filters for a movie or episode id. Returns null when nothing is stored.
 */
function getFilters(imdbId) {
  if (!isValidContentId(imdbId)) return null;
  return loadIndex().get(imdbId) || null;
}

/**
 * Save the full filter document for an id.
 */
function saveFilters(imdbId, filterData) {
  try {
    fs.writeFileSync(fileFor(imdbId), JSON.stringify(filterData, null, 2) + '\n');
    loadIndex().set(imdbId, filterData);
    return true;
  } catch (error) {
    console.error(`[JSON storage] Error saving ${imdbId}:`, error.message);
    return false;
  }
}

function createEmptyFilterData(imdbId) {
  const now = new Date().toISOString();
  return {
    imdbId,
    title: null,
    year: null,
    type: imdbId.includes(':') ? 'episode' : null,
    segments: [],
    releases: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Add a new skip segment and return it.
 */
function addSegment(imdbId, segment) {
  const filterData = getFilters(imdbId) || createEmptyFilterData(imdbId);
  const { contributorIp, titleName, year, type, ...clean } = segment;

  const stored = {
    ...clean,
    id: `seg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
    addedAt: new Date().toISOString(),
    votes: { up: 0, down: 0 },
    verified: false,
  };

  if (!filterData.title && titleName) filterData.title = titleName;
  if (!filterData.year && year) filterData.year = year;
  if (!filterData.type && type) filterData.type = type;

  filterData.segments.push(stored);
  filterData.segments.sort((a, b) => a.startMs - b.startMs);
  filterData.updatedAt = stored.addedAt;
  filterData.version = (filterData.version || 1) + 1;

  saveFilters(imdbId, filterData);
  return stored;
}

/**
 * Record a vote. Each visitor gets one vote per segment; voting the other way
 * changes the earlier vote instead of adding a second one.
 */
function voteSegment(imdbId, segmentId, voteType, visitorId) {
  const filterData = getFilters(imdbId);
  if (!filterData) return { success: false, reason: 'not_found' };

  const segment = filterData.segments.find(s => s.id === segmentId);
  if (!segment) return { success: false, reason: 'not_found' };

  segment.votes = segment.votes || { up: 0, down: 0 };
  segment.voters = segment.voters || {};
  const previous = visitorId ? segment.voters[visitorId] : undefined;

  if (previous === voteType) return { success: false, reason: 'already_voted' };
  if (previous) segment.votes[previous] = Math.max(0, segment.votes[previous] - 1);

  segment.votes[voteType] += 1;
  if (visitorId) segment.voters[visitorId] = voteType;

  filterData.updatedAt = new Date().toISOString();
  saveFilters(imdbId, filterData);
  return { success: true, changed: Boolean(previous) };
}

function listAllFilters() {
  return [...loadIndex().keys()];
}

function summarize(t) {
  return {
    imdbId: t.imdbId,
    title: t.title,
    year: t.year,
    type: t.type,
    segmentCount: (t.segments || []).length,
    updatedAt: t.updatedAt,
  };
}

/**
 * List titles that have segments, with the same sort options as PostgreSQL.
 */
function listTitles({ limit = 100, offset = 0, sortBy = 'recent', type } = {}) {
  let titles = [...loadIndex().values()].filter(t => (t.segments || []).length > 0);
  if (type) titles = titles.filter(t => (t.type || 'movie') === type);

  const sorters = {
    popular: (a, b) => b.segments.length - a.segments.length,
    year: (a, b) => (b.year || 0) - (a.year || 0),
    title: (a, b) => String(a.title || a.imdbId).localeCompare(String(b.title || b.imdbId)),
    recent: (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
  };
  titles.sort(sorters[sortBy] || sorters.recent);

  return titles.slice(offset, offset + limit).map(summarize);
}

function searchTitles(query) {
  const q = String(query || '').toLowerCase();
  return [...loadIndex().values()]
    .filter(t => t.imdbId.toLowerCase().includes(q) || String(t.title || '').toLowerCase().includes(q))
    .slice(0, 20)
    .map(summarize);
}

function getStats() {
  let totalSegments = 0;
  let verifiedSegments = 0;
  const titles = loadIndex();
  for (const t of titles.values()) {
    totalSegments += (t.segments || []).length;
    verifiedSegments += (t.segments || []).filter(s => s.verified).length;
  }
  return { totalTitles: titles.size, totalSegments, verifiedSegments };
}

module.exports = {
  isValidContentId,
  getFilters,
  saveFilters,
  addSegment,
  createEmptyFilterData,
  listAllFilters,
  listTitles,
  searchTitles,
  voteSegment,
  getStats,
  DATA_DIR,
};
