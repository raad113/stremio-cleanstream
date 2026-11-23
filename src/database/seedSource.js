/**
 * Seed data loader
 *
 * Reads the bundled per-title JSON files (data/filters/*.json). These files are
 * the single source of truth for the built-in skip data: JSON storage reads them
 * directly, and PostgreSQL is seeded from them on first start.
 */

const fs = require('fs');
const path = require('path');

const SEED_DIR = path.join(__dirname, '../../data/filters');

function loadSeedTitles(dir = SEED_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch (err) {
        console.warn(`[Seed] Skipping unreadable file ${f}: ${err.message}`);
        return null;
      }
    })
    .filter(t => t && t.imdbId);
}

module.exports = { loadSeedTitles, SEED_DIR };
