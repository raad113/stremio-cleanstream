/**
 * Import skip files from the VideoSkip exchange (videoskip.org) as
 * UNCONFIRMED ("pending") skips.
 *
 * VideoSkip users share .skp files freely on the exchange. This reads the
 * "recently uploaded" lists for films and episodes, and for each file not
 * imported before:
 *   1. reads its page to find the film or episode,
 *   2. reads the film/episode page for its IMDb id (episodes are mapped to
 *      series id + season + episode through TMDB, which needs TMDB_API_KEY),
 *   3. downloads the .skp file and converts its filters,
 *   4. saves skips this server does not already have, as pending.
 *
 * Requests are spaced out (default 1.5 s) to be gentle on the volunteer-run site.
 * Progress is remembered, so daily runs only fetch new uploads.
 */

const db = require('../database');
const { isDuplicate } = require('./cleanstreamServer');

const BASE = 'https://videoskip.herokuapp.com';
const STATE_KEY = 'videoskip.importedSkipIds';
const MAX_SEGMENT_MS = 15 * 60 * 1000;
const LISTS = ['recent-uploaded-movie-skips', 'recent-uploaded-episode-skips'];
const MAX_LIST_PAGES = 60;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// VideoSkip's category words -> CleanStream categories
const CATEGORY = {
  profane: 'language', profanity: 'language', pro: 'language', prof: 'language',
  sex: 'sex', sexual: 'sex', sexuality: 'sex',
  nude: 'nudity', nudity: 'nudity',
  violence: 'violence', gore: 'violence', gory: 'violence',
  frightening: 'fear', frightful: 'fear', intense: 'fear',
  hate: 'discrimination',
  alcohol: 'drugs', drugs: 'drugs',
};
// Words that mean "mute" rather than "skip"
const AUDIO_WORDS = new Set(['word', 'audio', 'aud', 'sound']);
const SEVERITY = { 1: 'low', 2: 'medium', 3: 'high' };

/**
 * Convert the text of a .skp file into CleanStream segments.
 * A filter block looks like:
 *   0:40:05.09 --> 0:40:21.62
 *   sex 2 (passionate kissing)
 * Lines without a level digit (screenshot notes such as "logo") are ignored.
 */
