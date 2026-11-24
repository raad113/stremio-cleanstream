/**
 * Automatic imports of outside skip data, all saved as UNCONFIRMED:
 *   - every day:   new files from the VideoSkip exchange
 *   - every Sunday: new skips from the public CleanStream server
 *
 * Viewers' own skips need no schedule: apps load the latest skips from this
 * server each time a title starts playing.
 *
 * Settings: DAILY_IMPORT=off turns it off; DAILY_IMPORT_HOUR_UTC (default 3)
 * sets the hour it runs.
 */

const { importFromVideoSkip } = require('../importers/videoskip');
const { importFromCleanStream } = require('../importers/cleanstreamServer');

let running = false;

const log = message => console.log(`[Daily import] ${message}`);

async function runImports(now = new Date()) {
  if (running) return;
  running = true;
  try {
    await importFromVideoSkip({ log });
  } catch (err) {
    log(`VideoSkip import failed: ${err.message}`);
  }
  try {
    if (now.getUTCDay() === 0) await importFromCleanStream({ log });
  } catch (err) {
    log(`CleanStream import failed: ${err.message}`);
  } finally {
    running = false;
  }
}

/** Milliseconds until the next run at HH:17 UTC (minute 17 avoids the top of the hour). */
function msUntilNextRun(hourUtc, now = new Date()) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 17, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

function startDailyImport() {
  if (String(process.env.DAILY_IMPORT || 'on').toLowerCase() === 'off') {
    log('turned off (DAILY_IMPORT=off)');
    return;
  }
  const hour = Math.min(23, Math.max(0, Number(process.env.DAILY_IMPORT_HOUR_UTC ?? 3) || 0));
  const schedule = () => {
    const wait = msUntilNextRun(hour);
    log(`next run in ${Math.round(wait / 60000)} minutes`);
    setTimeout(async () => {
      await runImports();
      schedule();
    }, wait).unref();
  };
  schedule();
}

module.exports = { startDailyImport, runImports, msUntilNextRun };
