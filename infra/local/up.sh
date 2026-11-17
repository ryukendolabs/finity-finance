#!/usr/bin/env bash
# Hosts the Finity Solana stack on this machine as systemd user services:
#   finity-relayer@1..3  price relayers, one key each (~/.config/finity/relayer-N.json), on 127.0.0.1:7701..7703
#   finity-bot           keeper (needs ~/.config/solana/id.json = the keeper/admin key); forwards relayer reports
#   finity-indexer       history into ~/.local/share/finity/index.db
#   finity-api           public read-only API on http://127.0.0.1:$API_PORT (/v1/openapi.json, /metrics)
#   finity-web           production web app on http://localhost:$PORT
#   finity-lend-keeper   Finity Lend price keeper on mainnet (once the authority key exists and `pnpm lend seed` has
#                        written that cluster into solana/client/lend.json; LEND_CLUSTER=devnet to rehearse)
# Usage: infra/local/up.sh [--no-build]     Logs: journalctl --user -fu finity-bot   Stop: infra/local/down.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PORT:-3000}"
API_PORT="${API_PORT:-8787}"
NODE_BIN="$(dirname "$(command -v node)")"
UNITS="$HOME/.config/systemd/user"
RELAYERS=(1 2 3)
RELAYER_URLS="$(printf 'http://127.0.0.1:%s,' 7701 7702 7703)"; RELAYER_URLS="${RELAYER_URLS%,}"
LEND_CLUSTER="${LEND_CLUSTER:-mainnet}"

# Private RPC (e.g. QuickNode): SOLANA_RPC_URL for the keeper, NEXT_PUBLIC_SOLANA_RPC_URL for the browser.
ENV_FILE="$HOME/.config/finity/env"
if [[ -f "$ENV_FILE" ]]; then set -a; source "$ENV_FILE"; set +a; echo "using RPC settings from $ENV_FILE"; fi
for i in "${RELAYERS[@]}"; do
  [[ -f "$HOME/.config/finity/relayer-$i.json" ]] || { echo "missing relayer key $i: run (cd solana && pnpm load-oracle)"; exit 1; }
done

if [[ "${1:-}" != "--no-build" ]]; then
  echo "building web app…"
  (cd "$REPO" && pnpm install --frozen-lockfile >/dev/null && pnpm --filter @finity/web build >/dev/null)
fi

mkdir -p "$UNITS"
for u in finity-bot finity-web finity-indexer finity-api finity-relayer@ finity-lend-keeper; do
  sed -e "s|@REPO@|$REPO|g" -e "s|@NODE_BIN@|$NODE_BIN|g" -e "s|@PORT@|$PORT|g" -e "s|@API_PORT@|$API_PORT|g" \
      -e "s|@RELAYER_URLS@|$RELAYER_URLS|g" -e "s|@LEND_CLUSTER@|$LEND_CLUSTER|g" "$REPO/infra/local/$u.service" > "$UNITS/$u.service"
done
systemctl --user daemon-reload
SERVICES=(finity-relayer@1 finity-relayer@2 finity-relayer@3 finity-bot finity-indexer finity-api finity-web)
# The Lend keeper runs once its authority key exists and that cluster is seeded.
LEND_KEY="${LEND_WALLET:-$HOME/.config/finity/mainnet-authority.json}"
[[ "$LEND_CLUSTER" == devnet ]] && LEND_KEY="${LEND_WALLET:-$HOME/.config/solana/id.json}"
if [[ -f "$LEND_KEY" ]] && node -e "process.exit(require('$REPO/solana/client/lend.json').clusters['$LEND_CLUSTER'] ? 0 : 1)"; then
  SERVICES+=(finity-lend-keeper)
else
  echo "finity-lend-keeper not started: needs $LEND_KEY and a Lend deployment on $LEND_CLUSTER (pnpm lend seed --cluster $LEND_CLUSTER)"
fi
systemctl --user enable --now "${SERVICES[@]}" >/dev/null
systemctl --user restart "${SERVICES[@]}"
echo "up: web http://localhost:$PORT/app/markets · api http://127.0.0.1:$API_PORT/v1/health · logs: journalctl --user -fu finity-bot"