function parseSkp(text) {
  const segments = [];
  const lines = String(text).replace(/\r/g, '').split('\n');
  const timeRe = /^\s*(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\s*-->\s*(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?/;
  const toMs = (h, m, s, f) => ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(String(f || '0').padEnd(3, '0'));

  for (let i = 0; i < lines.length - 1; i++) {
    const t = lines[i].match(timeRe);
    if (!t) continue;
    const startMs = toMs(t[1], t[2], t[3], t[4]);
    const endMs = toMs(t[5], t[6], t[7], t[8]);
    // Some files glue the next timestamp onto the end of the label; drop it
    const label = lines[i + 1].trim().replace(/\)?\s*\d+:\d{2}:\d{2}(?:[.,]\d+)?\s*$/, m => (m.startsWith(')') ? ')' : ''));
    const m = label.match(/^([a-z]+)(?:\s+([a-z]+))?\s+([1-3])\b\s*(?:\((.*)\))?/i);
    if (!m) continue;
    const category = CATEGORY[m[1].toLowerCase()];
    if (!category) continue;
    if (endMs <= startMs || endMs - startMs > MAX_SEGMENT_MS) continue;
    const channelWord = (m[2] || '').toLowerCase();
    segments.push({
      startMs,
      endMs,
      category,
      subcategory: category,
      severity: SEVERITY[m[3]],
      channel: AUDIO_WORDS.has(channelWord) || category === 'language' ? 'audio' : 'both',
      comment: m[4] ? m[4].trim().slice(0, 200) : null,
    });
  }
  return segments;
}

async function getText(path) {
  const res = await fetch(BASE + path, {
    headers: { 'User-Agent': 'CleanStream-import' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.text();
}

/** Map an episode's own IMDb id to "seriesId:season:episode" through TMDB. */
async function episodeContentId(episodeImdbId) {
  const key = process.env.TMDB_API_KEY;
  if (!key) return null;
  const tmdb = async path => {
    const res = await fetch(`https://api.themoviedb.org/3${path}${path.includes('?') ? '&' : '?'}api_key=${key}`,
      { signal: AbortSignal.timeout(15000) });
    return res.ok ? res.json() : null;
  };
  const found = await tmdb(`/find/${episodeImdbId}?external_source=imdb_id`);
  const ep = found && found.tv_episode_results && found.tv_episode_results[0];
  if (!ep) return null;
  const ids = await tmdb(`/tv/${ep.show_id}/external_ids`);
  if (!ids || !ids.imdb_id) return null;
  return `${ids.imdb_id}:${ep.season_number}:${ep.episode_number}`;
}

/**
 * @returns {Promise<object>} totals
 */
async function importFromVideoSkip({ dryRun = false, delayMs = 1500, maxPages = MAX_LIST_PAGES, log = console.log } = {}) {
  log(`Importing from the VideoSkip exchange${dryRun ? ' (dry run: nothing will be saved)' : ''}`);
  const imported = new Set((await db.getImportState(STATE_KEY)) || []);
  const totals = { files: 0, newFiles: 0, segments: 0, imported: 0, duplicates: 0, unmatched: 0, failed: 0 };

  // 1. Collect skip file ids from the "recently uploaded" lists (newest first)
  const toProcess = [];
  for (const list of LISTS) {
    for (let page = 1; page <= maxPages; page++) {
      const html = await getText(`/exchange/${list}/${page > 1 ? `?page=${page}` : ''}`);
      const ids = [...new Set([...html.matchAll(/\/exchange\/skip\/(\d+)\//g)].map(m => Number(m[1])))];
      totals.files += ids.length;
      const fresh = ids.filter(id => !imported.has(id));
      toProcess.push(...fresh);
      await sleep(delayMs);
      // Stop when a page has nothing new (later pages are older) or there are no more pages
      const hasNext = html.includes(`?page=${page + 1}`);
      if (fresh.length === 0 || !hasNext) break;
    }
  }
  const unique = [...new Set(toProcess)];
  totals.newFiles = unique.length;
  log(`New skip files to check: ${unique.length}`);

  // 2. Process each new file
  for (const skipId of unique) {
    try {
      const skipPage = await getText(`/exchange/skip/${skipId}/`);
      await sleep(delayMs);
      const videoId = (skipPage.match(/\/exchange\/videos\/(\d+)\//) || [])[1];
      if (!videoId) throw new Error('no film or episode link');

      const videoPage = await getText(`/exchange/videos/${videoId}/`);
      await sleep(delayMs);
      const imdbId = (videoPage.match(/imdb\.com\/title\/(tt\d+)/) || [])[1];
      const titleText = ((videoPage.match(/<title>([^<]*)<\/title>/) || [])[1] || '').replace(/^VideoSkip:\s*/, '');
      const isEpisode = /\bS\d+\s*E\d+\b/.test(videoPage);
      const contentId = !imdbId ? null : isEpisode ? await episodeContentId(imdbId) : imdbId;
      if (!contentId) {
        totals.unmatched++;
        if (!dryRun) imported.add(skipId);
        continue;
      }

      const skp = await getText(`/exchange/skip/${skipId}/download/`);
      await sleep(delayMs);
      const segments = parseSkp(skp);
      totals.segments += segments.length;

      const current = await db.getFilters(contentId);
      const existing = current ? [...current.segments] : [];
      for (const seg of segments) {
        if (isDuplicate(seg, existing)) { totals.duplicates++; continue; }
        if (!dryRun) {
          await db.addSegment(contentId, {
            ...seg,
            status: 'pending',
            contributor: 'videoskip',
            contributorHash: null, // an independent source, like the bundled VideoSkip data
            titleName: titleText || undefined,
            type: isEpisode ? 'episode' : 'movie',
          });
        }
        existing.push(seg);
        totals.imported++;
      }
      if (!dryRun) {
        imported.add(skipId);
        await db.setImportState(STATE_KEY, [...imported]);
      }
    } catch (err) {
      totals.failed++;
      log(`VideoSkip file ${skipId}: ${err.message}`);
    }
  }

  log('=== VideoSkip import summary ===');
  log(`Skip files listed:       ${totals.files}`);
  log(`New files checked:       ${totals.newFiles}`);
  log(`Not matched to a title:  ${totals.unmatched}${process.env.TMDB_API_KEY ? '' : ' (set TMDB_API_KEY to match episodes)'}`);
  log(`Skips found in files:    ${totals.segments}`);
  log(`Already on this server:  ${totals.duplicates}`);
  log(`${dryRun ? 'Would import' : 'Imported'} as unconfirmed: ${totals.imported}`);
  if (totals.failed) log(`Files that failed:       ${totals.failed}`);
  return totals;
}

module.exports = { importFromVideoSkip, parseSkp, CATEGORY };
