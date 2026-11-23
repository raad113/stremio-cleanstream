/**
 * Core tests: filter levels, community voting rules, input validation and
 * JSON storage. Run with: npm test
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Use a throwaway data folder so tests never touch the bundled data
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanstream-test-'));
process.env.CLEANSTREAM_DATA_DIR = tmp;
delete process.env.DATABASE_URL;

const { meetsFilterLevel, isDisputed, generateSkips } = require('../src/utils/skipGenerator');
const { validateSegment, parseConfig } = require('../src/api/routes');
const jsonDb = require('../src/database/jsonStorage');

test('"high" is the strictest filter level', () => {
  assert.strictEqual(meetsFilterLevel('low', 'high'), true);
  assert.strictEqual(meetsFilterLevel('medium', 'high'), true);
  assert.strictEqual(meetsFilterLevel('low', 'medium'), false);
  assert.strictEqual(meetsFilterLevel('medium', 'medium'), true);
  assert.strictEqual(meetsFilterLevel('medium', 'low'), false);
  assert.strictEqual(meetsFilterLevel('high', 'low'), true);
  assert.strictEqual(meetsFilterLevel('high', 'off'), false);
});

test('segments with 3+ net downvotes are disputed', () => {
  assert.strictEqual(isDisputed({ votes: { up: 1, down: 3 } }), false);
  assert.strictEqual(isDisputed({ votes: { up: 1, down: 4 } }), true);
  assert.strictEqual(isDisputed({}), false);
});

test('content ids are validated (no path traversal)', () => {
  assert.ok(jsonDb.isValidContentId('tt0120338'));
  assert.ok(jsonDb.isValidContentId('tt0944947:1:2'));
  assert.ok(!jsonDb.isValidContentId('../../etc/passwd'));
  assert.ok(!jsonDb.isValidContentId('tt123/../x'));
  assert.strictEqual(jsonDb.getFilters('../secret'), null);
});

test('contributed segments are validated', () => {
  const ok = validateSegment({ startMs: 0, endMs: 5000, category: 'violence', severity: 'high' });
  assert.ok(ok.segment, 'a segment starting at 0 ms is valid');
  assert.ok(validateSegment({ startMs: 5000, endMs: 1000, category: 'violence', severity: 'high' }).error);
  assert.ok(validateSegment({ startMs: 0, endMs: 5000, category: 'bogus', severity: 'high' }).error);
  assert.ok(validateSegment({ startMs: 0, endMs: 3 * 60 * 60 * 1000, category: 'sex', severity: 'low' }).error);
  assert.strictEqual(validateSegment({ startMs: 0, endMs: 1, category: 'sex', severity: 'low', comment: 'x'.repeat(500) }).segment.comment.length, 200);
});

test('config can come from JSON or single query params', () => {
  assert.strictEqual(parseConfig({ config: '{"fear":"high"}' }).fear, 'high');
  assert.strictEqual(parseConfig({ language: 'medium' }).language, 'medium');
  assert.strictEqual(parseConfig({}).violence, 'medium');
});

test('JSON storage: add, vote once, change vote, and hide disputed', async () => {
  const id = 'tt0944947:1:2';
  const seg = jsonDb.addSegment(id, { startMs: 1000, endMs: 4000, category: 'violence', severity: 'high', channel: 'both' });
  assert.ok(fs.existsSync(path.join(tmp, 'tt0944947_1_2.json')), 'episode file name is OS-safe');

  assert.deepStrictEqual(jsonDb.voteSegment(id, seg.id, 'down', 'v1'), { success: true, changed: false });
  assert.strictEqual(jsonDb.voteSegment(id, seg.id, 'down', 'v1').reason, 'already_voted');
  assert.strictEqual(jsonDb.voteSegment(id, seg.id, 'up', 'v1').changed, true);

  let skips = await generateSkips(id, { violence: 'high' });
  assert.strictEqual(skips.length, 1);
  assert.deepStrictEqual(skips[0].sourceIds, [seg.id]);

  for (const v of ['a', 'b', 'c', 'd']) jsonDb.voteSegment(id, seg.id, 'down', v);
  skips = await generateSkips(id, { violence: 'high' });
  assert.strictEqual(skips.length, 0, 'disputed segment is no longer served');
});

test('bundled data is present', () => {
  const dir = path.join(__dirname, '../data/filters');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  assert.ok(files.length >= 370, `expected the imported titles, found ${files.length}`);
});

test('MCF timestamps accept every WebVTT form', () => {
  const { parseTimestamp } = require('../src/utils/mcf');
  assert.strictEqual(parseTimestamp('00:00:10.000'), 10000);
  assert.strictEqual(parseTimestamp('0:00:10.000'), 10000);
  assert.strictEqual(parseTimestamp('01:10.500'), 70500);
  assert.strictEqual(parseTimestamp('1:02:03.004'), 3723004);
});

test('poster badge renders onto an image', async () => {
  const sharp = require('sharp');
  const { badgeSvg } = require('../src/utils/posterBadge');
  const out = await sharp({ create: { width: 500, height: 750, channels: 3, background: '#123456' } })
    .composite([{ input: badgeSvg('12 skips'), top: 0, left: 0 }])
    .jpeg()
    .toBuffer();
  const meta = await sharp(out).metadata();
  assert.strictEqual(meta.width, 500);
  assert.strictEqual(meta.height, 750);
  // The badge band (bottom) is green, the top is the original colour
  const { data } = await sharp(out).extract({ left: 250, top: 700, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[1] > data[0] && data[1] > 90, 'bottom band should be green');
});

test('digital release status from TMDB release dates', () => {
  const { digitalStatusFromReleases, digitalTagText } = require('../src/utils/digitalRelease');
  const now = new Date('2026-11-23T00:00:00Z');
  const rel = (region, type, date) => ({ iso_3166_1: region, release_dates: [{ type, release_date: date }] });

  const out = digitalStatusFromReleases([rel('US', 3, '2026-08-01'), rel('US', 4, '2026-10-10')], now, 'US');
  assert.deepStrictEqual(out, { status: 'digital', date: '2026-10-10' });
  assert.strictEqual(digitalTagText(out, now), 'DIGITAL');

  const soon = digitalStatusFromReleases([rel('US', 3, '2026-11-01'), rel('US', 4, '2026-12-12')], now, 'US');
  assert.deepStrictEqual(soon, { status: 'upcoming', date: '2026-12-12' });
  assert.strictEqual(digitalTagText(soon, now), 'DIGITAL 12 DEC');

  const cinema = digitalStatusFromReleases([rel('US', 3, '2026-11-10')], now, 'US');
  assert.strictEqual(digitalTagText(cinema, now), 'IN CINEMAS');

  const old = digitalStatusFromReleases([rel('US', 3, '1997-12-19')], now, 'US');
  assert.strictEqual(old.status, 'digital');
});

test('ready-made collection passes the same checks as Nuvio import', () => {
  const { buildCollection, ADDON_ID } = require('../src/collection/buildCollection');
  const { manifest } = require('../src/addon/manifest');
  const { presetNames } = require('../src/utils/tmdbDiscover');
  const collections = buildCollection();
  assert.ok(Array.isArray(collections) && collections.length > 0);

  const folderIds = new Set();
  const catalogIds = new Set(manifest.catalogs.map(c => `${c.type}:${c.id}`));
  for (const c of collections) {
    assert.ok(c.id && c.title && Array.isArray(c.folders), `collection ${c.title}`);
    for (const f of c.folders) {
      assert.ok(f.id && f.title && Array.isArray(f.sources) && f.sources.length, `folder ${f.title}`);
      assert.ok(['POSTER', 'LANDSCAPE', 'SQUARE'].includes(f.tileShape));
      assert.ok(!folderIds.has(f.id), `duplicate folder id ${f.id}`);
      folderIds.add(f.id);
      for (const s of f.sources) {
        if (s.provider === 'addon') {
          assert.strictEqual(s.addonId, ADDON_ID);
          assert.ok(catalogIds.has(`${s.type}:${s.catalogId}`), `unknown catalog ${s.type}:${s.catalogId}`);
          if (s.catalogId === 'cleanstream-discover') assert.ok(presetNames(s.type).includes(s.genre), `unknown row ${s.genre}`);
        } else {
          assert.strictEqual(s.provider, 'trakt');
          assert.ok(Number.isInteger(s.traktListId));
          assert.ok(['MOVIE', 'TV'].includes(s.mediaType));
        }
      }
    }
  }
  const json = JSON.stringify(collections);
  assert.ok(!/erotic/i.test(json), 'adult list must not be included');
});
