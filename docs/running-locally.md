# Running the stack locally

The monitor is **four Node processes** plus Postgres and Redis:

| Process | Command | Port | What it does |
| --- | --- | --- | --- |
| API | `npm run dev` | 3000 | REST API + dashboard backend |
| Scheduler | `npm run dev:scheduler` | – | the cron engine: fires checks, runs incidents, sends alerts, refreshes SLA |
| Watchdog | `npm run dev:watchdog` | – | independent dead-man's switch on the scheduler heartbeat |
| Dashboard | `cd web && npm run dev` | 5173 | React UI, proxies `/api` → 3000 |

Postgres runs on host **:5433**, Redis on **:6380** (remapped so they don't clash with a local install).

---

## First-time setup

```bash
cd fintech-cron-monitor
cp .env.example .env          # then fill in the values below
npm install
(cd web && npm install)

docker compose up -d          # postgres + redis
npm run migrate up            # apply all migrations to the dev DB
npm run db:test:setup         # create + migrate cronmon_test (only needed to run the test suite)
```

Minimum `.env` to boot with auth on:

```dotenv
DATABASE_URL=postgres://cronmon:cronmon@localhost:5433/cronmon
REDIS_URL=redis://localhost:6380
AUTH_ENABLED=true
JWT_SECRET=            # >= 16 chars — generate: openssl rand -hex 32
BOOTSTRAP_ADMIN_EMAIL=admin@yourorg.local
BOOTSTRAP_ADMIN_PASSWORD=       # >= 8 chars — choose a strong one
```

`.env` is gitignored — never commit real secrets. Only `.env.example`
(all-blank) is tracked.

For the quickest loop, set `AUTH_ENABLED=false` instead — every request then runs as a
synthetic admin and you can skip the login. (The API refuses this in `NODE_ENV=production`.)

Firebase push and the MPSMS target are optional — see
[`firebase-push-setup.md`](./firebase-push-setup.md) and run `npm run seed:mpsms`.

---

## Run it

Open **four terminals** in `fintech-cron-monitor/`:

```bash
# terminal 1
npm run dev

# terminal 2
npm run dev:scheduler

# terminal 3
npm run dev:watchdog

# terminal 4
cd web && npm run dev
```

Check it's alive:

```bash
curl -s localhost:3000/health | jq
curl -s localhost:3000/health/scheduler | jq        # "ok" once the scheduler has ticked
open http://localhost:5173                          # dashboard — log in with the bootstrap admin
```

### Keep it running (detached, self-healing)

```bash
scripts/local-up.sh      # starts docker + the 4 processes; idempotent, safe to repeat
scripts/local-up.sh --status
scripts/local-down.sh    # stop the node processes (add --all to stop postgres/redis too)
```

Logs land in `.run/*.log`. `.run/` is gitignored.

### Auto-start on login + auto-restart (macOS)

**If the repo is on your Desktop** (or Documents / Downloads), macOS TCC blocks a
LaunchAgent from reaching it. Use the Login Item instead:

1. **System Settings → General → Login Items**
2. In the **"Open at Login"** section (not "Allow in the Background"), click **"+"**
3. Navigate to `fintech-cron-monitor/scripts/` and pick **`cron-monitor.command`**
   (⌘⇧G in the file dialog and paste the path if it's hard to find)

First time, run it once by hand to clear Gatekeeper: **right-click it in Finder →
Open → Open**.

On login it starts a detached supervisor (`caffeinate` keeps the Mac awake +
re-runs the idempotent `local-up.sh` every 5 min so a crashed process recovers),
then closes its window. Verify it registered:

```bash
osascript -e 'tell application "System Events" to get the name of every login item'
# → the list should include "cron-monitor"
pgrep -fl 'caffeinate -s bash'    # the supervisor, once it's running
```

**If the repo is *not* under a protected folder**, the LaunchAgent is cleaner:

```bash
# edit the absolute paths in the plist to match your checkout first
cp scripts/com.ismartghana.cron-monitor.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ismartghana.cron-monitor.plist
# remove:
launchctl unload ~/Library/LaunchAgents/com.ismartghana.cron-monitor.plist && \
  rm ~/Library/LaunchAgents/com.ismartghana.cron-monitor.plist
```

### Don't let the Mac sleep

launchd can't run a frozen process. If the lid closes / the machine sleeps, the
scheduler stops ticking and `missedRunTotal` climbs until it wakes.

```bash
caffeinate -s   # keep awake while on power — run in its own terminal, or:
caffeinate -s -w $(pgrep -f 'tsx watch src/scheduler')   # tie it to the scheduler
```

Or **System Settings → Battery → Options → "Prevent automatic sleeping on power
adapter when the display is off"**, and **Lock Screen → turn display off after: Never**
while plugged in.

> This is the real limit of "run it on my laptop." For true always-on, deploy to
> a small server — see [`deployment.md`](./deployment.md).

---

## Common errors

### `[tsx] Previous process hasn't exited yet. Force killing...`

Harmless. `tsx watch` restarting the process after a file change (or a slow shutdown).
Nothing to do. If it loops forever, a **port is already taken** — see below.

### `EADDRINUSE: address already in use :::3000` (or `:5173`)

Something is already on that port — usually an earlier `npm run dev` that didn't exit.

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN        # find the PID
kill <pid>
# or clear all of ours:
pkill -f 'tsx watch src/'; pkill -f 'web/node_modules/.bin/vite'
```

### `ECONNREFUSED 127.0.0.1:5433` / `getaddrinfo ENOTFOUND postgres` / `connect ECONNREFUSED ...:6380`

Postgres or Redis isn't up.

```bash
docker compose ps                       # both should be "Up (healthy)"
docker compose up -d
docker compose logs postgres --tail 20
```

If you're using `docker compose --profile full`, the app containers talk to `postgres:5432` /
`redis:6379` — the `5433`/`6380` values are for processes running on the host.

### `Invalid environment configuration:` on startup

The env layer fails fast. The message lists exactly which vars are wrong. Most common:

- `JWT_SECRET: String must contain at least 16 character(s)` — set a longer secret.
- `BOOTSTRAP_ADMIN_PASSWORD: String must contain at least 8 character(s)`.
- `DATABASE_URL: Invalid url` — needs the full `postgres://user:pass@host:port/db` form.
- A bare `KEY=` line is treated as unset, which is fine for optional vars.

### `relation "monitored_apis" does not exist` (or similar)

Migrations haven't run against this database.

```bash
npm run migrate up
```

### `password authentication failed for user "cronmon"` from a GUI / psql

User and password are both `cronmon`, database `cronmon`, host `localhost`, port **5433**.

### `admin bootstrap failed` in the API log

Only logged, never fatal. Happens if `BOOTSTRAP_ADMIN_*` are unset (nothing to create) or the
admin already exists. Create one manually any time with `npm run create-admin`.

### `429 RATE_LIMITED` when hitting the API repeatedly

Working as designed (Redis-backed limiter). For scripted testing, **log in once and reuse the
token** rather than authenticating on every call. The login bucket is 10 / 5 min per
`ip:email`; the general bucket is 300 / min per client.

### Login returns `401` with `admin@…`

The bootstrap admin is created from `BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD` **at API start** —
if you changed those after first boot, the old credentials still apply. Check the DB
(`SELECT email FROM users;`) or run `npm run create-admin`.

### `CREDENTIAL_ENCRYPTION_KEY not set — using the insecure development key`

A warning, not an error. Fine for local dev. Set a real base64 32-byte key for anything shared:
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

### Dashboard loads but every panel is empty / spinning

The API isn't reachable. Confirm `npm run dev` is up on 3000 and `curl localhost:3000/health`
returns `200`. The dashboard proxies `/api` → `localhost:3000`; if the API restarts, the
dashboard recovers on its next 10 s poll.

### Scheduler shows `missedRunTotal` climbing

Slots that were due while the scheduler was down. Expected after a restart; it stops growing
once the scheduler is running steadily. The watchdog fires a CRITICAL if the heartbeat goes
stale past `SCHEDULER_HEARTBEAT_GRACE_MS` (30 s).

---

## Reset

```bash
# wipe just the monitoring data, keep users:
docker exec fintech-cron-monitor-postgres-1 psql -U cronmon -d cronmon -c "
  TRUNCATE monitored_apis, incidents, alerts, health_check_results, cron_job_runs, job_locks,
           target_schedule_state, scheduler_heartbeats, sla_reports, ai_insights, maintenance_windows
    RESTART IDENTITY CASCADE;
  ALTER SEQUENCE incident_number_seq RESTART WITH 1;"

# full reset (also drops the Postgres/Redis volumes):
docker compose down -v && docker compose up -d && npm run migrate up
```

---

## Verify a healthy install

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

All green = 164 tests, 0 vulnerabilities.
