/**
 * Ready-made Nuvio collection: "CleanStream Collection"
 *
 * Modelled on the B.E.S.T. community collection (AIOMetadata catalogs),
 * reorganised for families:
 *  - TMDB-based rows come from this add-on's "CleanStream Discover" catalog,
 *    so their posters carry the digital release tag and the CleanStream band.
 *  - Curated lists (franchises, directors, documentaries, ...) are the same
 *    public Trakt lists B.E.S.T. uses, read directly by Nuvio.
 *  - Left out: the adult "Mega Erotic" list, and MDBList/TVDB rows, which Nuvio
 *    cannot read without AIOMetadata (replaced by equivalent TMDB rows).
 *
 * Import in Nuvio: Settings > Collections > Import > URL > <server>/collection.json
 */

const ADDON_ID = 'community.cleanstream';

const addon = (type, catalogId, genre) => ({
  provider: 'addon',
  addonId: ADDON_ID,
  type,
  catalogId,
  ...(genre ? { genre } : {}),
});

const discoverMovie = genre => addon('movie', 'cleanstream-discover', genre);
const discoverSeries = genre => addon('series', 'cleanstream-discover', genre);

/** A public Trakt list. sortBy "released" keeps franchises in order; "rank" keeps rankings. */
const trakt = (traktListId, title, { tv = false, sortBy = 'released' } = {}) => ({
  provider: 'trakt',
  traktListId,
  title,
  mediaType: tv ? 'TV' : 'MOVIE',
  sortBy,
  sortHow: 'asc',
});
const ranked = (id, title, opts = {}) => trakt(id, title, { ...opts, sortBy: 'rank' });

const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const folder = (title, emoji, sources) => ({
  id: `cs-${slug(title)}`,
  title,
  coverEmoji: emoji,
  tileShape: 'SQUARE',
  hideTitle: false,
  sources,
});

const collection = (title, folders, { pinToTop = false } = {}) => ({
  id: `cleanstream-${slug(title)}`,
  title,
  pinToTop,
  viewMode: 'TABBED_GRID',
  showAllTab: true,
  // Folder ids must be unique across collections ("Popular" exists in Movies and TV Shows)
  folders: folders.map(f => ({ ...f, id: `cs-${slug(title)}-${f.id.slice(3)}` })),
});

