#!/usr/bin/env bash
# Long-running supervisor: keeps the Mac awake (caffeinate) and re-runs the
# idempotent local-up.sh every 5 min so a crashed process recovers. Started
# detached by cron-monitor.command; not meant to be run directly.
cd "$(dirname "$0")/.."

# kill-switch: `touch .run/DISABLED` stops the supervisor from starting.
# (local-up.sh re-checks it every loop too, so an existing supervisor also stops
# doing anything once the file appears.) Re-enable with `rm .run/DISABLED`.
if [ -e ".run/DISABLED" ]; then
  echo "local-supervisor: DISABLED (.run/DISABLED present) — not starting. rm it to re-enable."
  exit 0
fi

exec caffeinate -s bash -c '
  while true; do
    ./scripts/local-up.sh >> .run/supervisor.log 2>&1
    sleep 300
  done
'
