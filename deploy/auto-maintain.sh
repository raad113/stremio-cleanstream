#!/usr/bin/env bash
#
# Weekly maintenance for the CleanStream server.
#
# Install once (as root, from the repository folder):
#   bash deploy/auto-maintain.sh --install
#
# It then runs every Sunday at 04:17 (server time) and:
#   1. backs up the skip database to /root/cleanstream-backups (keeps the newest 8)
#   2. installs all Ubuntu and Docker updates
#   3. refreshes the containers: pulls the newest images of the same versions
#      (Node.js 20, PostgreSQL 16, Redis, Caddy...) and rebuilds, so security fixes
#      inside the containers are installed too, not only Ubuntu's
#   4. removes unused Docker images and build cache
#   5. restarts the server if an update needs it (the containers start again by themselves)
#
# Other Docker Compose projects on this server can be refreshed too: list their
# folders in /etc/cleanstream-maintain.conf, e.g.
#   COMPOSE_DIRS="/opt/cleanstream/deploy /opt/mxaap"
# Security fixes are also installed every night by Ubuntu's unattended-upgrades.
# It never moves to a new Ubuntu release and never changes the CleanStream code.
# Log: /var/log/cleanstream-maintain.log

set -u
LOG=/var/log/cleanstream-maintain.log
BACKUP_DIR=/root/cleanstream-backups
KEEP=8
COMPOSE_DIRS="/opt/cleanstream/deploy"
# shellcheck disable=SC1091
[ -f /etc/cleanstream-maintain.conf ] && . /etc/cleanstream-maintain.conf

if [ "${1:-}" = "--install" ]; then
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q unattended-upgrades
  dpkg-reconfigure -f noninteractive unattended-upgrades
  install -m 755 "$0" /usr/local/sbin/cleanstream-maintain
  cat > /etc/cron.d/cleanstream-maintain <<CRON
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 4 * * 0 root /usr/local/sbin/cleanstream-maintain >> $LOG 2>&1
CRON
  echo "Installed. Nightly security updates are on, and maintenance runs every Sunday at 04:17."
  echo "Run it now with: /usr/local/sbin/cleanstream-maintain"
  exit 0
fi

echo "=== Maintenance $(date) ==="

# 1. Backup (a failed or empty dump is removed so it never replaces a good one)
mkdir -p "$BACKUP_DIR"
FILE="$BACKUP_DIR/cleanstream-$(date +%F).sql"
if docker exec cleanstream-postgres-1 pg_dump -U cleanstream cleanstream > "$FILE" && [ -s "$FILE" ]; then
  echo "Backup: $FILE ($(du -h "$FILE" | cut -f1))"
else
  echo "Backup FAILED"
  rm -f "$FILE"
fi
ls -1t "$BACKUP_DIR"/cleanstream-*.sql 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm --

# 2. Updates (keeps existing configuration files when a package asks)
apt-get update -q
DEBIAN_FRONTEND=noninteractive apt-get -y -q \
  -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade
apt-get -y -q autoremove

# 3. Containers: newest images of the same versions, rebuilt with fresh base images.
#    The compose files pin major versions (e.g. postgres:16), so data formats do not change.
for dir in $COMPOSE_DIRS; do
  if [ -d "$dir" ]; then
    echo "Refreshing containers in $dir"
    (cd "$dir" && docker compose pull --ignore-buildable -q && docker compose build --pull -q && docker compose up -d) \
      || echo "Refreshing $dir FAILED (the old containers keep running)"
  fi
done
sleep 60
docker ps --format '{{.Names}}: {{.Status}}'

# 4. Disk space
docker image prune -f
docker builder prune -f

# 5. Restart when an update needs it
if [ -f /var/run/reboot-required ]; then
  echo "An update needs a restart: restarting in 1 minute"
  shutdown -r +1 "CleanStream weekly maintenance restart"
else
  echo "No restart needed"
fi
echo "=== Done $(date) ==="
