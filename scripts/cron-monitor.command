#!/usr/bin/env bash
# Double-clickable launcher / Login Item.
#
#   Add via: System Settings → General → Login Items →
#            "Open at Login" section → "+" → pick this file.
#   First run: right-click in Finder → Open (clears the Gatekeeper prompt).
#
# It starts the monitor + a detached supervisor (keeps the Mac awake, restarts a
# crashed process every 5 min), then closes — no Terminal window left hanging.

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR/.."

if pgrep -f "$DIR/local-supervisor.sh" >/dev/null 2>&1 \
   || pgrep -f 'caffeinate -s bash -c' >/dev/null 2>&1; then
  echo "cron-monitor supervisor already running."
else
  nohup "$DIR/local-supervisor.sh" >/dev/null 2>&1 &
  disown
  echo "started cron-monitor supervisor (pid $!)"
fi

"$DIR/local-up.sh"          # bring everything up now too

echo
echo "Done — you can close this window."
sleep 3
