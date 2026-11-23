/**
 * Poster badges
 *
 * Builds a poster image with a "CleanStream" band at the bottom, so titles
 * that have skip data are easy to spot in any Stremio-compatible app
 * (Stremio, Nuvio, Android TV). The image is a normal JPEG, so no app
 * support is needed.
 *
 * Poster sources, tried in order:
 *   1. POSTER_SOURCE_TEMPLATE, e.g. "https://my-cdn/posters/{imdbId}.jpg"
 *   2. TMDB (TMDB_API_KEY)
 *   3. Stremio's public poster service (images.metahub.space)
 * If none respond, a plain poster with the title is drawn instead.
 */

const sharp = require('sharp');

const WIDTH = 500;
const HEIGHT = 750;
const FETCH_TIMEOUT_MS = 8000;
const CACHE_LIMIT = 500;

const TMDB_API_KEY = process.env.TMDB_API_KEY || '998d6fef6df9a4e1c2a5ff6631ec5af9';

// Small in-memory cache: key -> JPEG buffer (oldest entries are dropped first)
const cache = new Map();

function remember(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return value;
}

function escapeXml(text) {
  return String(text).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

async function fetchBuffer(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function tmdbPosterUrl(imdbId) {
  if (!TMDB_API_KEY) return null;
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    );
    const data = await res.json();
    const hit = (data.movie_results || [])[0] || (data.tv_results || [])[0];
    return hit && hit.poster_path ? `https://image.tmdb.org/t/p/w500${hit.poster_path}` : null;
  } catch (e) {
    return null;
  }
}

/**
 * Download the original poster for a title, or null if no source works.
 */
async function fetchBasePoster(imdbId) {
  const template = process.env.POSTER_SOURCE_TEMPLATE;
  if (template) {
    const buf = await fetchBuffer(template.replace('{imdbId}', imdbId));
    if (buf) return buf;
  }
  const tmdb = await tmdbPosterUrl(imdbId);
  if (tmdb) {
    const buf = await fetchBuffer(tmdb);
    if (buf) return buf;
  }
  return fetchBuffer(`https://images.metahub.space/poster/medium/${imdbId}/img`);
}

/**
 * Plain fallback poster with the title in the middle.
 */
function placeholderSvg(title) {
  const words = String(title || 'CleanStream').split(/\s+/);
  const lines = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && (last + ' ' + w).length <= 16) lines[lines.length - 1] = last + ' ' + w;
    else lines.push(w);
  }
  const shown = lines.slice(0, 5);
  const startY = HEIGHT / 2 - (shown.length - 1) * 26;
  const text = shown
    .map((l, i) => `<text x="250" y="${startY + i * 52}" text-anchor="middle">${escapeXml(l)}</text>`)
    .join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1a1a2e"/><stop offset="1" stop-color="#16213e"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <g font-family="DejaVu Sans, Inter, Arial, sans-serif" font-weight="700" font-size="44" fill="#e6f1ff">${text}</g>
  </svg>`);
}

/**
 * The badge drawn over the bottom of the poster.
 * @param {string} detail - second line, e.g. "12 skips"
 */
function badgeSvg(detail) {
  const band = 118;
  const top = HEIGHT - band;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.55"/></linearGradient></defs>
    <rect x="0" y="${top - 70}" width="${WIDTH}" height="70" fill="url(#fade)"/>
    <rect x="0" y="${top}" width="${WIDTH}" height="${band}" fill="#0b7a63" fill-opacity="0.94"/>
    <rect x="0" y="${top}" width="${WIDTH}" height="5" fill="#64ffda"/>
    <circle cx="62" cy="${top + band / 2 + 2}" r="34" fill="#64ffda"/>
    <path d="M45 ${top + band / 2 + 3} l12 12 l23 -25" fill="none" stroke="#0b3d33"
      stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
    <g font-family="DejaVu Sans, Inter, Arial, sans-serif" fill="#ffffff">
      <text x="114" y="${top + 58}" font-size="44" font-weight="700">CleanStream</text>
      <text x="116" y="${top + 96}" font-size="27" fill="#d7fff4">${escapeXml(detail)}</text>
    </g>
  </svg>`);
}

/**
 * Return a JPEG poster with the CleanStream badge.
 * @param {string} imdbId - tt1234567
 * @param {object} options - { detail: second badge line, title: fallback title }
 */
async function getBadgedPoster(imdbId, { detail = 'Family-friendly skips', title } = {}) {
  const key = `${imdbId}|${detail}`;
  if (cache.has(key)) return cache.get(key);

  const base = await fetchBasePoster(imdbId);
  let image = base
    ? sharp(base).resize(WIDTH, HEIGHT, { fit: 'cover' })
    : sharp(placeholderSvg(title || imdbId));

  // A failed or unreadable download falls back to the placeholder
  let baseJpeg;
  try {
    baseJpeg = await image.jpeg().toBuffer();
  } catch (e) {
    baseJpeg = await sharp(placeholderSvg(title || imdbId)).jpeg().toBuffer();
  }

  const output = await sharp(baseJpeg)
    .composite([{ input: badgeSvg(detail), top: 0, left: 0 }])
    .jpeg({ quality: 84, mozjpeg: true })
    .toBuffer();

  // Do not keep placeholder posters for long: the real poster may load next time
  return base ? remember(key, output) : output;
}

module.exports = { getBadgedPoster, badgeSvg };
