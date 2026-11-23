/**
 * Stremio Catalog Handler
 * "CleanStream" rows for movies and TV shows that have skip data.
 * Every poster carries a CleanStream badge (see src/utils/posterBadge.js).
 */

const db = require('../database');

const BASE_URL = () => process.env.CLEANSTREAM_BASE_URL || `http://localhost:${process.env.PORT || 7000}`;
const PAGE_SIZE = 100;

/**
 * URL of the badged poster served by this addon.
 */
function posterUrl(imdbId, detail, title) {
  const params = new URLSearchParams({ d: detail });
  if (title) params.set('t', title);
  return `${BASE_URL()}/poster/${imdbId}.jpg?${params}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function movieMeta(title) {
  const count = title.segmentCount || 0;
  return {
    id: title.imdbId,
    type: 'movie',
    name: title.title || title.imdbId,
    poster: posterUrl(title.imdbId, plural(count, 'skip'), title.title),
    posterShape: 'poster',
    description: `CleanStream: ${plural(count, 'skip segment')} available`,
    year: title.year,
    releaseInfo: title.year ? String(title.year) : undefined,
  };
}

/**
 * Group episode entries (tt123:1:2) into one entry per show.
 */
async function listShows() {
  const episodes = await db.listTitles({ limit: 5000, type: 'episode', sortBy: 'recent' });
  const shows = new Map();
  for (const ep of episodes) {
    const showId = ep.imdbId.split(':')[0];
    const show = shows.get(showId) || { imdbId: showId, title: null, episodes: 0, skips: 0 };
    show.episodes += 1;
    show.skips += ep.segmentCount || 0;
    // Episode titles are often "Show - S1E2"; keep the part before the dash
    if (!show.title && ep.title) show.title = ep.title.split(/\s+[-–|]\s+/)[0];
    shows.set(showId, show);
  }
  return [...shows.values()];
}

function showMeta(show) {
  return {
    id: show.imdbId,
    type: 'series',
    name: show.title || show.imdbId,
    poster: posterUrl(show.imdbId, `${plural(show.episodes, 'episode')} ready`, show.title),
    posterShape: 'poster',
    description: `CleanStream: skips for ${plural(show.episodes, 'episode')} (${plural(show.skips, 'skip')})`,
  };
}

/**
 * Handle catalog requests from Stremio
 * @param {object} args - { type, id, extra }
 */
async function catalogHandler({ type, id, extra }) {
  const skip = extra?.skip ? parseInt(extra.skip, 10) || 0 : 0;
  const search = extra?.search;

  try {
    if (type === 'series') {
      let shows = await listShows();
      if (search) {
        const q = search.toLowerCase();
        shows = shows.filter(s => String(s.title || s.imdbId).toLowerCase().includes(q));
      }
      return { metas: shows.slice(skip, skip + PAGE_SIZE).map(showMeta), cacheMaxAge: 600 };
    }

    if (type !== 'movie') return { metas: [] };

    const sortBy = { 'cleanstream-popular': 'popular', 'cleanstream-year': 'year', 'cleanstream-all': 'title', 'cleanstream-movies': 'title' }[id] || 'recent';

    const titles = search
      ? (await db.searchTitles(search)).filter(t => !t.type || t.type === 'movie')
      : await db.listTitles({ limit: PAGE_SIZE, offset: skip, hasSegments: true, sortBy, type: 'movie' });

    return { metas: titles.map(movieMeta), cacheMaxAge: 600 };
  } catch (error) {
    console.error('[CleanStream] Catalog error:', error);
    return { metas: [] };
  }
}

module.exports = { catalogHandler, posterUrl };
