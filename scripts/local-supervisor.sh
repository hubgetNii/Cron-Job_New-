#!/usr/bin/env bash
# Long-running supervisor: keeps the Mac awake (caffeinate) and re-runs the
# idempotent local-up.sh every 5 min so a crashed process recovers. Started
# detached by cron-monitor.command; not meant to be run directly.
cd "$(dirname "$0")/.."
exec caffeinate -s bash -c '
  while true; do
    ./scripts/local-up.sh >> .run/supervisor.log 2>&1
    sleep 300
  done
'
