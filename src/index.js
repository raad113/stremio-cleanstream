#!/usr/bin/env node
/**
 * CleanStream - Stremio Addon Server
 * Family-friendly viewing with smart scene skipping
 * 
 * Usage:
 *   npm start                  - Start the server
 *   npm start -- --install     - Install to local Stremio
 * 
 * Environment Variables:
 *   DATABASE_URL    - PostgreSQL connection string (optional, falls back to JSON)
 *   PORT            - Server port (default: 7000)
 *   CLEANSTREAM_BASE_URL - Public URL of the server
 */

const fs = require('fs');
const path = require('path');
const { getRouter } = require('stremio-addon-sdk');
const cors = require('cors');
const express = require('express');

const { builder, manifest } = require('./addon/manifest');
const { subtitlesHandler } = require('./addon/subtitlesHandler');
const { catalogHandler } = require('./addon/catalogHandler');
const apiRoutes = require('./api/routes');
const db = require('./database');
const cache = require('./cache');

// Configuration
const PORT = process.env.PORT || 7000;
const BASE_URL = process.env.CLEANSTREAM_BASE_URL || `http://localhost:${PORT}`;

// Register the catalog handler
builder.defineCatalogHandler(catalogHandler);

// Register the subtitles handler
builder.defineSubtitlesHandler(subtitlesHandler);

// Get the addon interface
const addonInterface = builder.getInterface();

// Create Express app
const app = express();

// Enable CORS for all routes
app.use(cors());

// Behind a reverse proxy (Docker, ElfHosted, Nginx) set TRUST_PROXY=1 so that
// rate limits and vote de-duplication see the real client address.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
}

/**
 * Auto-skip userscript for Stremio Web.
 * The server address and the viewer's filter choices are written into the
 * script so it works straight after installation.
 */
const SKIPPER_TEMPLATE = fs.readFileSync(path.join(__dirname, 'skipper', 'cleanstream-skipper.user.js'), 'utf8');
const SKIPPER_DEFAULTS = { nudity: 'high', sex: 'high', violence: 'medium', language: 'off', drugs: 'off', fear: 'off' };

function sendSkipper(req, res) {
  const config = { ...SKIPPER_DEFAULTS };
  try {
    const requested = req.params.config ? JSON.parse(decodeURIComponent(req.params.config)) : {};
    for (const key of Object.keys(SKIPPER_DEFAULTS)) {
      if (['off', 'low', 'medium', 'high'].includes(requested[key])) config[key] = requested[key];
    }
  } catch (e) {
    // ignore a malformed config and use the defaults
  }
  const script = SKIPPER_TEMPLATE
    .replace("'__CLEANSTREAM_SERVER__'", JSON.stringify(BASE_URL))
    .replace('__CLEANSTREAM_CONFIG__', JSON.stringify(config));
  res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  res.send(script);
}

app.get('/skipper/cleanstream.user.js', sendSkipper);

/**
 * Ready-made Nuvio collection (Settings > Collections > Import > URL).
 */
const { buildCollection } = require('./collection/buildCollection');
app.get('/collection.json', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(buildCollection());
});

/**
 * Poster with a "CleanStream" badge, used by the CleanStream catalog rows.
 * ?d= second badge line (e.g. "12 skips"), ?t= title for the fallback poster.
 */
const { getBadgedPoster } = require('./utils/posterBadge');
const { getDigitalRelease, digitalTagText } = require('./utils/digitalRelease');
app.get('/poster/:imdbId.jpg', async (req, res) => {
  const { imdbId } = req.params;
  if (!/^tt\d{1,10}$/.test(imdbId)) return res.status(400).end();
  const detail = String(req.query.d || 'Family-friendly skips').slice(0, 30);
  const title = req.query.t ? String(req.query.t).slice(0, 80) : undefined;
  const band = req.query.band !== '0';
  try {
    // Digital release tag for movies (skipped for TV shows and with ?digital=0)
    let digitalTag = null;
    if (req.query.digital !== '0') {
      const info = await Promise.race([getDigitalRelease(imdbId), new Promise(r => setTimeout(() => r(null), 6000))]);
      digitalTag = digitalTagText(info);
    }
    const jpeg = await getBadgedPoster(imdbId, { detail, title, digitalTag, band });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(jpeg);
  } catch (err) {
    console.error('[Poster] Failed for', imdbId, err.message);
    res.status(500).end();
  }
});
app.get('/skipper/:config/cleanstream.user.js', sendSkipper);

