#!/usr/bin/env node
/**
 * Import skips from another CleanStream server (by default the public one)
 * as UNCONFIRMED skips. The same import also runs weekly by itself (see
 * src/community/dailyImport.js).
 *
 *   docker compose exec cleanstream node scripts/public-cleanstream-import.js --dry-run
 *   docker compose exec cleanstream node scripts/public-cleanstream-import.js
 *
 * Options: --source=<url>  --dry-run  --delay=<ms between requests, default 400>
 */

const db = require('../src/database');
const { importFromCleanStream, DEFAULT_SOURCE } = require('../src/importers/cleanstreamServer');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));

(async () => {
  await db.initialize();
  await importFromCleanStream({
    source: args.source || DEFAULT_SOURCE,
    dryRun: Boolean(args['dry-run']),
    delayMs: Number(args.delay || 400),
  });
  await db.disconnect();
})().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