function buildCollection() {
  return [
    collection('CleanStream', [
      folder('CleanStream Ready', '🛡️', [addon('movie', 'cleanstream-popular')]),
      folder('Recently Added Skips', '🆕', [addon('movie', 'cleanstream-recent')]),
      folder('TV Shows with Skips', '📺', [addon('series', 'cleanstream-series')]),
      folder('New Digital Releases', '💿', [addon('movie', 'cleanstream-digital')]),
    ], { pinToTop: true }),

    collection('Movies', [
      folder('Popular', '🔥', [discoverMovie('Popular')]),
      folder('Trending', '📈', [discoverMovie('Trending')]),
      folder('Top Rated', '⭐', [discoverMovie('Top Rated')]),
      folder('Family', '👨‍👩‍👧', [discoverMovie('Family')]),
      folder('Animation', '🎨', [discoverMovie('Animation')]),
      folder('Sci-Fi & Fantasy', '🚀', [discoverMovie('Sci-Fi & Fantasy')]),
      folder('Documentaries', '🎞️', [discoverMovie('Documentaries')]),
      folder('IMDb Top Rated', '🏆', [ranked(2142753, 'IMDB: Top Rated Movies')]),
      folder('1001 Greatest Movies', '🎖️', [ranked(1282987, '1001 Greatest Movies of All Time')]),
    ]),

    collection('TV Shows', [
      folder('Popular', '🔥', [discoverSeries('Popular')]),
      folder('Trending', '📈', [discoverSeries('Trending')]),
      folder('Top Rated', '⭐', [discoverSeries('Top Rated')]),
      folder('Kids', '🧒', [discoverSeries('Kids')]),
      folder('Sci-Fi & Fantasy', '🚀', [discoverSeries('Sci-Fi & Fantasy')]),
      folder('UK Drama', '🇬🇧', [discoverSeries('UK Drama')]),
      folder('Best of British', '☕', [discoverSeries('Best of British')]),
      folder('Documentaries', '🎞️', [discoverSeries('Documentaries')]),
      folder('IMDb Top Rated', '🏆', [ranked(2143363, 'IMDB: Top Rated TV Shows', { tv: true })]),
      folder('British Comedy', '😂', [ranked(9659389, 'The best of... British Comedy TV Shows', { tv: true })]),
    ]),

    collection('Decades', ['2020s', '2010s', '2000s', '1990s', '1980s'].map(d =>
      folder(d, '📅', [discoverMovie(d)]))),

    collection('Streaming', [
      ['Netflix', '🟥'], ['Prime Video', '🔷'], ['Disney+', '🏰'], ['Apple TV+', '🍎'],
      ['Paramount+', '⛰️'], ['HBO Max', '🟪'], ['Starz', '⭐'],
    ].map(([name, emoji]) => folder(name, emoji, [discoverMovie(name), discoverSeries(name)]))),

    collection('Family & Animation', [
      folder('Pixar', '💡', [trakt(801240, 'Pixar Feature Films')]),
      folder('Pixar Shorts', '🎬', [trakt(2749609, 'Pixar Short Films')]),
      folder('Disney', '🏰', [trakt(22888726, 'Disney Films')]),
      folder('DreamWorks', '🌙', [trakt(801242, 'DreamWorks')]),
      folder('Studio Ghibli', '🌳', [discoverMovie('Studio Ghibli')]),
      folder('Kids & Family Top 100', '🧸', [ranked(20580022, 'Rotten Tomatoes: Top 100 Kids & Family Movies')]),
      folder('Family Animation', '🎨', [ranked(24484523, "IMDb's Popular Family Animation")]),
      folder('Top Animation', '🏆', [ranked(22847039, "IMDb's Top Animation Movies")]),
      folder('Julia Donaldson', '📚', [trakt(21779826, 'Julia Donaldson Collection', { tv: true })]),
    ]),

    collection('Franchises', [
      folder('Star Wars', '⚔️', [trakt(22202556, 'Star Wars Movies'), trakt(22757470, 'Star Wars Shows & Series', { tv: true })]),
      folder('Marvel', '🦸', [trakt(22881797, 'Marvel Cinematic Universe - Movies (Release Order)')]),
      folder('DC', '🦇', [trakt(9429560, 'DC Universe Movies')]),
      folder('Wizarding World', '🪄', [trakt(21869828, 'Wizarding World')]),
      folder('Middle-earth', '💍', [trakt(1642688, 'Middle-Earth')]),
      folder('Jurassic Park', '🦖', [trakt(11332030, 'Jurassic Park')]),
      folder('Indiana Jones', '🤠', [trakt(11723506, 'Indiana Jones')]),
      folder('James Bond', '🍸', [trakt(802940, 'James Bond')]),
      folder('Men in Black', '🕶️', [trakt(21273394, 'Men in Black')]),
      folder('The Hunger Games', '🏹', [trakt(21226800, 'Hunger Games')]),
      folder('The Matrix', '💊', [trakt(11723357, 'The Matrix')]),
      folder('Planet of the Apes', '🦍', [trakt(11723368, 'The Planet of the Apes (Reboot)')]),
      folder('Rocky', '🥊', [trakt(11723321, 'The Rocky Series')]),
      folder('Battlestar Galactica', '🛸', [trakt(33752958, 'Battlestar Galactica', { tv: true })]),
      folder('Monty Python', '🐇', [trakt(22236190, 'Monty Python')]),
    ]),

    collection('Documentaries & Nature', [
      folder('David Attenborough', '🦁', [trakt(6652017, 'Attenborough Documentaries')]),
      folder('BBC Earth', '🌍', [trakt(23440324, 'BBC Earth - Life on our Planet')]),
      folder('Nature', '🌿', [ranked(26957348, 'IMDB: Popular Nature Documentaries')]),
      folder('Brian Cox', '🔭', [trakt(33762909, 'Professor Brian Cox')]),
      folder('Space', '🪐', [ranked(3813071, 'Astronomy and Cosmology')]),
      folder('Best Documentaries', '🏆', [ranked(10235726, 'Rotten Tomatoes’ 100 Best Documentaries')]),
      folder('Documentaries of the Decade', '🎞️', [ranked(801580, 'Top 50 Documentaries of the Decade')]),
    ]),

    collection('Directors', [
      [6241187, 'Steven Spielberg'], [6242091, 'Christopher Nolan'], [6252088, 'James Cameron'],
      [6241276, 'Ron Howard'], [6241270, 'Tim Burton'], [6241250, 'Ridley Scott'],
      [6252074, 'Wes Anderson'], [6241387, 'M. Night Shyamalan'], [6241345, 'Danny Boyle'],
      [6241522, 'Coen Brothers'], [6241405, 'Stanley Kubrick'], [24183553, 'Martin Scorsese'],
      [6241367, 'Oliver Stone'], [6241445, 'Quentin Tarantino'],
    ].map(([id, name]) => folder(name, '🎬', [trakt(id, `Director: ${name}`)]))),

    collection('Genres', [
      folder('Action', '💥', [ranked(4973644, '100 Best Action Movies')]),
      folder('Comedy', '😂', [ranked(5040627, 'Time Out 100 Best Comedy Movies')]),
      folder('Fantasy', '🐉', [ranked(22847198, "IMDb's Top Fantasy Movies")]),
      folder('Sci-Fi', '👽', [ranked(797798, '100 Greatest Sci-Fi Movies')]),
      folder('Mystery', '🔍', [ranked(19594387, 'Murder Mystery Movies')]),
      folder('Thrillers', '🔪', [ranked(22803128, 'BFI 100 Best Thrillers')]),
      folder('Romance', '💕', [ranked(20701912, 'Rotten Tomatoes Top 100 Romance Movies')]),
      folder('Musicals', '🎵', [ranked(4974101, '100 Best Musicals'), ranked(2619099, 'Popular Musicals')]),
      folder('Westerns', '🌵', [ranked(22847467, "IMDb's Top Western Movies"), ranked(21899611, 'Spaghetti Westerns')]),
      folder('War', '🎖️', [ranked(4433767, 'Ranker: The Best War Movies Ever Made')]),
      folder('Martial Arts', '🥋', [ranked(21840363, 'Martial Arts - The Top 250'), trakt(4467615, 'Bruce Lee'), trakt(11632332, 'Jackie Chan')]),
      folder('Courtroom', '⚖️', [ranked(21715794, 'Courtroom Dramas')]),
      folder('Period Drama', '👒', [ranked(22957181, 'Period Drama Movies')]),
      folder('British Crime', '🕵️', [ranked(1076151, 'British Crime & Drama')]),
      folder('Horror', '👻', [ranked(4203408, 'Rotten Tomatoes: Best Horror Movies Of All Time')]),
      folder('Anime', '🍥', [ranked(23438792, 'The 100 Best Anime Movies of All Time'), ranked(5707382, '100 Animes To Watch Before You Die', { tv: true })]),
    ]),
  ];
}

module.exports = { buildCollection, ADDON_ID };
