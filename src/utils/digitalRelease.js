/**
 * Digital release information from TMDB
 *
 * Tells whether a movie can already be streamed or rented at home ("digital"),
 * and if not, when its digital release is expected. Used for the poster tag
 * and the "New digital releases" catalog.
 *
 * TMDB release types: 1 premiere, 2 limited theatrical, 3 theatrical,
 * 4 digital, 5 physical (DVD/Blu-ray), 6 TV.
 */

const TMDB_API_KEY = process.env.TMDB_API_KEY || '998d6fef6df9a4e1c2a5ff6631ec5af9';
const REGION = (process.env.DIGITAL_RELEASE_REGION || 'US').toUpperCase();
const TIMEOUT_MS = 8000;
const CACHE_MS = 12 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Older films rarely have a digital date on TMDB but are available at home.
const ASSUME_DIGITAL_AFTER_DAYS = 180;

const cache = new Map(); // key -> { at, value }

function cached(key, compute) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = compute().catch(() => null);
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return value;
}

async function tmdb(path, params = {}) {
  if (!TMDB_API_KEY) return null;
  const query = new URLSearchParams({ api_key: TMDB_API_KEY, ...params });
  const res = await fetch(`https://api.themoviedb.org/3${path}?${query}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return null;
  return res.json();
}

/** TMDB movie id for an IMDb id, or null (TV shows return null). */
function tmdbMovieId(imdbId) {
  return cached(`find:${imdbId}`, async () => {
    const data = await tmdb(`/find/${imdbId}`, { external_source: 'imdb_id' });
    const movie = data && data.movie_results && data.movie_results[0];
    return movie ? movie.id : null;
  });
}

/** IMDb id for a TMDB movie id, or null. */
function imdbIdForTmdb(tmdbId) {
  return cached(`imdb:${tmdbId}`, async () => {
    const data = await tmdb(`/movie/${tmdbId}/external_ids`);
    return data && data.imdb_id ? data.imdb_id : null;
  });
}

/**
 * Work out the digital status from TMDB release_dates results.
 * Exported separately so it can be tested without the network.
 * @returns {{status: 'digital'|'upcoming'|'cinema'|'unknown', date: string|null}}
 */
function digitalStatusFromReleases(results, now = new Date(), region = REGION) {
  const all = [];
  for (const country of results || []) {
    for (const r of country.release_dates || []) {
      all.push({ region: country.iso_3166_1, type: r.type, date: new Date(r.release_date) });
    }
  }
  if (all.length === 0) return { status: 'unknown', date: null };

  const day = d => d.toISOString().slice(0, 10);
  const digital = all.filter(r => r.type === 4 && !isNaN(r.date));
  const local = digital.filter(r => r.region === region);
  const pool = local.length ? local : digital;

  const past = pool.filter(r => r.date <= now).sort((a, b) => a.date - b.date);
  if (past.length) return { status: 'digital', date: day(past[0].date) };

  const future = pool.filter(r => r.date > now).sort((a, b) => a.date - b.date);
  if (future.length) return { status: 'upcoming', date: day(future[0].date) };

  // No digital date at all: judge by the earliest cinema or physical release
  const releases = all.filter(r => !isNaN(r.date) && r.date <= now).sort((a, b) => a.date - b.date);
  if (releases.length === 0) return { status: 'unknown', date: null };
  const firstRelease = releases[0].date;
  if (all.some(r => r.type === 5 && r.date <= now)) return { status: 'digital', date: null };
  if (now - firstRelease > ASSUME_DIGITAL_AFTER_DAYS * DAY_MS) return { status: 'digital', date: null };
  return { status: 'cinema', date: null };
}

/**
 * Digital release status for a movie by IMDb id.
 * @returns {Promise<{status: string, date: string|null}|null>} null for TV shows or on errors
 */
function getDigitalRelease(imdbId) {
  return cached(`digital:${imdbId}`, async () => {
    const id = await tmdbMovieId(imdbId);
    if (!id) return null;
    const data = await tmdb(`/movie/${id}/release_dates`);
    return data ? digitalStatusFromReleases(data.results) : null;
  });
}

/**
 * Movies released digitally in the last `days` days, most popular first.
 * @returns {Promise<Array<{imdbId, title, year, date, overview}>>}
 */
function newDigitalReleases({ page = 1, days = 60 } = {}) {
  const today = new Date();
  const from = new Date(today - days * DAY_MS);
  const key = `new:${page}:${days}:${today.toISOString().slice(0, 10)}`;
  return cached(key, async () => {
    const data = await tmdb('/discover/movie', {
      with_release_type: '4',
      region: REGION,
      'release_date.gte': from.toISOString().slice(0, 10),
      'release_date.lte': today.toISOString().slice(0, 10),
      sort_by: 'popularity.desc',
      include_adult: 'false',
      'vote_count.gte': '20',
      page: String(page),
    });
    const movies = (data && data.results) || [];
    const withIds = await Promise.all(movies.map(async m => ({
      imdbId: await imdbIdForTmdb(m.id),
      title: m.title,
      year: m.release_date ? Number(m.release_date.slice(0, 4)) : undefined,
      overview: m.overview,
    })));
    return withIds.filter(m => m.imdbId);
  }).then(list => list || []);
}

/**
 * Short text for the poster tag, e.g. "DIGITAL", "DIGITAL 12 DEC", "IN CINEMAS".
 */
function digitalTagText(info, now = new Date()) {
  if (!info) return null;
  if (info.status === 'digital') return 'DIGITAL';
  if (info.status === 'cinema') return 'IN CINEMAS';
  if (info.status === 'upcoming' && info.date) {
    const d = new Date(info.date + 'T00:00:00Z');
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
    return `DIGITAL ${d.getUTCDate()} ${months[d.getUTCMonth()]}${sameYear ? '' : ' ' + d.getUTCFullYear()}`;
  }
  return null;
}

module.exports = { getDigitalRelease, newDigitalReleases, digitalStatusFromReleases, digitalTagText, tmdb, cached, imdbIdForTmdb };
