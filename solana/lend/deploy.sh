#!/usr/bin/env bash
# Deploys Finity Lend (solana/lend) to mainnet or devnet, or upgrades it to the teardown build at the end.
#
#   lend/deploy.sh mainnet               # live build; asks before sending anything
#   lend/deploy.sh devnet --yes
#   lend/deploy.sh mainnet --teardown    # replace the live program with the shutdown build (then `pnpm lend teardown`)
#
# Keys (never in the repo):
#   ~/.config/finity/finity-lend-program.json   program address keypair (He1CGvMi…)
#   ~/.config/finity/mainnet-authority.json     payer and upgrade authority on mainnet
#                                               (devnet uses SOLANA_WALLET or ~/.config/solana/id.json)
# RPC: LEND_RPC_URL, else the cluster's public endpoint.
#
# Cost (rent is a refundable deposit): program data ≈ 0.0486 SOL + program account 0.0008 SOL. The upload buffer's
# rent is paid first and moved into the program by the final deploy step, so the peak is the net cost. The
# teardown build is smaller than the live one, so that upgrade needs no extra rent (its buffer is refunded).
# Deploy the final live build the first time: growing a deployed program now needs ExtendProgram, which adds at least
# 10,240 bytes (≈0.053 SOL of rent on mainnet).
set -euo pipefail
cd "$(dirname "$0")"

CLUSTER="${1:-}"
shift || true
YES=""
TEARDOWN=""
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;;
    --teardown) TEARDOWN=1 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done
case "$CLUSTER" in
  mainnet) URL="${LEND_RPC_URL:-https://api.mainnet-beta.solana.com}"; PAYER="${LEND_WALLET:-$HOME/.config/finity/mainnet-authority.json}" ;;
  devnet)  URL="${LEND_RPC_URL:-https://api.devnet.solana.com}"; PAYER="${LEND_WALLET:-${SOLANA_WALLET:-$HOME/.config/solana/id.json}}" ;;
  *) echo "usage: $0 mainnet|devnet [--yes] [--teardown]" >&2; exit 2 ;;
esac
PROGRAM_KEY="$HOME/.config/finity/finity-lend-program.json"
[ -f "$PROGRAM_KEY" ] || { echo "missing $PROGRAM_KEY" >&2; exit 1; }
[ -f "$PAYER" ] || { echo "missing payer keypair $PAYER (create with: solana-keygen new -o $PAYER && chmod 600 $PAYER)" >&2; exit 1; }

echo "== build (live, teardown, full) and test"
cargo build-sbf --features teardown -- --target-dir target/td >/dev/null 2>&1
cargo build-sbf --features full -- --target-dir target/full >/dev/null 2>&1
cargo build-sbf >/dev/null 2>&1
cargo test --quiet 2>&1 | grep -E "test result" | tail -2
if cargo test --quiet 2>&1 | grep -q "FAILED"; then echo "tests failed; not deploying" >&2; exit 1; fi

if [ -n "$TEARDOWN" ]; then SO=target/td/deploy/finity_lend.so; else SO=target/deploy/finity_lend.so; fi
SIZE=$(stat -c %s "$SO")
PROGRAM_ID=$(solana-keygen pubkey "$PROGRAM_KEY")
PAYER_ID=$(solana-keygen pubkey "$PAYER")
lamports() { solana rent "$1" --lamports -u "$URL" | awk '/lamports/{print $(NF-1)}'; }
sol() { awk -v l="$1" 'BEGIN{printf "%.6f", l/1e9}'; }
BAL=$(solana balance "$PAYER_ID" --lamports -u "$URL" | awk '{print $1}')
# Write transactions: ~1 KB each at 5000 lamports plus a small priority fee, the deploy, and slack.
FEES=$(( (SIZE / 900 + 4) * 7000 + 100000 ))
# A fee payer must keep its rent-exempt minimum (0 bytes of data) after every transaction.
FLOOR=$(lamports 0)

if [ -n "$TEARDOWN" ]; then
  solana program show "$PROGRAM_ID" -u "$URL" >/dev/null 2>&1 || { echo "Program $PROGRAM_ID is not deployed on $CLUSTER" >&2; exit 1; }
  # The buffer holds the teardown build until the upgrade, which refunds it.
  NEED=$(( $(lamports $((SIZE + 37))) + FEES + FLOOR ))
  cat <<EOF
== teardown upgrade ($CLUSTER)
  program        $PROGRAM_ID  (teardown build, $SIZE bytes)
  authority      $PAYER_ID, balance $(sol "$BAL") SOL
  needs briefly  $(sol "$NEED") SOL (buffer rent, refunded by the upgrade, + fees + the payer's minimum)
After it: borrowing and repaying stop; run \`pnpm lend teardown --cluster $CLUSTER\` to return everything.
EOF
else
  if solana program show "$PROGRAM_ID" -u "$URL" >/dev/null 2>&1; then
    echo "Program $PROGRAM_ID is already deployed on $CLUSTER:"
    solana program show "$PROGRAM_ID" -u "$URL"
    exit 0
  fi
  DATA_RENT=$(lamports $((SIZE + 45)))
  PROG_RENT=$(lamports 36)
  NET=$((DATA_RENT + PROG_RENT + FEES))
  NEED=$((NET + FLOOR))
  cat <<EOF
== deploy plan ($CLUSTER)
  program         $PROGRAM_ID  (live build, $SIZE bytes)
  payer/authority $PAYER_ID
  balance         $(sol "$BAL") SOL
  net cost        $(sol "$NET") SOL  (program data $(sol "$DATA_RENT") + program $(sol "$PROG_RENT") + fees)
  needs           $(sol "$NEED") SOL  (net cost + the payer's minimum balance)
Then \`pnpm lend seed --cluster $CLUSTER\` adds ≈ 0.0143 SOL on mainnet (markets account, USDC vault, 6 xStock vaults)
or ≈ 0.0215 SOL on devnet (also the test mints).
EOF
fi
if [ "$BAL" -lt "$NEED" ]; then
  echo "Not enough SOL: send at least $(sol $((NEED - BAL))) SOL to $PAYER_ID on $CLUSTER." >&2
  exit 1
fi
if [ -z "$YES" ]; then
  read -r -p "Send to $CLUSTER? [y/N] " ok
  [ "$ok" = "y" ] || { echo "aborted"; exit 1; }
fi

echo "== deploying"
if ! solana program deploy "$SO" \
  --program-id "$PROGRAM_KEY" \
  --keypair "$PAYER" \
  --upgrade-authority "$PAYER" \
  --with-compute-unit-price 1000 \
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
if [ -n "$TEARDOWN" ]; then echo "Next: cd .. && pnpm lend teardown --cluster $CLUSTER"; else echo "Next: cd .. && pnpm lend seed --cluster $CLUSTER"; fi
