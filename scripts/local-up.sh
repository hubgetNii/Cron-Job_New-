#!/usr/bin/env bash
# Idempotent "keep the monitor running on this machine".
#
#   scripts/local-up.sh            start anything that isn't up
#   scripts/local-up.sh --status   just report
#
# Safe to run repeatedly (launchd fires it on login and every few minutes).
# Logs go to fintech-cron-monitor/.run/*.log

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
RUN="$ROOT/.run"
mkdir -p "$RUN"

running() { pgrep -f "$1" >/dev/null 2>&1; }

start() {   # start <name> <match-pattern> <command...>
  local name="$1" pat="$2"; shift 2
  if running "$pat"; then
    echo "  ✓ $name already running"
  else
    echo "  ▶ starting $name"
    nohup "$@" >"$RUN/$name.log" 2>&1 </dev/null &
    disown
  fi
}

echo "[$(date '+%F %T')] local-up"

# 1. datastores
if ! docker compose ps --status running 2>/dev/null | grep -q postgres; then
  echo "  ▶ docker compose up -d (postgres + redis)"
  docker compose up -d >/dev/null
else
  echo "  ✓ postgres + redis up"
fi

[ "${1:-}" = "--status" ] && { pgrep -fl 'tsx watch src/|/vite' | grep -v grep || echo "  (no node procs)"; exit 0; }

# 2. the three backend processes + the dashboard
start api       'tsx watch src/server.ts'         npm run dev
start scheduler 'tsx watch src/scheduler/main.ts' npm run dev:scheduler
start watchdog  'tsx watch src/watchdog/main.ts'  npm run dev:watchdog
start web       'web/node_modules/.bin/vite'      bash -c 'cd web && exec npm run dev'

# 3. quick health probe
sleep 2
if curl -sf -m 4 localhost:3000/health >/dev/null 2>&1; then
  echo "  ✓ API healthy on :3000   ·   dashboard on :5173"
else
  echo "  … API not answering yet (first boot can take ~10s)"
fi
