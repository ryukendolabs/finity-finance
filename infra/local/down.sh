#!/usr/bin/env bash
# Stops and disables the local Finity services installed by up.sh.
set -euo pipefail
SERVICES=(finity-lend-keeper finity-web finity-api finity-indexer finity-bot finity-relayer@1 finity-relayer@2 finity-relayer@3)
systemctl --user disable --now "${SERVICES[@]}" 2>/dev/null || true
echo "stopped ${SERVICES[*]}"