// Redirect root to configure page
app.get('/', (req, res) => {
  res.redirect('/configure');
});

// Mount API routes
app.use('/api', apiRoutes);

// Serve a simple configuration page
app.get('/configure', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CleanStream - Configure</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #fff;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
    }
    .container { max-width: 600px; margin: 0 auto; }
    h1 { text-align: center; margin-bottom: 10px; }
    .subtitle { text-align: center; color: #8892b0; margin-bottom: 30px; }
    .card {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .filter-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 0;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .filter-row:last-child { border-bottom: none; }
    .filter-label { font-weight: 500; }
    .filter-desc { font-size: 0.85em; color: #8892b0; }
    select {
      background: rgba(255,255,255,0.1);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 14px;
      cursor: pointer;
    }
    .install-btn {
      display: block;
      width: 100%;
      padding: 15px;
      background: #64ffda;
      color: #1a1a2e;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
      text-decoration: none;
      margin-top: 20px;
    }
    .install-btn:hover { background: #4fd1c5; }
    .note {
      text-align: center;
      font-size: 0.85em;
      color: #8892b0;
      margin-top: 20px;
    }
    .stats { text-align: center; margin-bottom: 30px; }
    .stats span {
      display: inline-block;
      padding: 8px 16px;
      background: rgba(100, 255, 218, 0.1);
      border-radius: 20px;
      margin: 0 5px;
      font-size: 0.9em;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎬 CleanStream</h1>
    <p class="subtitle">Family-friendly viewing with smart scene skipping</p>
    
    <div class="stats" id="stats">Loading stats...</div>
    
    <div class="card">
      <h3>Filter Settings</h3>
      <p style="color: #8892b0; font-size: 0.9em;">Choose what content you want to skip. Higher settings skip more content.</p>
      
      <div class="filter-row">
        <div>
          <div class="filter-label">🔞 Nudity</div>
          <div class="filter-desc">Bare skin, nudity</div>
        </div>
        <select id="nudity">
          <option value="off">Off</option>
          <option value="low">Low (strongest only)</option>
          <option value="medium">Medium</option>
          <option value="high" selected>High (all)</option>
        </select>
      </div>
      
      <div class="filter-row">
        <div>
          <div class="filter-label">💋 Sexual Content</div>
          <div class="filter-desc">Sexual scenes, intimacy</div>
        </div>
        <select id="sex">
          <option value="off">Off</option>
          <option value="low">Low (strongest only)</option>
          <option value="medium">Medium</option>
          <option value="high" selected>High (all)</option>
        </select>
      </div>
      
      <div class="filter-row">
        <div>
          <div class="filter-label">⚔️ Violence</div>
          <div class="filter-desc">Fighting, blood, gore</div>
        </div>
        <select id="violence">
          <option value="off">Off</option>
          <option value="low">Low (strongest only)</option>
          <option value="medium" selected>Medium</option>
          <option value="high">High (all)</option>
        </select>
      </div>
      
      <div class="filter-row">
        <div>
          <div class="filter-label">🤬 Language</div>
          <div class="filter-desc">Profanity, slurs</div>
        </div>
        <select id="language">
          <option value="off" selected>Off</option>
          <option value="low">Low (strongest only)</option>
          <option value="medium">Medium</option>
          <option value="high">High (all)</option>
        </select>
      </div>
      
      <div class="filter-row">
        <div>
          <div class="filter-label">💊 Drugs</div>
          <div class="filter-desc">Drug/alcohol use</div>
        </div>
        <select id="drugs">
          <option value="off" selected>Off</option>
          <option value="low">Low (strongest only)</option>
          <option value="medium">Medium</option>
          <option value="high">High (all)</option>
        </select>
      </div>
      
      <div class="filter-row">
        <div>
          <div class="filter-label">👻 Frightening</div>
          <div class="filter-desc">Scary scenes, jumpscares</div>
        </div>
        <select id="fear">
          <option value="off" selected>Off</option>
          <option value="low">Low (strongest only)</option>
          <option value="medium">Medium</option>
          <option value="high">High (all)</option>
        </select>
      </div>
    </div>
    
    <a id="installBtn" class="install-btn" href="#">
      📥 Install in Stremio Desktop
    </a>
    
    <a id="webBtn" class="install-btn" href="#" style="background: #3498db; margin-top: 10px;">
      🌐 Open in Stremio Web
    </a>
    
    <div class="manifest-url" style="margin-top: 20px;">
      <label style="font-size: 0.9em; color: #8892b0;">Manifest URL (copy for manual install):</label>
      <div style="display: flex; gap: 8px; margin-top: 8px;">
        <input type="text" id="manifestUrl" readonly style="flex: 1; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 10px; border-radius: 6px; font-family: monospace; font-size: 0.85em;">
        <button onclick="copyManifest()" style="background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 10px 16px; border-radius: 6px; cursor: pointer;">📋 Copy</button>
      </div>
    </div>
    
    <p class="note">
      The add-on shows skip warnings on Desktop, Android, iOS and Web.
    </p>
    <p class="note" style="font-size: 0.75em;">
      This product uses the TMDB API but is not endorsed or certified by TMDB.
      CleanStream does not host, link to or provide any video. Skips apply only while you watch your own,
      legally obtained copy; no edited copy is created.
    </p>

    <div class="card" style="margin-top: 30px;">
      <h3>⏭️ Automatic skipping (Stremio Web)</h3>
      <p style="color: #8892b0; font-size: 0.9em;">
        Stremio's apps do not let add-ons control playback, so automatic skipping runs as a small
        browser script for <strong>web.stremio.com</strong>. Install a userscript manager
        (Tampermonkey or Violentmonkey) first, then click the button. Your filter choices above are included.
      </p>
      <a id="skipperBtn" class="install-btn" href="#" style="background: #f5a623;">
        ⏭️ Install auto-skip script
      </a>
      <p style="color: #8892b0; font-size: 0.85em; margin-bottom: 0;">
        It skips flagged scenes, mutes flagged language, and shows Undo / 👍 / 👎 after each skip.
      </p>
    </div>

    <div class="card">
      <h3>📚 Ready-made Nuvio collection</h3>
      <p style="color: #8892b0; font-size: 0.9em;">
        Movies, TV, decades, streaming services, family, franchises, documentaries, directors and genres,
        modelled on the B.E.S.T. collection. Install this add-on in Nuvio first, then go to
        <strong>Settings → Collections → Import → URL</strong> and enter:
      </p>
      <p style="font-family: monospace; background: rgba(0,0,0,0.3); padding: 10px; border-radius: 6px; font-size: 0.85em;">
        ${BASE_URL}/collection.json
      </p>
    </div>

    <div class="card">
      <h3>🤝 Share skips with the community</h3>
      <p style="color: #8892b0; font-size: 0.9em;">
        <strong>Two clicks:</strong> click the <strong>♥ Mark scene</strong> button in the player when a kissing or
        sexual scene starts and again when it ends. It is shared automatically, with nothing to fill in.<br><br>
        For other kinds of scenes, press <strong>Alt+S</strong> when an
        unwanted scene starts and <strong>Alt+E</strong> when it ends, then choose a category and press
        <em>Share</em>. Every viewer of this server gets your skip straight away. Skips that collect
        three more 👎 than 👍 are hidden automatically.
      </p>
      <p style="font-family: monospace; background: rgba(0,0,0,0.3); padding: 10px; border-radius: 6px; font-size: 0.85em;">
        POST ${BASE_URL}/api/contribute/{imdbId}
      </p>
    </div>
  </div>
  
  <script>
    const BASE_URL = '${BASE_URL}';
    
    // Load stats
    fetch('/api/stats')
      .then(r => r.json())
      .then(stats => {
        document.getElementById('stats').innerHTML = 
          '<span>🎬 ' + stats.totalMovies + ' titles</span>' +
          '<span>⏭️ ' + stats.totalSegments + ' skips</span>';
      })
      .catch(() => {
        document.getElementById('stats').innerHTML = '<span>Community-driven filters</span>';
      });
    
    // Generate install URL with config
    function updateInstallUrl() {
      const config = {
        nudity: document.getElementById('nudity').value,
        sex: document.getElementById('sex').value,
        violence: document.getElementById('violence').value,
        language: document.getElementById('language').value,
        drugs: document.getElementById('drugs').value,
        fear: document.getElementById('fear').value,
      };
      
      // Encode config into the manifest URL
      const configStr = encodeURIComponent(JSON.stringify(config));
      const manifestUrl = BASE_URL + '/' + configStr + '/manifest.json';
      const installUrl = 'stremio://' + manifestUrl.replace(/^https?:\\/\\//, '');
      const webUrl = 'https://web.stremio.com/#/addons?addon=' + encodeURIComponent(manifestUrl);
      
      document.getElementById('installBtn').href = installUrl;
      document.getElementById('skipperBtn').href = BASE_URL + '/skipper/' + configStr + '/cleanstream.user.js';
      document.getElementById('webBtn').href = webUrl;
      document.getElementById('manifestUrl').value = manifestUrl;
    }
    
    function copyManifest() {
      const input = document.getElementById('manifestUrl');
      input.select();
      document.execCommand('copy');
      
      const btn = event.target;
      btn.textContent = '✓ Copied!';
      setTimeout(() => btn.textContent = '📋 Copy', 1500);
    }
    
    // Update on any change
    document.querySelectorAll('select').forEach(sel => {
      sel.addEventListener('change', updateInstallUrl);
    });
    
    // Initial update
    updateInstallUrl();
  </script>
</body>
</html>
  `);
});

// Mount the Stremio addon router
// Handle configuration in URL (e.g., /{"nudity":"high"}/manifest.json)
app.get('/:config/manifest.json', (req, res) => {
  try {
    const config = JSON.parse(decodeURIComponent(req.params.config));
    // Return manifest with embedded config hint
    res.json({
      ...manifest,
      behaviorHints: {
        ...manifest.behaviorHints,
        // Store user config for use in handlers
        userConfig: config,
      },
    });
  } catch (e) {
    res.json(manifest);
  }
});

// Mount Stremio SDK router for all other addon routes
app.use(getRouter(addonInterface));

// Start server
async function startServer() {
  // Initialize database (runs migrations if DATABASE_URL is set)
  const dbInitialized = await db.initialize();
  
  if (dbInitialized) {
    console.log('✅ PostgreSQL connected and migrations applied');
  } else if (process.env.DATABASE_URL) {
    console.warn('⚠️  DATABASE_URL set but connection failed, check your database');
  } else {
    console.log('ℹ️  No DATABASE_URL set, using JSON file storage');
  }

  // Initialize Redis cache
  const cacheInitialized = await cache.initialize();
  
  if (cacheInitialized) {
    console.log('✅ Redis cache connected');
  } else if (process.env.REDIS_URL) {
    console.warn('⚠️  REDIS_URL set but connection failed, caching disabled');
  } else {
    console.log('ℹ️  No REDIS_URL set, caching disabled');
  }

  if (!process.env.TMDB_API_KEY) {
    console.warn('ℹ️  No TMDB_API_KEY set: posters fall back to Stremio images, and digital release tags and Discover rows are off');
  }

  app.listen(PORT, () => {
    console.log('');
    console.log('🎬 CleanStream - Stremio Addon');
    console.log('═══════════════════════════════════════════');
    console.log(`✅ Server running at: ${BASE_URL}`);
    console.log(`📦 Addon manifest:    ${BASE_URL}/manifest.json`);
    console.log(`⚙️  Configure:         ${BASE_URL}/configure`);
    console.log(`📊 API endpoint:      ${BASE_URL}/api`);
    console.log(`💾 Storage:           ${dbInitialized ? 'PostgreSQL' : 'JSON files'}`);
    console.log(`⚡ Cache:             ${cacheInitialized ? 'Redis' : 'disabled'}`);
    console.log('');
    console.log('📥 Install in Stremio:');
    console.log(`   stremio://${BASE_URL.replace(/^https?:\/\//, '')}/manifest.json`);
    console.log('');
    console.log('🤝 Contribute skip data:');
    console.log(`   POST ${BASE_URL}/api/contribute/{imdbId}`);
    console.log('');
  });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  await cache.disconnect();
  await db.disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully...');
  await cache.disconnect();
  await db.disconnect();
  process.exit(0);
});

// Start the server
startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

module.exports = app;
