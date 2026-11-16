#!/usr/bin/env bash
# Deploys Finity V2 (solana/v2) to mainnet or devnet.
#
#   v2/deploy.sh mainnet        # asks before sending anything
#   v2/deploy.sh devnet --yes
#
# Keys (never in the repo):
#   ~/.config/finity/finity-v2-program.json   program address keypair (GvaQuq1t…)
#   ~/.config/finity/mainnet-authority.json     payer, upgrade authority and market authority on mainnet
#                                               (devnet uses SOLANA_WALLET or ~/.config/solana/id.json)
# RPC: V2_RPC_URL, else the cluster's public endpoint.
#
# Cost (rent is a refundable deposit): program data ≈ 0.0347 SOL + program account 0.0008 SOL, plus a temporary
# buffer of the same size that the deploy refunds. `pnpm v2 seed` then adds 0.0011 SOL per market.
set -euo pipefail
cd "$(dirname "$0")"

CLUSTER="${1:-}"
YES="${2:-}"
case "$CLUSTER" in
  mainnet) URL="${V2_RPC_URL:-https://api.mainnet-beta.solana.com}"; PAYER="${V2_WALLET:-$HOME/.config/finity/mainnet-authority.json}" ;;
  devnet)  URL="${V2_RPC_URL:-https://api.devnet.solana.com}"; PAYER="${V2_WALLET:-${SOLANA_WALLET:-$HOME/.config/solana/id.json}}" ;;
  *) echo "usage: $0 mainnet|devnet [--yes]" >&2; exit 2 ;;
esac
PROGRAM_KEY="$HOME/.config/finity/finity-v2-program.json"
[ -f "$PROGRAM_KEY" ] || { echo "missing $PROGRAM_KEY" >&2; exit 1; }
[ -f "$PAYER" ] || { echo "missing payer keypair $PAYER (create with: solana-keygen new -o $PAYER && chmod 600 $PAYER)" >&2; exit 1; }

echo "== build and test"
cargo build-sbf >/dev/null 2>&1
cargo test --quiet 2>&1 | grep -E "test result" | tail -2
SO=target/deploy/finity_v2.so
SIZE=$(stat -c %s "$SO")

PROGRAM_ID=$(solana-keygen pubkey "$PROGRAM_KEY")
PAYER_ID=$(solana-keygen pubkey "$PAYER")
lamports() { solana rent "$1" --lamports -u "$URL" | awk '/lamports/{print $(NF-1)}'; }
DATA_RENT=$(lamports $((SIZE + 45)))
PROG_RENT=$(lamports 36)
# Write transactions: ~1 KB each at 5000 lamports, plus the deploy and slack for priority fees.
FEES=$(( (SIZE / 900 + 4) * 5000 + 200000 ))
NET=$((DATA_RENT + PROG_RENT + FEES))
# The final deploy instruction drains the buffer into the payer before funding the program data, so the peak is the
# net cost (the buffer's rent is just paid earlier); keep 0.002 SOL of margin.
NEED=$((NET + 2000000))
BAL=$(solana balance "$PAYER_ID" --lamports -u "$URL" | awk '{print $1}')
sol() { awk -v l="$1" 'BEGIN{printf "%.6f", l/1e9}'; }

if solana program show "$PROGRAM_ID" -u "$URL" >/dev/null 2>&1; then
  echo "Program $PROGRAM_ID is already deployed on $CLUSTER:"
  solana program show "$PROGRAM_ID" -u "$URL"
  echo "To upgrade it, run: solana program deploy $SO --program-id $PROGRAM_ID --keypair $PAYER -u $URL"
  exit 0
fi

cat <<EOF
== deploy plan ($CLUSTER)
  program        $PROGRAM_ID  ($SIZE bytes)
  payer/authority $PAYER_ID
  balance        $(sol "$BAL") SOL
  needs          $(sol "$NEED") SOL  (net cost + 0.002 margin)
  net cost       $(sol "$NET") SOL  (program data $(sol "$DATA_RENT") + program $(sol "$PROG_RENT") + fees)
EOF
if [ "$BAL" -lt "$NEED" ]; then
  echo "Not enough SOL: send at least $(sol $((NEED - BAL))) SOL to $PAYER_ID on $CLUSTER." >&2
  exit 1
fi
if [ "$YES" != "--yes" ]; then
  read -r -p "Deploy to $CLUSTER? [y/N] " ok
  [ "$ok" = "y" ] || { echo "aborted"; exit 1; }
fi

echo "== deploying"
if ! solana program deploy "$SO" \
  --program-id "$PROGRAM_KEY" \
  --keypair "$PAYER" \
  --upgrade-authority "$PAYER" \
  --with-compute-unit-price 10000 \
  --max-sign-attempts 20 \
  --use-rpc \
  -u "$URL"; then
  cat >&2 <<EOF
Deploy failed part-way. Its buffer still holds rent; list and reclaim it with:
  solana program show --buffers --keypair $PAYER -u $URL
  solana program close --buffers --keypair $PAYER -u $URL
then run this script again.
EOF
  exit 1
fi
solana program show "$PROGRAM_ID" -u "$URL"
echo "Balance now: $(solana balance "$PAYER_ID" -u "$URL")"
echo "Next: cd .. && pnpm v2 seed --cluster $CLUSTER"
