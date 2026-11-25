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
    // Files starting with "_" hold other data (for example contributors)
    if (!file.endsWith('.json') || file.startsWith('_')) continue;
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
    status: clean.status || 'pending',
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

/**
 * Change a segment's status ("pending", "approved" or "rejected").
 */
function setSegmentStatus(imdbId, segmentId, status) {
  const filterData = getFilters(imdbId);
  const segment = filterData && filterData.segments.find(s => s.id === segmentId);
  if (!segment) return false;
  segment.status = status;
  filterData.updatedAt = new Date().toISOString();
  saveFilters(imdbId, filterData);
  return true;
}

/** Change a segment's category (and subcategory). */
function setSegmentCategory(imdbId, segmentId, category) {
  const filterData = getFilters(imdbId);
  const segment = filterData && filterData.segments.find(s => s.id === segmentId);
  if (!segment) return false;
  segment.category = category;
  segment.subcategory = category;
  filterData.updatedAt = new Date().toISOString();
  saveFilters(imdbId, filterData);
  return true;
}

/** Attach a timing fingerprint to a segment that has none yet. */
function setSegmentRef(imdbId, segmentId, refId, durationMs) {
  const filterData = getFilters(imdbId);
  const segment = filterData && filterData.segments.find(s => s.id === segmentId);
  if (!segment || segment.refId) return false;
  segment.refId = refId;
  if (Number.isInteger(durationMs)) segment.durationMs = durationMs;
  saveFilters(imdbId, filterData);
  return true;
}

/** Pending segments across all titles, newest first. */
function listPending({ limit = 100 } = {}) {
  const out = [];
  for (const t of loadIndex().values()) {
    for (const s of t.segments || []) {
      if (s.status === 'pending') out.push({ imdbId: t.imdbId, title: t.title, segment: s });
    }
  }
  out.sort((a, b) => String(b.segment.addedAt || '').localeCompare(String(a.segment.addedAt || '')));
  return out.slice(0, limit);
}

// Contributor reputation, keyed by anonymous hash
const CONTRIBUTORS_FILE = path.join(DATA_DIR, '_contributors.json');
let contributors = null;

function loadContributors() {
  if (contributors) return contributors;
  try {
    contributors = JSON.parse(fs.readFileSync(CONTRIBUTORS_FILE, 'utf8'));
  } catch (e) {
    contributors = {};
  }
  return contributors;
}

function getContributor(hash) {
  return hash ? loadContributors()[hash] || null : null;
}

function saveContributor(hash, data) {
  if (!hash) return null;
  const all = loadContributors();
  all[hash] = { ...all[hash], ...data, updatedAt: new Date().toISOString() };
  fs.writeFileSync(CONTRIBUTORS_FILE, JSON.stringify(all, null, 2) + '\n');
  return all[hash];
}

// Progress of automatic imports, keyed by name
const IMPORT_STATE_FILE = path.join(DATA_DIR, '_import_state.json');

function getImportState(key) {
  try {
    return JSON.parse(fs.readFileSync(IMPORT_STATE_FILE, 'utf8'))[key] ?? null;
  } catch (e) {
    return null;
  }
}

function setImportState(key, value) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(IMPORT_STATE_FILE, 'utf8')); } catch (e) { /* first write */ }
  all[key] = value;
  fs.writeFileSync(IMPORT_STATE_FILE, JSON.stringify(all) + '\n');
}

function listAllFilters() {
  return [...loadIndex().keys()];
}

// Segments without a status (bundled data) are unconfirmed until someone confirms them
const isApproved = s => (s.status || 'pending') === 'approved';
const approvedCount = t => (t.segments || []).filter(isApproved).length;

function summarize(t) {
  return {
    imdbId: t.imdbId,
    title: t.title,
    year: t.year,
    type: t.type,
    // Only confirmed skips count towards a title being "clean"
    segmentCount: approvedCount(t),
    updatedAt: t.updatedAt,
  };
}

function countEpisodeSegments(showId) {
  let approved = 0;
  let pending = 0;
  for (const [id, t] of loadIndex()) {
    if (!id.startsWith(`${showId}:`)) continue;
    for (const s of t.segments || []) {
      const net = ((s.votes && s.votes.down) || 0) - ((s.votes && s.votes.up) || 0);
      if (isApproved(s)) approved++;
      else if (s.status === 'pending' && net < 3) pending++;
    }
  }
  return { approved, pending };
}

function resetVotes(imdbId, segmentId) {
  const filterData = getFilters(imdbId);
  const segment = filterData && filterData.segments.find(s => s.id === segmentId);
  if (!segment) return false;
  segment.votes = { up: 0, down: 0 };
  segment.voters = {};
  segment.verified = true;
  saveFilters(imdbId, filterData);
  return true;
}

/**
 * List titles that have segments, with the same sort options as PostgreSQL.
 */
function listTitles({ limit = 100, offset = 0, sortBy = 'recent', type } = {}) {
  let titles = [...loadIndex().values()].filter(t => approvedCount(t) > 0);
  if (type) titles = titles.filter(t => (t.type || 'movie') === type);

  const sorters = {
    popular: (a, b) => approvedCount(b) - approvedCount(a),
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
  setSegmentStatus,
  setSegmentCategory,
  setSegmentRef,
  countEpisodeSegments,
  resetVotes,
  listPending,
  getContributor,
  saveContributor,
  getImportState,
  setImportState,
  getStats,
  DATA_DIR,
};
