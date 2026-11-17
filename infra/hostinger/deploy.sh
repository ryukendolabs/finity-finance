#!/usr/bin/env bash
# Deploys Finity to the Hostinger VPS. Builds here, ships only what runs (~75 MB): the standalone web server and one
# bundled file per backend service. Nothing is built on the server.
#
#   infra/hostinger/deploy.sh                  build, ship, restart
#   infra/hostinger/deploy.sh --setup          first time: also prepare the server (server-setup.sh)
#   infra/hostinger/deploy.sh --keys           also copy keys and settings from ~/.config (first time, or after a change)
#   infra/hostinger/deploy.sh --data           also copy the indexer and alert databases (stop local services first)
#
# SSH: host alias FINITY_HOST (default finity-vps, see ~/.ssh/config). Server name for HTTPS: DOMAIN.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HOST="${FINITY_HOST:-finity-vps}"
DOMAIN="${DOMAIN:-srv2163833.hstgr.cloud}"
OUT="$REPO/infra/hostinger/.dist"
SETUP="" KEYS="" DATA=""
for a in "$@"; do
  case "$a" in
    --setup) SETUP=1 ;;
    --keys) KEYS=1 ;;
    --data) DATA=1 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done

echo "== build"
(cd "$REPO" && NEXT_STANDALONE=1 pnpm --filter @finity/web exec next build >/dev/null)
rm -rf "$OUT" && mkdir -p "$OUT/web" "$OUT/backend"
rsync -a "$REPO/apps/web/.next-deploy/standalone/" "$OUT/web/"
rsync -a "$REPO/apps/web/.next-deploy/static/" "$OUT/web/apps/web/.next-deploy/static/"
rsync -a "$REPO/apps/web/public/" "$OUT/web/apps/web/public/"
ESBUILD="$(ls -d "$REPO"/node_modules/.pnpm/esbuild@0.28.*/node_modules/esbuild | head -1)/bin/esbuild"
(cd "$REPO/solana" && "$ESBUILD" scripts/relayer.ts scripts/bot.ts scripts/indexer.ts scripts/api.ts scripts/lend.ts \
  --bundle --platform=node --format=esm --target=node24 --outdir="$OUT/backend" --out-extension:.js=.mjs \
  --external:better-sqlite3 --log-level=warning \
  --banner:js="import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);")
SQLITE_VERSION="$(node -p "require('$REPO/node_modules/.pnpm/node_modules/better-sqlite3/package.json').version")"
printf '{ "private": true, "type": "module", "dependencies": { "better-sqlite3": "%s" } }\n' "$SQLITE_VERSION" > "$OUT/backend/package.json"
du -sh "$OUT/web" "$OUT/backend" | sed 's#'"$OUT"'/##'

echo "== ship to $HOST"
ssh "$HOST" 'install -d /opt/finity/web /opt/finity/backend /opt/finity/deploy'
rsync -az --delete "$OUT/web/" "$HOST:/opt/finity/web/"
rsync -az --delete --exclude node_modules --exclude package-lock.json "$OUT/backend/" "$HOST:/opt/finity/backend/"
rsync -az --delete "$REPO/infra/hostinger/server-setup.sh" "$REPO/infra/hostinger/nginx-finity.conf" "$REPO/infra/hostinger/systemd" "$HOST:/opt/finity/deploy/"

if [[ -n "$SETUP" ]]; then
  echo "== server setup"
  ssh "$HOST" "DOMAIN=$DOMAIN bash /opt/finity/deploy/server-setup.sh"
fi

if [[ -n "$KEYS" ]]; then
  echo "== keys and settings (mode 600, owned by finity)"
  C="$HOME/.config/finity"
  { cat "$C/env"; echo "TRUST_PROXY_HEADERS=1"; echo "FINITY_APP_URL=https://$DOMAIN"; } | ssh "$HOST" 'cat > /home/finity/.config/finity/env'
  for f in relayer-1.json relayer-2.json relayer-3.json mainnet-authority.json session_secret vapid.json; do
    [[ -f "$C/$f" ]] && rsync -a "$C/$f" "$HOST:/home/finity/.config/finity/$f"
  done
  rsync -a "$HOME/.config/solana/id.json" "$HOST:/home/finity/.config/solana/id.json"
  ssh "$HOST" 'chown -R finity:finity /home/finity/.config && find /home/finity/.config -type f -exec chmod 600 {} +'
fi

if [[ -n "$DATA" ]]; then
  echo "== databases"
  D="$HOME/.local/share/finity"
  ssh "$HOST" 'systemctl stop finity-indexer finity-api finity-web finity-bot 2>/dev/null || true'
  rsync -a "$D/" "$HOST:/home/finity/.local/share/finity/"
  ssh "$HOST" 'chown -R finity:finity /home/finity/.local/share/finity'
fi

echo "== install and restart"
ssh "$HOST" 'set -e
cd /opt/finity/backend
if [ ! -d node_modules/better-sqlite3 ] || ! cmp -s package.json node_modules/.deployed-package.json; then
  PATH=/opt/node/bin:$PATH npm install --omit=dev --no-audit --no-fund --loglevel=error
  cp package.json node_modules/.deployed-package.json
fi
cp /opt/finity/deploy/systemd/*.service /etc/systemd/system/
systemctl daemon-reload
SERVICES="finity-relayer@1 finity-relayer@2 finity-relayer@3 finity-bot finity-indexer finity-api finity-web finity-lend-keeper"
systemctl enable $SERVICES >/dev/null 2>&1
systemctl restart $SERVICES
sleep 6
for s in $SERVICES; do printf "%-22s %s\n" "$s" "$(systemctl is-active $s)"; done
curl -s -o /dev/null -w "web  %{http_code}\n" http://127.0.0.1:3100/
curl -s -o /dev/null -w "api  %{http_code}\n" http://127.0.0.1:8787/v1/health
du -sh /opt/finity /opt/node 2>/dev/null'
echo "Live: https://$DOMAIN"
