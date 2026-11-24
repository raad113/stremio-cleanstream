#!/usr/bin/env node
/**
 * Import new skip files from the VideoSkip exchange as UNCONFIRMED skips.
 * The same import also runs daily by itself (see src/community/dailyImport.js).
 *
 *   docker compose exec cleanstream node scripts/videoskip-import.js --dry-run
 *   docker compose exec cleanstream node scripts/videoskip-import.js
 *
 * Options: --dry-run  --delay=<ms between requests, default 1500>  --pages=<max list pages>
 */

const db = require('../src/database');
const { importFromVideoSkip } = require('../src/importers/videoskip');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));

(async () => {
  await db.initialize();
  await importFromVideoSkip({
    dryRun: Boolean(args['dry-run']),
    delayMs: Number(args.delay || 1500),
    maxPages: Number(args.pages || 60),
  });
  await db.disconnect();
})().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
