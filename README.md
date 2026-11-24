# CleanStream - Stremio Addon

**Family-friendly viewing with smart scene skipping**

Skip unwanted scenes (nudity, violence, language, etc.) in movies and TV shows. Community-driven, open-source alternative to VidAngel/ClearPlay.

## 🚀 Quick Install

### Public Instance (Recommended)

**https://cleanstream.elfhosted.com**

1. Visit https://cleanstream.elfhosted.com/configure
2. Choose your filter settings
3. Click "Install in Stremio Desktop" or "Open in Stremio Web"

Or add directly in Stremio:
```
https://cleanstream.elfhosted.com/manifest.json
```

### Self-Hosted

See [Self-Hosting](#self-hosting) below.

## ⚠️ Current Status

**In every Stremio app:** the add-on shows on-screen warnings before scenes you want to skip, so you can skip them yourself.

**Automatic skipping in Stremio Web:** install the auto-skip userscript from the `/configure` page (see [Automatic skipping](#automatic-skipping-stremio-web)). Stremio's desktop, Android, iOS and TV apps do not let add-ons control playback, so automatic skipping is only possible in the browser.

## Features

- 🎯 **Configurable filters** - Choose what to skip: nudity, violence, language, drugs, fear
- 📊 **Filter levels** - High skips every flagged scene, Medium skips medium and strong scenes, Low skips only the strongest
- ⏭️ **Automatic skipping** - Userscript for Stremio Web that skips or mutes scenes
- 📚 **"CleanStream Ready" Catalog** - Browse movies with skip data in Stremio's Discover section
- 🎬 **376 movies, 1,608 skips** - Pre-loaded with skip data from VideoSkip (in `data/filters`, used by both storage modes)
- 🤝 **Community contributions** - Add skip timestamps for movies you watch
- 📥 **MCF compatible** - Import/export MovieContentFilter format
- 🗳️ **Voting system** - Upvote accurate timestamps, downvote mistakes
- 🐳 **Docker ready** - One command deployment with PostgreSQL + Redis

## Automatic Skipping (Stremio Web)

1. Install a userscript manager in your browser: [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/). Both work in Chrome, Edge, Firefox (including Firefox for Android) and Safari.
2. Open `https://<your-server>/configure`, choose your filters and click **Install auto-skip script**.
3. Watch on [web.stremio.com](https://web.stremio.com). A small "CleanStream: N skips" badge appears at the top of the player.

The script jumps over flagged scenes and mutes scenes marked as audio only (for example, profanity). After each skip it shows **Undo**, **👍** and **👎**.

### Quick mark: two clicks to share a kissing or sexual scene

A **♥ Mark scene** button appears at the bottom right of the player when you move the mouse.

1. Click it when the scene starts. The button turns red and counts the seconds.
2. Click it again when the scene ends.
3. The scene is shared five seconds later. Click the button during those five seconds (or press `Esc`) to cancel.

No form appears. The scene is saved as "sex" with the strength chosen once in the script's settings (mild, moderate or strong; moderate by default). Clicks less than one second apart are ignored. `Alt+K` does the same as the button.

| Shortcut | Action |
|----------|--------|
| `Alt+S` | Mark the start of a scene to share |
| `Alt+E` | Mark the end and open the share form |
| `Alt+C` | Turn auto-skip on or off |
| `Alt+←` / `Alt+→` | Shift all skips 0.5 s earlier or later (for a different cut of the film) |
| `Alt+K` | Same as the ♥ quick-mark button |
| `Alt+H` | Show help |

## Poster Badges

Every title in the CleanStream rows (movies and the new **CleanStream - TV Shows** row) uses a poster with a green **✓ CleanStream** band showing the number of skips, or the number of episodes ready for a show. The server builds these images itself (`/poster/<imdbId>.jpg`), so they appear in any app that shows add-on catalogues: Stremio, Nuvio, and their Android TV versions.

Posters come from TMDB, then from Stremio's public poster service. Set `POSTER_SOURCE_TEMPLATE` (for example `https://example.com/posters/{imdbId}.jpg`) to use another source. Rows from other add-ons (Cinemeta, TMDB, AIOMetadata) keep their own posters; an add-on cannot change them.

## Digital Release Tags and New Digital Releases

Movie posters served by CleanStream also carry a tag in the top-right corner, based on TMDB release dates:

* **DIGITAL** (blue): the film can already be streamed or rented at home.
* **DIGITAL 12 DEC** (amber): not out digitally yet; the date is the expected digital release.
* **IN CINEMAS** (amber): only in cinemas so far, with no digital date announced.

Films with no digital date on TMDB that came out more than six months ago (or are on DVD/Blu-ray) count as digital. Dates use the US release by default; set `DIGITAL_RELEASE_REGION` (for example `SA` or `GB`) to prefer another country, falling back to any country.

The **New digital releases** row lists popular films released digitally in the last 60 days. Titles that already have CleanStream skips also show the CleanStream band.

## Ready-made Nuvio Collection

`/collection.json` is a Nuvio collection modelled on the B.E.S.T. community collection and reorganised for families: **CleanStream**, **Movies**, **TV Shows**, **Decades**, **Streaming** (Netflix, Prime Video, Disney+, Apple TV+, Paramount+, HBO Max, Starz), **Family & Animation**, **Franchises**, **Documentaries & Nature**, **Directors** and **Genres** (96 folders).

1. Install the CleanStream add-on in Nuvio.
2. Go to **Settings → Collections → Import → URL** and enter `https://<your-server>/collection.json`.

TMDB-based rows come from the add-on's **CleanStream Discover** catalog, so their posters carry the digital release tag and the CleanStream band. Curated lists (franchises, directors, documentaries) are the public Trakt lists B.E.S.T. uses; Nuvio reads them itself, so those posters are Nuvio's own. B.E.S.T.'s adult list is left out, and its MDBList/TVDB rows (which need AIOMetadata) are replaced by equivalent TMDB rows.

## Legal and Licensing

This section explains how the project is meant to stay within the law. It is not legal advice; check the rules of the country where you run the server.

* **No video is hosted, linked or provided.** CleanStream serves skip times, metadata and posters only. Use it only with copies you are entitled to watch.
* **Filtering during playback only.** Scenes are skipped or muted while you watch; no edited copy is made or shared, and nothing is decrypted. In the United States this matches the Family Movie Act of 2005 (17 U.S.C. § 110(11)), which allows making parts of an authorised copy imperceptible during private home viewing as long as no fixed copy of the altered version is created. Services that copied or decrypted films to do this have lost in court (Disney Enterprises, Inc. v. VidAngel, Inc., 9th Cir. 2017).
* **TMDB.** Each server must use its own TMDB API key (`TMDB_API_KEY`) and show the attribution "This product uses the TMDB API but is not endorsed or certified by TMDB". Non-commercial use only unless you have a commercial licence from TMDB.
* **Skip data.** The bundled skip data comes from VideoSkip (credited below). Check the VideoSkip terms before redistributing the data commercially.
* **Collection.** The ready-made collection is modelled on the B.E.S.T. community collection and uses public Trakt lists by their authors; credit them when sharing it.
* **Privacy.** Votes are stored as a salted hash of IP address and browser, never the address itself; rate limits keep IP addresses in memory for up to an hour. Set `CLEANSTREAM_VOTE_SALT` to a long random secret. If others use your server, tell them what is stored.
* **Licence.** CleanStream is MIT licensed (see `LICENSE`).

## Android TV and Nuvio

| Feature | Stremio / Nuvio on Android TV | Stremio Web in a browser |
|---------|-------------------------------|--------------------------|
| CleanStream rows with badged posters | Yes | Yes |
| On-screen warnings (the "CleanStream" subtitle track) | Yes | Stremio Web does not load add-on subtitles |
| Automatic skipping and ♥ quick mark | No: TV apps do not let add-ons control playback | Yes, with the userscript |

NuvioTV has built-in skipping for intros and credits, but its skip sources (IntroDB, AniSkip, Anime-Skip) are fixed when the app is built, so CleanStream cannot be added as a source from the app. Automatic skipping on Android TV would need a modified NuvioTV build (it is open source, GPL-3.0).

## Community Sharing

Skips are shared through the server the add-on is installed from. Everyone who uses the same server sees the same data.

* **Adding skips:** use the ♥ button (two clicks), `Alt+S` / `Alt+E` in Stremio Web, the remote button in NuvioTv-Family, or `POST /api/contribute/:id`.
* **New skips start as "pending".** They apply straight away for the person who made them, but are never skipped silently for anyone else. Other viewers see a prompt instead: *"A viewer marked this as kissing (unconfirmed): Skip / Not a scene"*.
* **Confirmation.** A pending skip goes live for everyone when a different viewer marks the same scene with closely matching times (at least 60% overlap of the longer mark, so a short scene cannot be stretched into a long cut), or when two more viewers confirm it than reject it.
* **Rejection.** Any skip stops being served once three more viewers reject it than confirm it.
* **Trust.** Each device has an anonymous contributor record. Contributors with confirmed skips (score = confirmed − 3 × rejected ≥ 3) become trusted and their skips apply at once; five rejected skips (more than confirmed) block a contributor automatically. Nobody can vote on their own skip.
* **Limits.** A single skip can be at most 4 minutes (15 for trusted contributors), with at most 10 unconfirmed skips per viewer per title. Bulk MCF imports need the admin token.
* **Moderation page.** Set `ADMIN_TOKEN` and open `/admin` to approve, reject, or reject and block.
* **Series:** skips are stored per episode (`tt0944947:1:2`), because timings differ between episodes.
* **Abuse limits:** contributions and votes are rate-limited per IP (`CONTRIBUTE_LIMIT_PER_HOUR`, `VOTE_LIMIT_PER_HOUR`). Set `TRUST_PROXY=1` behind a reverse proxy so the limits see real client addresses.

**Automatic imports.** Once a day the server checks the [VideoSkip](https://videoskip.org) exchange for newly shared skip files (films, and episodes when `TMDB_API_KEY` is set), and every Sunday the public CleanStream server for new skips. Everything imported is saved as **unconfirmed**, leaving out duplicates. Set `DAILY_IMPORT=off` to stop this, or `DAILY_IMPORT_HOUR_UTC` to change the hour (default 3). Run the VideoSkip import by hand with:

```bash
docker compose exec cleanstream node scripts/videoskip-import.js --dry-run
docker compose exec cleanstream node scripts/videoskip-import.js
```

Viewers' own skips need no schedule: apps load the latest skips each time a title starts playing.

**Importing skips from another CleanStream server.** `scripts/public-cleanstream-import.js` copies the skips from another server (by default the public `cleanstream.elfhosted.com`) as **unconfirmed** skips, leaving out duplicates, broken entries and skips that server's viewers voted down. Run it with `--dry-run` first:

```bash
docker compose exec cleanstream node scripts/public-cleanstream-import.js --dry-run
docker compose exec cleanstream node scripts/public-cleanstream-import.js
```

A self-hosted server starts with the bundled data (376 titles, 1,608 skips) but does not sync with other servers, including the public instance. To pool contributions, a group of people should install the add-on from one shared server.

## How It Works

1. **Install the addon** from [cleanstream.elfhosted.com](https://cleanstream.elfhosted.com)
2. **Browse the catalog** - In Stremio's Discover section, look for **"CleanStream Ready"** to see movies with skip data
3. **Play a movie** - Select any movie and find a stream
4. **Enable skip subtitles** - Go to subtitles (CC) and select **"CleanStream (X skips)"**
5. **Watch for warnings** - You'll see on-screen alerts before scenes to skip

## Self-Hosting

### Production on your own server

See **[deploy/README.md](deploy/README.md)** for a step-by-step guide: own domain, HTTPS,
PostgreSQL and Redis kept private, and safe alongside another website on the same VPS.

### Docker (Recommended)

```bash
# Clone the repo
git clone https://github.com/ameen-roayan/stremio-cleanstream.git
cd stremio-cleanstream

# Start everything (app + PostgreSQL + Redis)
docker compose up -d

# Seed the database with VideoSkip data
docker exec cleanstream npx prisma db seed

# View logs
docker compose logs -f cleanstream
```

The addon will be available at `http://localhost:7000`

### Without Docker

```bash
npm install
npm run dev
```

This runs with JSON file storage (no database required).

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `7000` |
| `DATABASE_URL` | PostgreSQL connection string | (uses JSON files if not set) |
| `REDIS_URL` | Redis connection string | (caching disabled if not set) |
| `CLEANSTREAM_BASE_URL` | Public URL of the server (also written into the auto-skip script) | `http://localhost:7000` |
| `CLEANSTREAM_DATA_DIR` | Folder for JSON storage | `data/filters` |
| `TRUST_PROXY` | Express `trust proxy` setting, e.g. `1` behind one proxy | (off) |
| `CLEANSTREAM_VOTE_SALT` | Secret salt for anonymous voter ids (set a long random value) | random at each start |
| `DAILY_IMPORT` | `off` stops the automatic VideoSkip / CleanStream imports | `on` |
| `DAILY_IMPORT_HOUR_UTC` | Hour (UTC) of the automatic imports | `3` |
| `ADMIN_TOKEN` | Password for the moderation page `/admin` (16+ characters) | (admin off) |
| `CONTRIBUTE_LIMIT_PER_HOUR` | Contributions per IP per hour | `60` |
| `VOTE_LIMIT_PER_HOUR` | Votes per IP per hour | `300` |
| `TMDB_API_KEY` | Your own free TMDB key (posters, digital release tags, Discover rows) | (none: those features are off) |
| `DIGITAL_RELEASE_REGION` | Country used for digital release dates | `US` |
| `POSTER_SOURCE_TEMPLATE` | Optional poster source, `{imdbId}` is replaced | (TMDB, then metahub) |

### Example

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/cleanstream
REDIS_URL=redis://localhost:6379
CLEANSTREAM_BASE_URL=https://cleanstream.example.com
```

## Database

CleanStream uses PostgreSQL with Prisma ORM:

- **Migrations run automatically** on app startup
- **Multi-replica safe** - Uses PostgreSQL advisory locks
- **Falls back to JSON files** when no DATABASE_URL is set

### Manual Migration Commands

```bash
# Create a new migration (development)
npm run db:migrate:dev -- --name add_new_feature

# Apply migrations (production)
npm run db:migrate

# Open Prisma Studio (GUI)
npm run db:studio
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check (includes DB + Redis status) |
| `/api/filters` | GET | List all available titles |
| `/api/filters/:imdbId` | GET | Get filter data for a title |
| `/api/skips/:imdbId` | GET | Get processed skips with user config |
| `/api/contribute/:imdbId` | POST | Add a new skip segment |
| `/api/vote/:imdbId/:segmentId` | POST | Vote on a segment |
| `/api/stats` | GET | Get contribution statistics |

## Contributing Skip Data

### Via API

```bash
curl -X POST http://localhost:7000/api/contribute/tt0133093 \
  -H "Content-Type: application/json" \
  -d '{
    "startMs": 3600000,
    "endMs": 3660000,
    "category": "violence",
    "severity": "high",
    "comment": "Fight scene in lobby"
  }'
```

### Via CLI

```bash
npm run contribute
```

## Install in Stremio

### Public Instance
1. Open Stremio
2. Go to Addons
3. Enter: `https://cleanstream.elfhosted.com/manifest.json`
4. Click Install

Or visit https://cleanstream.elfhosted.com/configure for a guided setup.

### Self-Hosted
1. Open Stremio
2. Go to Addons
3. Enter: `http://localhost:7000/manifest.json`
4. Click Install

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Stremio   │────▶│ CleanStream │────▶│ PostgreSQL  │
│   Client    │     │   Addon     │     │             │
└─────────────┘     └──────┬──────┘     └─────────────┘
                          │
                          ▼
                   ┌─────────────┐
                   │    Redis    │
                   │   (Cache)   │
                   └─────────────┘
```

## License

MIT - See [LICENSE](LICENSE)

## Credits & Data Sources

- **[VideoSkip](https://videoskip.org)** - Initial skip timestamp data. Thanks to Francisco Ruiz and the VideoSkip community for building an amazing open database of skip timestamps.
- [MovieContentFilter](https://www.moviecontentfilter.com/) - MCF format specification
- [SponsorBlock](https://sponsor.ajay.app/) - Inspiration for community-driven content filtering
- [Stremio](https://stremio.com/) - Addon SDK
- [ElfHosted](https://elfhosted.com/) - Hosting infrastructure
