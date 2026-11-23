/**
 * TMDB-based rows ("CleanStream Discover")
 *
 * Ready-made rows modelled on the TMDB searches in the B.E.S.T. collection,
 * plus streaming-service and family rows. The CleanStream add-on serves them
 * itself, so every movie poster carries the digital release tag and, when
 * skips exist, the CleanStream band. Each row is chosen with the catalog's
 * "genre" option, which is how Nuvio collections pick a row from an add-on.
 */

const { tmdb, cached, imdbIdForTmdb } = require('./digitalRelease');

const REGION = (process.env.DIGITAL_RELEASE_REGION || 'US').toUpperCase();
const today = () => new Date().toISOString().slice(0, 10);

// Streaming services: TMDB watch provider ids (US)
const PROVIDERS = {
  Netflix: '8',
  'Prime Video': '9',
  'Disney+': '337',
  'Apple TV+': '350',
  'Paramount+': '2303|2616',
  'HBO Max': '1899',
  Starz: '43',
};

const released = () => ({ 'release_date.lte': today(), with_release_type: '4|5|6' });
const decade = start => ({
  ...released(),
  'primary_release_date.gte': `${start}-01-01`,
  'primary_release_date.lte': `${start + 9}-12-31`,
  'vote_count.gte': '50',
});

const MOVIE_PRESETS = {
  Popular: { ...released(), 'vote_count.gte': '50' },
  Trending: { trending: true },
  'Top Rated': { sort_by: 'vote_average.desc', 'vote_count.gte': '8000' },
  'Sci-Fi & Fantasy': { ...released(), with_genres: '878|14', without_genres: '16', with_original_language: 'en', 'vote_average.gte': '5.1', 'vote_count.gte': '10' },
  Family: { ...released(), with_genres: '10751', 'vote_count.gte': '100' },
  Animation: { ...released(), with_genres: '16', 'vote_count.gte': '100' },
  'Studio Ghibli': { with_companies: '10342', sort_by: 'primary_release_date.desc' },
  Documentaries: { ...released(), with_genres: '99', 'vote_count.gte': '50' },
  '2020s': decade(2020),
  '2010s': decade(2010),
  '2000s': decade(2000),
  '1990s': decade(1990),
  '1980s': decade(1980),
};

const SERIES_PRESETS = {
  Popular: { 'vote_count.gte': '50' },
  Trending: { trending: true },
  'Top Rated': { sort_by: 'vote_average.desc', 'vote_count.gte': '1000' },
  'Sci-Fi & Fantasy': { with_genres: '10765', without_genres: '16|10762', with_original_language: 'en', 'vote_average.gte': '5.1', 'vote_count.gte': '10' },
  'UK Drama': { with_genres: '18|9648|80', without_genres: '16|10767|10766|10764|10763|10762|35', with_origin_country: 'GB', 'vote_count.gte': '35' },
  'Best of British': { without_genres: '16|10762|10766|10764|10767', with_origin_country: 'GB', with_original_language: 'en', 'vote_average.gte': '7.5', 'vote_count.gte': '50' },
  Kids: { with_genres: '10762', 'vote_count.gte': '20' },
  Documentaries: { with_genres: '99', 'vote_count.gte': '20' },
};

for (const [name, ids] of Object.entries(PROVIDERS)) {
  const provider = { with_watch_providers: ids, watch_region: REGION, with_watch_monetization_types: 'flatrate' };
  MOVIE_PRESETS[name] = { ...provider, 'vote_count.gte': '20' };
  SERIES_PRESETS[name] = { ...provider, 'vote_count.gte': '10' };
}

function presetsFor(type) {
  return type === 'series' ? SERIES_PRESETS : MOVIE_PRESETS;
}

/** Row names, used as the catalog's genre options. */
function presetNames(type) {
  return Object.keys(presetsFor(type));
}

function imdbIdForTv(tmdbId) {
  return cached(`imdbtv:${tmdbId}`, async () => {
    const data = await tmdb(`/tv/${tmdbId}/external_ids`);
    return data && data.imdb_id ? data.imdb_id : null;
  });
}

/**
 * One page (20 titles) of a row.
 * @returns {Promise<Array<{imdbId, title, year, overview}>>}
 */
function discover(type, presetName, page = 1) {
  const preset = presetsFor(type)[presetName];
  if (!preset) return Promise.resolve([]);
  const mediaType = type === 'series' ? 'tv' : 'movie';
  const key = `discover:${mediaType}:${presetName}:${page}:${today()}`;

  return cached(key, async () => {
    let data;
    if (preset.trending) {
      data = await tmdb(`/trending/${mediaType}/week`, { page: String(page) });
    } else {
      const { trending, ...params } = preset;
      // Presets are built once at start-up; keep "released up to today" current
      if (params['release_date.lte']) params['release_date.lte'] = today();
      data = await tmdb(`/discover/${mediaType}`, {
        sort_by: 'popularity.desc',
        include_adult: 'false',
        page: String(page),
        ...params,
      });
    }
    const results = (data && data.results) || [];
    const items = await Promise.all(results.map(async r => ({
      imdbId: await (mediaType === 'tv' ? imdbIdForTv(r.id) : imdbIdForTmdb(r.id)),
      title: r.title || r.name,
      year: Number((r.release_date || r.first_air_date || '').slice(0, 4)) || undefined,
      overview: r.overview,
    })));
    return items.filter(i => i.imdbId);
  }).then(list => list || []);
}

module.exports = { discover, presetNames, PROVIDERS };
