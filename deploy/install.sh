#!/usr/bin/env bash
# GEAMS install for Ubuntu/Debian. Run as root from the folder that holds geams-server.js:
#   sudo bash deploy/install.sh geams.example.org [caddy|nginx]
# Safe to run again: it never overwrites your /etc/geams/geams.env or your data.
set -euo pipefail
DOMAIN="${1:-}"; PROXY="${2:-caddy}"
[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }
[ -n "$DOMAIN" ] || { echo "Usage: sudo bash deploy/install.sh your.domain.name [caddy|nginx]"; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"; [ -f "$SRC/geams-server.js" ] || { echo "geams-server.js not found in $SRC"; exit 1; }
command -v node >/dev/null || { echo "Installing Node.js 20"; apt-get update -y; apt-get install -y curl ca-certificates; curl -fsSL https://deb.nodesource.com/setup_20.x | bash -; apt-get install -y nodejs; }
NODEV=$(node -p "process.versions.node.split('.')[0]"); [ "$NODEV" -ge 18 ] || { echo "Node 18 or newer is needed (found $NODEV)"; exit 1; }
id geams >/dev/null 2>&1 || useradd --system --home /var/lib/geams --shell /usr/sbin/nologin geams
mkdir -p /opt/geams /var/lib/geams /etc/geams
cp -r "$SRC"/. /opt/geams/ ; rm -rf /opt/geams/deploy/.git
chown -R root:root /opt/geams; chown -R geams:geams /var/lib/geams
if [ ! -f /etc/geams/geams.env ]; then
  cp /opt/geams/deploy/geams.env.example /etc/geams/geams.env
  PW=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | cut -c1-24); BP=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | cut -c1-24)
  sed -i "s|CHANGE-ME-to-a-long-passphrase|$PW|; s|CHANGE-ME-and-store-this-somewhere-else-too|$BP|" /etc/geams/geams.env
  chmod 600 /etc/geams/geams.env; chown root:root /etc/geams/geams.env
  echo "=============================================================="
  echo " HQ owner password:      $PW"
  echo " Backup passphrase:      $BP"
  echo " WRITE BOTH DOWN NOW and keep a copy away from this server."
  echo " Without the backup passphrase, backups cannot be restored."
  echo "=============================================================="
fi
cp /opt/geams/deploy/geams.service /etc/systemd/system/geams.service
systemctl daemon-reload; systemctl enable --now geams
if [ "$PROXY" = nginx ]; then
  apt-get install -y nginx certbot python3-certbot-nginx
  sed "s/geams.example.org/$DOMAIN/g" /opt/geams/deploy/nginx-geams.conf > /etc/nginx/sites-available/geams
  echo "Get the certificate first (certbot certonly --nginx -d $DOMAIN), then:"
  echo "  ln -s /etc/nginx/sites-available/geams /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx"
else
  command -v caddy >/dev/null || { apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y; apt-get install -y caddy; }
  sed "s/geams.example.org/$DOMAIN/g" /opt/geams/deploy/Caddyfile > /etc/caddy/Caddyfile
  systemctl reload caddy || systemctl restart caddy
fi
sleep 3
curl -fsS http://127.0.0.1:8080/api/health && echo && echo "GEAMS is running. Open https://$DOMAIN/ and log in to HQ." || { echo "GEAMS did not answer. Look:  journalctl -u geams -n 50"; exit 1; }
echo "Next: take a backup in HQ, then practise restoring it (deploy/DEPLOY.md, section 5)."
