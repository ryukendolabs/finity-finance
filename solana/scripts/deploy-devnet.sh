#!/usr/bin/env bash
# Upgrade Finity on devnet and bring everything in line, end to end:
#   balance check → program upgrade → loaders (risk, pools, oracle + guardian; all idempotent) → rebuild and restart
#   the local services (web + keeper bot) → smoke test on devnet.
# Usage: solana/scripts/deploy-devnet.sh          (uses SOLANA_RPC_URL from ~/.config/finity/env when present)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(cd .. && pwd)"
ENV_FILE="$HOME/.config/finity/env"
[[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE"; set +a; }
RPC="${SOLANA_RPC_URL:-https://api.devnet.solana.com}"
PROGRAM_ID="$(solana address -k target/deploy/finity-keypair.json)"
SO=target/deploy/finity.so

echo "== build"
anchor build >/dev/null
pnpm -s sync-idl

echo "== funds"
size=$(stat -c %s "$SO")
current=$(solana program show "$PROGRAM_ID" --url "$RPC" 2>/dev/null | awk '/Data Length/{print $3}')
buffer=$(solana rent "$size" | awk '/Rent-exempt/{print $3}')
grow=0
if [[ -n "$current" && "$size" -gt "$current" ]]; then grow=$(solana rent $(( size - current > 10240 ? size - current : 10240 )) | awk '/Rent-exempt/{print $3}'); fi
need=$(python3 -c "print(round($buffer + $grow + 0.3, 2))")
have=$(solana balance --url "$RPC" | awk '{print $1}')
echo "program ${size} bytes: buffer ${buffer} SOL (refunded) + growth ${grow} SOL + ~0.3 SOL accounts = ${need} SOL; wallet has ${have} SOL"
python3 -c "import sys; sys.exit(0 if $have >= $need else 1)" || { echo "not enough SOL: send $(python3 -c "print(round($need - $have + 0.2, 2))") SOL to $(solana address)"; exit 1; }

echo "== upgrade"
# A larger program first grows its account; the loader extends by at least 10,240 bytes at a time.
if [[ -n "$current" && "$size" -gt "$current" ]]; then
  extra=$(( size - current )); (( extra < 10240 )) && extra=10240
  solana program extend "$PROGRAM_ID" "$extra" --url "$RPC" | tail -1
fi
solana program deploy "$SO" --program-id target/deploy/finity-keypair.json --url "$RPC" | tail -1

echo "== loaders"
for step in load-risk load-pool load-oracle; do
  for try in 1 2 3; do pnpm -s "$step" 2>&1 | grep -v bigint | tail -3 && break || { echo "retry $step ($try)"; sleep 5; }; done
done

echo "== services"
"$ROOT/infra/local/up.sh"

echo "== smoke"
pnpm -s smoke 2>&1 | grep -vE "bigint|429|Retrying" | tail -2
echo "done: $(solana balance --url "$RPC") left"
