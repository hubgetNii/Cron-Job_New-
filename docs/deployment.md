# Deployment — backend on a server, dashboard on Vercel

The monitor must keep checking **regardless of your laptop**. So the backend
(API + scheduler + watchdog + worker + Postgres + Redis) runs 24/7 on a small
Linux box via Docker Compose, and the dashboard is a static site on Vercel that
talks to it over HTTPS.

```
                    ┌──────────────── your server (Hetzner) ────────────────┐
   Vercel           │  Caddy :443  ──►  api :3000                            │
  dashboard  ──────►│                    scheduler   (1s tick, the engine)   │
 (static SPA)  CORS │                    watchdog    (dead-man's switch)     │
                    │                    worker                              │
                    │                    postgres   redis   (not exposed)   │
                    └───────────────────────────────────────────────────────┘
```

---

## Part 1 — the server

Any always-on Linux host with Docker works: a **Hetzner Cloud CX22** (~€4/mo),
DigitalOcean droplet, etc. 2 vCPU / 4 GB is comfortable.

### 1.1 Provision + base setup

```bash
# on the server, as root or with sudo
apt update && apt -y upgrade
curl -fsSL https://get.docker.com | sh          # Docker + compose plugin
adduser deploy && usermod -aG docker deploy
# firewall: allow SSH + HTTP + HTTPS only
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

Point DNS: an **A record** for `cron-api.ismartghana.com` → the server's IP.
(Caddy needs this resolvable to get a TLS cert.)

### 1.2 Get the code

```bash
su - deploy
git clone https://github.com/hubgetNii/Cron-Job_New-.git cron-monitor
cd cron-monitor/fintech-cron-monitor
```

### 1.3 Configure

```bash
cp .env.production.example .env
```

Edit `.env` and fill in — the required ones:

| var | how |
|---|---|
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` |
| `DATABASE_URL` | `postgres://cronmon:<that password>@postgres:5432/cronmon` |
| `API_DOMAIN` | `cron-api.ismartghana.com` (matches your DNS) |
| `CORS_ALLOWED_ORIGINS` | your Vercel URL, e.g. `https://cron-monitor.vercel.app` (add the custom domain later, comma-separated) |
| `JWT_SECRET` | `openssl rand -hex 32` |
| `CREDENTIAL_ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD` | your first admin login |
| `SMTP_USER` / `SMTP_PASSWORD` / `ALERT_EMAIL_FROM` | Gmail address + app password (all three the same address) |
| `SMS_API_ID` / `SMS_API_PASSWORD` | from the SMS provider |
| `MPSMS_ACCESSCODE` / `MPSMS_CLIENTCODE` | from the MPSMS console (if seeding that target) |

Firebase push — put the service-account JSON on the box:

```bash
mkdir -p secrets
# scp it up, or paste it:
nano secrets/fcm.json          # the cron-notification-*-firebase-adminsdk-*.json contents
chmod 600 secrets/fcm.json
```

(`secrets/` and `.env` are gitignored and dockerignored — they never enter an image or the repo.)

### 1.4 Start it

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

`migrate` runs once and exits; `api`, `scheduler`, `watchdog`, `worker` start
after it succeeds; `caddy` fetches a TLS cert for `API_DOMAIN` on first request.

### 1.5 Verify

```bash
docker compose -f docker-compose.prod.yml ps          # all "running" except migrate ("exited 0")
curl -s https://cron-api.ismartghana.com/health | jq
curl -s https://cron-api.ismartghana.com/health/scheduler | jq   # "ok" after ~10s

# create the admin (if BOOTSTRAP_ADMIN_* weren't set, or to add more)
docker compose -f docker-compose.prod.yml run --rm api npm run create-admin

# register the MPSMS target
docker compose -f docker-compose.prod.yml run --rm api npm run seed:mpsms
```

### 1.6 It survives reboots

`restart: unless-stopped` on every service + Docker's own systemd unit means a
server reboot brings the whole stack back. Nothing depends on your machine.

---

## Part 2 — the dashboard on Vercel

1. **vercel.com → Add New → Project → Import** `hubgetNii/Cron-Job_New-`.
2. **Root Directory:** `fintech-cron-monitor/web` (click *Edit* next to Root Directory).
   Vercel picks up `web/vercel.json` (framework Vite, SPA rewrite).
3. **Environment Variables:**
   | name | value |
   |---|---|
   | `VITE_API_URL` | `https://cron-api.ismartghana.com/api/v1` |
4. **Deploy.** You get `https://<project>.vercel.app`.
5. Back on the server, make sure that exact origin is in `CORS_ALLOWED_ORIGINS`
   in `.env`, then `docker compose -f docker-compose.prod.yml up -d api` to reload it.
6. Open the dashboard, log in with the bootstrap admin. The public status page is
   at `/status`.

### Custom domain (optional)

Add `dashboard.ismartghana.com` in the Vercel project → Domains, point its CNAME
at Vercel, and add it to `CORS_ALLOWED_ORIGINS` (comma-separated) + redeploy `api`.

---

## Part 3 — the watchdog's alert path

The watchdog is the dead-man's switch — if the scheduler stops ticking it fires a
CRITICAL. That alert must **not** route through this API or the primary alert
engine (they might be the thing that's down). Set `WATCHDOG_EXTERNAL_ENDPOINT` to
something independent:

- a **Slack incoming webhook** (different infra), or
- an external uptime service's push URL, or
- for real belt-and-braces: also run one `watchdog` container on a *second*
  cheap box pointed at the same Redis (or add an external uptime check —
  cron-job.org / UptimeRobot — hitting `https://cron-api.…/health/scheduler`,
  which returns 503 when the scheduler is stale).

---

## Ops

```bash
cd ~/cron-monitor/fintech-cron-monitor

# logs
docker compose -f docker-compose.prod.yml logs -f scheduler
docker compose -f docker-compose.prod.yml logs -f api

# update to the latest main
git pull
docker compose -f docker-compose.prod.yml up -d --build   # re-runs migrate, rolling-restarts

# restart one service
docker compose -f docker-compose.prod.yml restart scheduler

# DB backup (cron this)
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U cronmon cronmon | gzip > backup-$(date +%F).sql.gz

# stop everything (data volumes persist)
docker compose -f docker-compose.prod.yml down
```

### Resource notes

- The scheduler is a 1 s tick loop but nearly idle between checks; CPU is tiny.
- Postgres grows with `health_check_results` — one row per check per target.
  Add a retention job (`DELETE FROM health_check_results WHERE checked_at < now() - interval '90 days'`)
  when the target count gets large.
- Gmail sending caps at ~500/day. Fine for the digest + a few incident emails;
  move to Workspace / SES if the email contact list grows.
