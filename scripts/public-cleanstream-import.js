#!/usr/bin/env node
/**
 * Import skips from another CleanStream server (by default the public one)
 * as UNCONFIRMED ("pending") skips.
 *
 * Imported skips are never applied automatically: viewers see them as a
 * "Skip ... (unconfirmed)" prompt, and each goes live only when viewers
 * confirm it or someone marks the same scene independently. Skips that
 * duplicate ones already on this server are left out.
 *
 * Usage (on the server, from /opt/cleanstream/deploy):
 *   docker compose exec cleanstream node scripts/public-cleanstream-import.js --dry-run
 *   docker compose exec cleanstream node scripts/public-cleanstream-import.js
 *
 * Options:
 *   --source=<url>   server to import from (default https://cleanstream.elfhosted.com)
 *   --dry-run        only count what would be imported; change nothing
 *   --delay=<ms>     pause between requests (default 400), to be gentle on the source
 */

const db = require('../src/database');
const trust = require('../src/community/trust');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const SOURCE = String(args.source || 'https://cleanstream.elfhosted.com').replace(/\/+$/, '');
const DRY_RUN = Boolean(args['dry-run']);
const DELAY_MS = Number(args.delay || 400);
const PAGE_SIZE = 100;
const MAX_PAGES = 200; // safety stop: 20,000 titles

const VALID_CATEGORIES = ['nudity', 'sex', 'violence', 'language', 'drugs', 'fear', 'discrimination', 'dispensable', 'commercial'];
const VALID_SEVERITIES = ['low', 'medium', 'high'];
const MAX_SEGMENT_MS = 15 * 60 * 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(path) {
  const res = await fetch(SOURCE + path, {
    headers: { Accept: 'application/json', 'User-Agent': 'CleanStream-import' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

/** All title ids on the source, read from its "All Movies" catalog page by page. */
async function listSourceTitles() {
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
    process.stdout.write(`\rTitles found: ${ids.size}`);
    if (metas.length < PAGE_SIZE || added === 0) break;
    await sleep(DELAY_MS);
  }
  process.stdout.write('\n');
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

async function main() {
  console.log(`Importing from ${SOURCE}${DRY_RUN ? ' (dry run: nothing will be saved)' : ''}`);
  await db.initialize();

  const titles = await listSourceTitles();
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
      console.warn(`\n${imdbId}: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  console.log('\n=== Import summary ===');
  console.log(`Titles checked:          ${titles.size}`);
  console.log(`Skips seen on source:    ${totals.seen}`);
  console.log(`Already on this server:  ${totals.duplicates}`);
  console.log(`Left out (bad/rejected): ${totals.skipped}`);
  console.log(`${DRY_RUN ? 'Would import' : 'Imported'} as unconfirmed: ${totals.imported} (in ${totals.titles} titles)`);
  if (totals.failed) console.log(`Titles that failed:      ${totals.failed}`);

  await db.disconnect();
}

main().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
