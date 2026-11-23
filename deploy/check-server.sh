#!/usr/bin/env bash
# Read-only check of the server before installing CleanStream.
# It changes nothing. Run with:  bash check-server.sh

echo "== System"
uname -sr
. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"
echo "CPU cores: $(nproc)"
free -h | awk '/Mem:/ {print "Memory: " $2 " total, " $7 " available"}'
df -h / | awk 'NR==2 {print "Disk: " $4 " free of " $2}'

echo
echo "== Docker"
if command -v docker >/dev/null 2>&1; then
  docker --version
  docker compose version 2>/dev/null || echo "Docker Compose plugin: NOT installed"
else
  echo "Docker: NOT installed"
fi

echo
echo "== Web ports (80 = http, 443 = https, 7000 = CleanStream)"
for port in 80 443 7000; do
  user=$(sudo ss -ltnp "sport = :$port" 2>/dev/null | awk 'NR>1 {print $NF}' | head -1)
  if [ -n "$user" ]; then echo "Port $port: IN USE by $user"; else echo "Port $port: free"; fi
done

echo
echo "== Web servers"
for svc in nginx apache2 httpd caddy; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then echo "$svc: running"; fi
done
docker ps --format '{{.Names}} ({{.Image}}) {{.Ports}}' 2>/dev/null | grep -E ':(80|443)->' && echo "(a Docker container uses port 80/443)"

echo
echo "== Public IP (for your domain's DNS record)"
curl -s -4 --max-time 5 https://ifconfig.me || echo "unknown"
echo
