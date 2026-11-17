#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 VPS for Finity (run as root on the server; safe to re-run).
# Minimal footprint: Node.js from the official tarball (no build tools), nginx + certbot, a locked-down `finity` user.
# Other software on the server is left alone.
set -euo pipefail
NODE_VERSION="${NODE_VERSION:-v24.21.0}"
DOMAIN="${DOMAIN:-srv2163833.hstgr.cloud}"

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends nginx certbot python3-certbot-nginx xz-utils rsync ca-certificates curl >/dev/null

echo "== node $NODE_VERSION"
if [[ "$(/opt/node/bin/node --version 2>/dev/null)" != "$NODE_VERSION" ]]; then
  tmp=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" -o "$tmp/node.tar.xz"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " node-$NODE_VERSION-linux-x64.tar.xz\$" SHASUMS256.txt | sed "s/node-$NODE_VERSION-linux-x64.tar.xz/node.tar.xz/" | sha256sum -c -)
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf "$tmp/node.tar.xz" -C /opt/node --strip-components=1
  # Only the runtime is needed: drop headers and docs.
  rm -rf /opt/node/include /opt/node/share /opt/node/CHANGELOG.md /opt/node/README.md
  rm -rf "$tmp"
fi
/opt/node/bin/node --version

echo "== user and folders"
id finity >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/finity --shell /usr/sbin/nologin finity
install -d -o finity -g finity -m 700 /home/finity/.config /home/finity/.config/finity /home/finity/.config/solana
install -d -o finity -g finity -m 750 /home/finity/.local /home/finity/.local/share /home/finity/.local/share/finity
install -d -o root -g root -m 755 /opt/finity /opt/finity/web /opt/finity/backend

echo "== firewall (adds web ports; existing rules stay)"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi

echo "== nginx site for $DOMAIN"
sed "s/@DOMAIN@/$DOMAIN/g" /opt/finity/deploy/nginx-finity.conf > /etc/nginx/sites-available/finity
ln -sf /etc/nginx/sites-available/finity /etc/nginx/sites-enabled/finity
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "== https"
if [[ ! -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
fi
echo "server ready"
