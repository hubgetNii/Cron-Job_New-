#!/usr/bin/env bash
# Stop the local monitor processes (leaves postgres + redis running).
#   scripts/local-down.sh          stop the node processes
#   scripts/local-down.sh --all    also `docker compose down`
set -euo pipefail
cd "$(dirname "$0")/.."

pkill -f 'tsx watch src/'            2>/dev/null && echo "stopped api / scheduler / watchdog" || true
pkill -f 'web/node_modules/.bin/vite' 2>/dev/null && echo "stopped dashboard" || true

if [ "${1:-}" = "--all" ]; then
  docker compose down
  echo "stopped postgres + redis"
fi
