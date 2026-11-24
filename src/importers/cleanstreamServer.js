/**
 * Import skips from another CleanStream server (by default the public one)
 * as UNCONFIRMED ("pending") skips. Used by scripts/public-cleanstream-import.js
 * and by the weekly automatic import.
 */

const db = require('../database');
const trust = require('../community/trust');

const DEFAULT_SOURCE = 'https://cleanstream.elfhosted.com';
const PAGE_SIZE = 100;
const MAX_PAGES = 200; // safety stop: 20,000 titles

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'CleanStream-import' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

const VALID_CATEGORIES = ['nudity', 'sex', 'violence', 'language', 'drugs', 'fear', 'discrimination', 'dispensable', 'commercial'];
const VALID_SEVERITIES = ['low', 'medium', 'high'];
const MAX_SEGMENT_MS = 15 * 60 * 1000;

/** All title ids on the source, read from its "All Movies" catalog page by page. */
async function listSourceTitles(getJson, DELAY_MS) {
  const ids = new Map();
  for (let page = 0; page < MAX_PAGES; page++) {
    const skip = page * PAGE_SIZE;
    const path = skip ? `/catalog/movie/cleanstream-all/skip=${skip}.json` : '/catalog/movie/cleanstream-all.json';
    const data = await getJson(path);
    const metas = (data && data.metas) || [];
    let added = 0;
    for (const m of metas) {
      if (m && /^tt\d+$/.test(m.id) && !ids.has(m.id)) { ids.set(m.id, m.name); added++; }
    }
    if (process.stdout.isTTY) process.stdout.write(`\rTitles found: ${ids.size}`);
    if (metas.length < PAGE_SIZE || added === 0) break;
    await sleep(DELAY_MS);
  }
  if (process.stdout.isTTY) process.stdout.write('\n');
  return ids;
}

/** Keep only well-formed segments that the source community has not voted down. */
function usable(seg) {
  const start = Number(seg.startMs);
  const end = Number(seg.endMs);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return false;
  if (end - start > MAX_SEGMENT_MS) return false;
  if (!VALID_CATEGORIES.includes(seg.category) || !VALID_SEVERITIES.includes(seg.severity)) return false;
  const votes = seg.votes || {};
  if ((votes.down || 0) - (votes.up || 0) >= trust.RULES.REJECT_NET_VOTES) return false;
  return true;
}

/** True when this server already has (nearly) the same skip for the title. */
function isDuplicate(seg, existing) {
  return existing.some(e =>
    e.category === seg.category && trust.overlapShare(e, seg) >= trust.RULES.CORROBORATE_OVERLAP);
}

/**
 * Import skips from another CleanStream server as unconfirmed.
 * @returns {Promise<object>} totals
 */
async function importFromCleanStream({ source = DEFAULT_SOURCE, dryRun = false, delayMs = 400, log = console.log } = {}) {
  const SOURCE = String(source).replace(/\/+$/, '');
  const DRY_RUN = dryRun;
  const DELAY_MS = delayMs;
  const getJson = path => fetchJson(SOURCE + path);
  log(`Importing from ${SOURCE}${DRY_RUN ? ' (dry run: nothing will be saved)' : ''}`);
  const titles = await listSourceTitles(getJson, DELAY_MS);
  const totals = { titles: 0, seen: 0, imported: 0, duplicates: 0, skipped: 0, failed: 0 };

  for (const [imdbId, name] of titles) {
    try {
      const data = await getJson(`/api/filters/${imdbId}`);
      const segments = (data && data.segments) || [];
      const current = await db.getFilters(imdbId);
      const existing = current ? [...current.segments] : [];
      let importedHere = 0;

      for (const seg of segments) {
        totals.seen++;
        if (!usable(seg)) { totals.skipped++; continue; }
        const candidate = {
          startMs: Number(seg.startMs),
          endMs: Number(seg.endMs),
          category: seg.category,
          subcategory: seg.subcategory || seg.category,
          severity: seg.severity,
          channel: ['both', 'video', 'audio'].includes(seg.channel) ? seg.channel : 'both',
          comment: typeof seg.comment === 'string' ? seg.comment.slice(0, 200) : null,
        };
        if (isDuplicate(candidate, existing)) { totals.duplicates++; continue; }

        if (!DRY_RUN) {
          await db.addSegment(imdbId, {
            ...candidate,
            status: 'pending',
            contributor: 'public-cleanstream',
            contributorHash: null, // counts as an independent source when viewers mark the same scene
            titleName: data.title || name,
            year: data.year || undefined,
          });
        }
        existing.push(candidate);
        importedHere++;
        totals.imported++;
      }
      if (importedHere) totals.titles++;
    } catch (err) {
      totals.failed++;
      log(`${imdbId}: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  log('=== Import summary ===');
  log(`Titles checked:          ${titles.size}`);
  log(`Skips seen on source:    ${totals.seen}`);
  log(`Already on this server:  ${totals.duplicates}`);
  log(`Left out (bad/rejected): ${totals.skipped}`);
  log(`${DRY_RUN ? 'Would import' : 'Imported'} as unconfirmed: ${totals.imported} (in ${totals.titles} titles)`);
  if (totals.failed) log(`Titles that failed:      ${totals.failed}`);
  return totals;
}


module.exports = { importFromCleanStream, isDuplicate, DEFAULT_SOURCE };
