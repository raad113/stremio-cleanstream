# Putting CleanStream online

This guide installs CleanStream on a Linux VPS under its own free address. It can share a
server with another website without touching it: CleanStream lives in its own folder
(`/opt/cleanstream`), runs in its own Docker containers, and keeps its own database.

Time needed: about 30 minutes. Cost: nothing extra if you already have the server.

## 1. Get a free address (DuckDNS)

[DuckDNS](https://www.duckdns.org) gives you a free, permanent address such as
`familyskips.duckdns.org`, separate from any other website you run. HTTPS is free too
(Caddy or certbot gets the certificate automatically).

1. Open https://www.duckdns.org and sign in (GitHub, Google, Reddit or X account).
2. Type a name in **sub domain**, for example `familyskips`, and press **add domain**.
   Avoid other companies' names (for example "nuvio", "netflix" or "stremio").
3. In the **current ip** box next to your new name, enter your server's public IP address
   (step 3 prints it, or see your VPS dashboard) and press **update ip**.

Your `DOMAIN` setting is then `familyskips.duckdns.org`. It usually works within a minute.

Keep the DuckDNS **token** shown at the top of the page private; you do not need it here,
because a VPS keeps the same IP address.

> **Prefer your own name later?** A paid domain (about 10 to 15 USD a year from Cloudflare,
> Porkbun or Namecheap) looks more professional and does not depend on a free service.
> Point an **A** record (`@` or a subdomain) at the server's IP, change `DOMAIN` in `.env`,
> and restart; nothing else changes.

## 2. Wait for the address to work

Check from your own computer that the name points at the server:

```bash
ping familyskips.duckdns.org
```

It should show your server's IP address.

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

### C. Another website's Caddy runs in Docker on ports 80 and 443

Start CleanStream without its own Caddy:

```bash
docker compose up -d --build
```

Then let the existing Caddy pass your CleanStream address on to it. Only the CleanStream
app is reachable this way; its database and Redis stay private.

1. Add this block at the end of the other website's `Caddyfile` (replace the address):

   ```
   familyskips.duckdns.org {
   	encode gzip
   	reverse_proxy cleanstream:7000
   }
   ```

2. In the other website's `docker-compose.yml`, connect its Caddy service to CleanStream's network:

   ```yaml
   services:
     caddy:
       # ...existing settings stay as they are...
       networks:
         - default
         - cleanstream-public

   networks:
     cleanstream-public:
       external: true
   ```

   If its Caddy service already lists `networks:`, add `cleanstream-public` to that list
   and keep the others.

3. Apply it from the other website's folder:

   ```bash
   docker compose up -d caddy
   ```

Caddy gets the HTTPS certificate for the new address automatically. The other website
keeps running; its Caddy restarts for a second or two.

### D. Apache already uses ports 80 and 443

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
