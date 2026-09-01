#!/usr/bin/env bash
# Double-clickable launcher. Add it as a Login Item
#   (System Settings → General → Login Items → "+"), and it starts the monitor
#   on every login — Login Items run in your GUI session, so folder-access
#   (Desktop/Documents) works, unlike a raw LaunchAgent.
#
# It also keeps the Mac awake while the monitor runs (caffeinate).
cd "$(dirname "$0")/.."
exec caffeinate -s bash -c '
  ./scripts/local-up.sh
  # keep this window/agent alive so caffeinate stays in effect and we can
  # re-check every 5 min (idempotent — only restarts what died)
  while true; do sleep 300; ./scripts/local-up.sh >/dev/null 2>&1; done
'
