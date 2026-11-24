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

test('trust rules: new skips are pending until another viewer confirms', () => {
  const trust = require('../src/community/trust');
  const mine = { startMs: 60000, endMs: 90000, category: 'sex', contributorHash: 'A' };

  // A first-time contributor's skip waits for confirmation
  assert.strictEqual(trust.decideNewStatus(mine, null, []).status, 'pending');

  // A matching mark by someone else confirms both
  const theirs = { id: 's1', startMs: 62000, endMs: 91000, category: 'sex', contributorHash: 'B', status: 'pending' };
  const d = trust.decideNewStatus(mine, null, [theirs]);
  assert.strictEqual(d.status, 'approved');
  assert.deepStrictEqual(d.corroborates.map(s => s.id), ['s1']);

  // The same person marking twice does not confirm their own skip
  assert.strictEqual(trust.decideNewStatus(mine, null, [{ ...theirs, contributorHash: 'A' }]).status, 'pending');

  // Stretching a short real scene into a long cut does not count as a match
  const stretched = { startMs: 0, endMs: 240000, category: 'sex', contributorHash: 'C' };
  assert.strictEqual(trust.decideNewStatus(stretched, null, [theirs]).status, 'pending');

  // Trusted contributors apply straight away; blocked ones are refused
  assert.strictEqual(trust.decideNewStatus(mine, { approved: 5, rejected: 0 }, []).status, 'approved');
  assert.ok(trust.checkLimits(mine, { blocked: true }, []));

  // Limits: new contributors max 4 minutes per skip
  assert.ok(trust.checkLimits({ ...mine, endMs: 60000 + 5 * 60000 }, null, []));
  assert.strictEqual(trust.checkLimits(mine, null, []), null);
});

test('trust rules: votes confirm or reject, and repeat offenders are blocked', () => {
  const trust = require('../src/community/trust');
  assert.strictEqual(trust.statusAfterVotes({ status: 'pending', votes: { up: 2, down: 0 } }), 'approved');
  // A confirmed skip reported wrong goes back to unconfirmed; an unconfirmed one is rejected
  assert.strictEqual(trust.statusAfterVotes({ status: 'approved', votes: { up: 0, down: 3 } }), 'pending');
  assert.strictEqual(trust.statusAfterVotes({ status: 'pending', votes: { up: 0, down: 3 } }), 'rejected');
  assert.strictEqual(trust.statusAfterVotes({ status: 'pending', votes: { up: 1, down: 1 } }), null);

  let c = null;
  for (let i = 0; i < 5; i++) c = trust.contributorAfterDecision(c, 'rejected');
  assert.strictEqual(c.blocked, true);
});

test('VideoSkip .skp files are converted to CleanStream skips', () => {
  const { parseSkp } = require('../src/importers/videoskip');
  const sample = `-1:59:59.95
nudity video 3 (naked breasts)0:36:21.23

0:35:30.95 --> 0:35:55.71
nudity video 3 (naked breasts)0:36:21.23

0:40:05.09 --> 0:40:21.62
sex 2 (passionate kissing)

0:50:00.00 --> 0:50:01.50
profane word 2 (f-word)

1:01:02.04
Bill Murray's hand comes onto the screen from the right side.

1:10:00.00 --> 1:10:05.00
logo wave (screenshot note)
`;
  const segs = parseSkp(sample);
  assert.strictEqual(segs.length, 3);
  assert.deepStrictEqual(segs[0], {
    startMs: 2130950, endMs: 2155710, category: 'nudity', subcategory: 'nudity',
    severity: 'high', channel: 'both', comment: 'naked breasts',
  });
  assert.strictEqual(segs[1].category, 'sex');
  assert.strictEqual(segs[1].severity, 'medium');
  assert.strictEqual(segs[2].category, 'language');
  assert.strictEqual(segs[2].channel, 'audio');
});

test('VideoSkip parser reads every bundled .skp file without errors', () => {
  const fs = require('fs');
  const path = require('path');
  const { parseSkp } = require('../src/importers/videoskip');
  const dir = path.join(__dirname, '../data/videoskip-imports');
  let total = 0;
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.skp'))) {
    total += parseSkp(fs.readFileSync(path.join(dir, f), 'utf8')).length;
  }
  assert.ok(total > 1000, `expected many skips from bundled files, got ${total}`);
});

test('daily import runs at the configured hour', () => {
  const { msUntilNextRun } = require('../src/community/dailyImport');
  const now = new Date('2026-11-24T02:00:00Z');
  assert.strictEqual(msUntilNextRun(3, now), 77 * 60 * 1000);
  assert.strictEqual(msUntilNextRun(1, now), (23 * 60 + 17) * 60 * 1000);
});
