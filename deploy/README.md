# Putting CleanStream online

This guide installs CleanStream on a Linux VPS under its own domain. It can share a
server with another website without touching it: CleanStream lives in its own folder
(`/opt/cleanstream`), runs in its own Docker containers, and keeps its own database.

Time needed: about 30 minutes, plus up to an hour for a new domain to start working.

## 1. Get a domain

Buy a domain for CleanStream from a registrar such as Cloudflare, Porkbun or Namecheap
(about 10 to 15 USD a year). Avoid other companies' names in it (for example "nuvio",
"netflix" or "stremio"); a neutral name such as `familyskips.com` avoids trademark trouble.

You can use the domain itself (`familyskips.com`) or a subdomain (`app.familyskips.com`).

## 2. Point the domain at your server

Find your server's public IP address (step 3 prints it, or see your VPS dashboard).
In the registrar's DNS settings add one record:

| Type | Name | Value |
|------|------|-------|
| A | `@` (or `app` for a subdomain) | your server's IP address |

If you use Cloudflare, set the record to **DNS only** (grey cloud) until HTTPS works.

## 3. Check the server

Log in with SSH and run the read-only check (it changes nothing):

```bash
curl -fsSL https://raw.githubusercontent.com/raad113/stremio-cleanstream/main/deploy/check-server.sh | bash
```

It shows whether Docker is installed, whether ports 80 and 443 are already used
(for example by nginx for your other website), memory and disk space, and your IP address.
CleanStream needs about 1 GB of free memory and 3 GB of disk.

## 4. Install Docker (only if the check says it is missing)

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # then log out and back in
```

## 5. Download CleanStream

```bash
sudo mkdir -p /opt/cleanstream && sudo chown $USER /opt/cleanstream
git clone https://github.com/raad113/stremio-cleanstream /opt/cleanstream
cd /opt/cleanstream/deploy
```

## 6. Fill in the settings

```bash
cp .env.example .env
openssl rand -hex 32   # run twice: one value for POSTGRES_PASSWORD, one for CLEANSTREAM_VOTE_SALT
nano .env
```

Set `DOMAIN` (without `https://`), your `TMDB_API_KEY`, `POSTGRES_PASSWORD` and
`CLEANSTREAM_VOTE_SALT`. Save with Ctrl+O, Enter, Ctrl+X. The `.env` file stays on the
server only; it is never uploaded to GitHub.

## 7. Start it

Pick the case that matches step 3.

### A. Ports 80 and 443 are free

Caddy, included here, serves the site and gets the HTTPS certificate automatically:

```bash
docker compose --profile caddy up -d --build
```

### B. nginx already uses ports 80 and 443 (your other website)

Start CleanStream without Caddy, then add a separate nginx site for the new domain:

```bash
docker compose up -d --build
sudo cp nginx-cleanstream.conf /etc/nginx/sites-available/cleanstream
sudo nano /etc/nginx/sites-available/cleanstream   # replace cleanstream.example.com with your domain
sudo ln -s /etc/nginx/sites-available/cleanstream /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx   # if certbot is not installed yet
sudo certbot --nginx -d your-domain.com
```

`nginx -t` checks the configuration before reloading, so a mistake cannot take your
other website down. Your other site's files are not changed.

### C. Apache already uses ports 80 and 443

Ask me for the Apache version of step B; it works the same way.

The first start takes a few minutes: it builds the app and loads the 376 bundled films.

## 8. Check that it works

* `https://your-domain.com/api/health` should show `"status":"ok"` and `"storage":"postgresql"`.
* `https://your-domain.com/configure` shows the install page.

If something is wrong: `docker compose logs -f cleanstream` (Ctrl+C to stop watching).

If the server uses a firewall (`sudo ufw status`), allow web traffic: `sudo ufw allow 80,443/tcp`.

## 9. Start using it

* **Stremio / Nuvio:** open `https://your-domain.com/configure`, choose filters, install.
* **Ready-made collection (Nuvio):** Settings → Collections → Import → URL →
  `https://your-domain.com/collection.json`.
* **Auto-skip in Stremio Web:** "Install auto-skip script" on the configure page.
* **NuvioTv-Family:** Settings → Integrations → NuvioTv-Family → CleanStream server →
  `https://your-domain.com`.

## Updating and backups

Update to the latest version:

```bash
cd /opt/cleanstream && git pull && cd deploy && docker compose up -d --build
```

(add `--profile caddy` if you use case A).

Back up the community skips and votes (keep the file somewhere safe):

```bash
cd /opt/cleanstream/deploy
docker compose exec -T postgres pg_dump -U cleanstream cleanstream > cleanstream-$(date +%F).sql
```
