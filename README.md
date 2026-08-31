# FinTech Cron Monitor

Cron-driven, minute-level health-check and incident-detection engine for iSmartPay's
production payment rails.

> The cron engine's guarantee that every check actually ran — on time, every time —
> and that its own silence is independently detectable, **is the product**. Health-check
> logic, incidents and alerting are built on top of that guarantee, never ahead of it.

Full specification: `../FINTECH_CRON_MONITOR_README.md` and the Obsidian vault at
`../iSmartPay Cron Monitor/` (start at **Project MOC**).

## Status

**All 11 roadmap phases complete.** The cron engine (the core deliverable) passed its
GATE chaos tests; incidents, tiered escalation, alert delivery, a live React dashboard,
authentication + RBAC + four-eyes approval, advisory AI intelligence, and SLA /
compliance reporting with a public status page sit on top. 153 tests, 0 vulnerabilities.

The dashboard is a separate app in [`web/`](./web) — Vite + React + Tailwind v4 + shadcn/ui,
polling this API every 10s. `cd web && npm run dev`.

**Deploying** (backend 24/7 on a server via Docker Compose, dashboard on Vercel): [`docs/deployment.md`](./docs/deployment.md).
**Running it locally** (four processes + common errors): [`docs/running-locally.md`](./docs/running-locally.md).
**Trying it against live endpoints:** [`docs/testing-with-real-endpoints.md`](./docs/testing-with-real-endpoints.md).

Phase 1:

- Node.js 22 + TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- Express API skeleton with `/`, `/health`, `/ready`, `/live`, `/health/scheduler`
- Validated environment config (`zod`), fail-fast on misconfiguration
- Structured JSON logging (`pino`) with aggressive credential redaction
- PostgreSQL (`pg`) and Redis (`ioredis`) connection modules + health checks
- Graceful shutdown (SIGINT/SIGTERM) for every process
- Process entrypoints for `scheduler`, `worker`, `watchdog` (idle stubs until their phases)
- ESLint (type-checked) + Prettier, Vitest, GitHub Actions CI
- `docker-compose.yml` with `postgres`, `redis`, `migrate`, `app`, `scheduler`, `worker`, `watchdog`

Phase 2:

- 6 SQL migrations (`node-pg-migrate`), fully reversible, verified up + down on a clean database
- 14 domain enums + 15 tables: `roles`, `teams`, `users`, `user_roles`, `escalation_policies`,
  `on_call_schedules`, `monitored_apis`, `maintenance_windows`, `cron_job_runs`,
  `health_check_results`, `scheduler_heartbeats`, `incidents`, `alerts`, `sla_reports`, `audit_logs`
- Rules enforced in the schema: one active incident per target (partial unique index),
  `audit_logs` append-only (mutation-rejecting triggers), retry/SLA/timeout check constraints,
  `updated_at` auto-touch triggers
- `src/domain/enums.ts` mirrors the DB enums; a parity test fails the build if they drift
- The `is_money_moving` 5-minute frequency floor stays in the validation layer (spec Rule 16),
  not the schema (a cron string can't be range-checked in SQL)

Phase 3:

- `POST/GET/PUT/DELETE /api/v1/targets` + `/targets/:id/enable` and `/disable`
- Repository → service → controller layering; business logic never in routes
- Validation (`zod`) with endpoint-class severity defaults, the money-moving frequency
  floor (Rule 16), and cron-expression validation
- **SSRF guard** (`src/lib/ssrf.ts`): blocks loopback / RFC1918 / link-local /
  cloud-metadata targets — resolving the hostname first, so a DNS name pointing at a
  private IP is still refused — unless `allowPrivateNetwork` is set
- **Credential encryption at rest** (`src/lib/crypto/credential-cipher.ts`): AES-256-GCM
  envelope with a local key-encryption key; plaintext credentials never touch the database
  (Phase 9 swaps the local key for KMS)
- Every mutating operation writes an immutable `audit_logs` row in the same transaction

Phase 4:

- `POST /api/v1/targets/:id/test` — one-off check, not persisted, full outcome returned
- Executor (`undici`): per-target timeout, retry with exponential backoff, transport-error
  classification (TIMEOUT / DNS / CONNECTION / TLS), HTTP-status classification
- Only transient failures are retried (timeout, 5xx, 429, connection); 4xx and validation
  failures are not — a single blip never surfaces as DOWN, a deterministic failure never waits
- Response validator: all 7 rule types (status, JSON equality, JSON path, contains/not-contains,
  numeric threshold, structural schema, composite all/any). `HTTP 200` is never healthy on its own
- Auth injection per `auth_type` (API key, bearer, basic, custom header; iSmartPay `apiId`/`apiSecret`)
- `429` → `UNKNOWN`, not a hard DOWN; slow-but-passing → `DEGRADED`
- Response samples are PCI-scrubbed (`lib/pci.ts`) before they can be stored or logged (Rule 20)

Phase 5 — **the cron engine**:

- Single-node, DB-driven scheduler (`services/scheduler/`): a 1s tick compares each
  target's most recent wall-clock slot to the last one it fired, so scheduling is
  anchored to `:00` boundaries and **never drifts** (`setInterval` is not used for timing)
- **Distributed lock** per `(target, slot)` — a Postgres table with a TTL, so a crashed
  holder's lock self-expires and is stolen rather than deadlocking (spec's "simpler fallback")
- **Idempotent** `job_run_id` = `targetId:slotEpoch`; a result already recorded is never
  re-executed — safe to run multiple schedulers/workers
- **Dead-letter path**: a check that fails to *run* (vs. a target that's DOWN) →
  `cron_job_runs` `DEAD_LETTERED` + `JOB_EXECUTION_FAILURE` alert
- **Missed-run detection**: slots skipped while the scheduler was down are counted and
  alerted (`SCHEDULER_HEARTBEAT_MISSED`), per target and scheduler-wide
- **Independent watchdog** (`watchdog/` process, separate container): polls the scheduler
  heartbeat; if it goes stale it fires CRITICAL through `WATCHDOG_EXTERNAL_ENDPOINT` — a
  path that shares nothing with the primary alert engine
- Real `GET /health/scheduler` + `GET /api/v1/scheduler/{status,jobs,jobs/:id/runs,missed-runs}`
- **GATE — proven by chaos tests** (`scheduler.reliability.test.ts`, all DB-backed):
  no double-execution across concurrent workers, idempotency, lock steal-on-expiry,
  dead-lettering, anchored single-fire per slot, skipped-slot detection, watchdog staleness

Phase 6 — **incident engine** (`services/incident/`):

- State machine runs inside the job runner's transaction, so a check result and the
  incident change it causes commit together
- `UP → DOWN` opens an OUTAGE; `UP → DEGRADED` opens a lower-severity DEGRADATION;
  a `DOWN` while degraded promotes the incident to full severity
- `DOWN → UP` auto-resolves **only** after `INCIDENT_RECOVERY_STREAK` (default 2) clean
  `UP` checks — deterministic, applied uniformly to money-moving targets (Rule 18)
- The DB's partial unique index makes "one active incident per target" a hard guarantee
- **Flapping guard** (Rule 23): rapid oscillation (default ≥4 state changes / 10 min,
  counted from `health_check_results`) is surfaced as a distinct `FLAPPING` incident type
  + one `FLAPPING_DETECTED` alert, not a storm of open/close alerts
- `GET /api/v1/incidents`, `GET /incidents/:id`, `POST /:id/acknowledge`, `POST /:id/resolve`
  (resolution note required), `PATCH /:id/root-cause` — all audit-logged

Phase 7 — **alerting & escalation** (`services/alert/`, runs in the scheduler process):

- **Channels**: Webhook (HMAC-signed via `WEBHOOK_SIGNING_SECRET`), Slack, Email
  (`nodemailer`), **Push** (Firebase Cloud Messaging — [`docs/firebase-push-setup.md`](./docs/firebase-push-setup.md)),
  **SMS** (iSmartGhana bulk-SMS gateway — GET with query params, `api_password`
  redacted from logs). Teams/Phone log until wired. A channel with no transport
  configured **logs** the notification rather than dropping it
- **The digest is a summary channel, not per-event** — a job snapshots overall system
  health every `SMS_DIGEST_INTERVAL_MINUTES` (default 30). **SMS** = short summary, sent
  only on an overall level change (HEALTHY / DEGRADED / CRITICAL); **email** = full
  per-service status, and for a contact flagged `digest_every_run` it lands every run.
  Recipients live in `notification_contacts` (`GET/POST/PUT/DELETE /api/v1/notification-contacts`).
  `health_digests` keeps the history. `GET /api/v1/health-digests{,/latest,/preview}`,
  `POST …/evaluate`. [`docs/sms-digest-notifications.md`](./docs/sms-digest-notifications.md)
- **Escalation engine**: one due tier per cycle per OPEN incident; tier delays measured
  from `started_at`; **stops the moment an incident is acknowledged**; a tier with
  `condition: "is_money_moving"` only fires for money-moving incidents (spec 8.9 tier 4)
- **Maintenance windows** (`POST/GET/DELETE /api/v1/maintenance-windows`, ≤30 days,
  target-specific or global): alerts for a target inside a window are marked `SUPPRESSED`,
  **the check still runs and records** — recovery alerts are never suppressed
- **Recovery fan-out**: when an incident resolves, `API_RECOVERED` is queued to every
  channel+recipient that was notified about it
- `GET /api/v1/alerts`, `GET/POST/PUT /api/v1/escalation-policies`, `GET /api/v1/on-call-schedules`

Phase 8 — **dashboard** ([`web/`](./web)):

- Read APIs: `GET /api/v1/dashboard/{summary,performance,targets}`, `GET /api/v1/health-checks/:id`
- React 19 + Vite + Tailwind v4 + shadcn/ui, TanStack Query with a 10s poll (live view)
- Pages: Overview (stat tiles, latency chart, open incidents, money-moving targets),
  Targets (status board with enable/disable + ad-hoc **Test**), Incidents (list + detail
  drawer with acknowledge / resolve), Scheduler (heartbeat, job runs, missed runs), Alerts
- Landing page is the WebGL black-hole hero (`web/src/components/ui/blackhole-hero-section.tsx`) —
  self-contained, no deps, degrades to a black background if WebGL is unavailable
- Charts use Recharts with the validated dataviz palette; status colours always carry an icon + label

Phase 9 — **security & compliance**:

- **Auth** — `POST /api/v1/auth/{login,refresh,logout,me}`. scrypt password hashing
  (no native dep), HS256 access tokens (`jose`), opaque refresh tokens stored hashed
  with **rotation + reuse detection** (replaying a used token burns the whole family)
- **RBAC** — `authenticate` + `requireRole` on every mutation (`DEVELOPER`/`ADMIN` for
  target config, `OPERATOR`/`ADMIN` for incidents & maintenance windows, `ADMIN` for
  escalation policies & delete). `AUTH_ENABLED=false` bypasses for local dev, refused in prod
- **Four-eyes** — a change to a money-moving target is queued as a `config_change_request`;
  it applies only when a *different* `ADMIN` approves (`POST /config-requests/:id/{approve,reject}`,
  DB `CHECK (reviewed_by <> proposed_by)`)
- **Rate limiting** — Redis-backed (`rate-limiter-flexible`), per client key, with a stricter
  bucket on login; in-process fallback if Redis blips
- **Security headers** — tightened helmet CSP / HSTS / referrer-policy / CORP
- **Credential encryption** — the AES-256-GCM envelope's key source is the seam a KMS
  provider slots into (the envelope already carries a `keyId` for rotation)
- Every audit row now carries a denormalised actor label, so deleting a user never
  erases who acted; the append-only trigger allows exactly that one FK-detach and nothing else
- `npm run create-admin`; first-run bootstrap from `BOOTSTRAP_ADMIN_*`

The dashboard has a login page, stores tokens in `localStorage`, refreshes transparently on
401, and an **Approvals** page for the four-eyes queue.

Phase 10 — **AI intelligence (advisory only)**:

- Migration `1725000010000` (`ai_insights`) — every row carries `assistive = true` as a
  hard DB `CHECK`. The `AiClient` seam exposes only `analyze()`; there is **no code path**
  from AI to a target, incident or alert mutation
- **Analysis** (`services/ai/analysis.service.ts`) — failure classification, ranked
  root-cause hypotheses (evidence + confidence each), and an incident summary, via
  `messages.parse()` with a zod structured-output schema. Each is stored as an advisory
  insight and returned labelled `ASSISTIVE`
- **Anomaly detection** (`services/ai/anomaly.service.ts`) — **pure statistics, no LLM**:
  z-score of the last hour's latency vs a 30-day rolling baseline, plus an error-rate
  delta. Runs on a throttled 5-min scan in the scheduler; never opens an incident
- `GET /incidents/:id/ai`, `POST /incidents/:id/ai/analyze` (OPERATOR/ADMIN, 503 if no
  key), `GET /targets/:id/anomalies`, `GET /anomalies`, `GET /ai/status`
- Dashboard: incident-drawer AI panel (ASSISTIVE badge + confidence bars), overview
  anomalies card

Phase 11 — **SLA reporting, compliance export, status page**:

- Migration `1725000011000` — `sla_reports` gains `period_kind` (`rolling_30d` /
  `calendar_month`), `excluded_seconds`, and check counts
- **SLA computation** (`services/reporting/sla.service.ts`) — count-based uptime; checks
  inside an approved maintenance window are excluded from the breach math but their
  downtime is **still recorded** (`excluded_seconds`), never deleted. `runSlaReports()`
  upserts a rolling-30d + current calendar-month row per target, idempotently, every
  `SLA_REPORT_INTERVAL_MINUTES` in the scheduler process
- **Compliance export** — `GET /reports/compliance?from=&to=&format=json|csv` (incidents,
  SLA outcomes, maintenance windows, audit-action summary); `COMPLIANCE`/`MANAGEMENT`/`ADMIN`
- `GET /sla/summary`, `GET /sla/:targetId`, `POST /sla/refresh`
- **Public status page** — `GET /api/v1/status`, unauthenticated, `STATUS_PAGE_ENABLED`-gated,
  sanitised (no URLs / ids / failure detail). Dashboard renders it at `/status` (no login);
  `/app/sla` shows per-target uptime and the compliance export

## Getting started

```bash
cp .env.example .env
npm install
docker compose up -d          # postgres (host :5433) + redis (host :6380)
npm run migrate up            # apply migrations to the dev database
npm run db:test:setup         # create + migrate cronmon_test (for the schema tests)
npm run dev                   # API on http://localhost:3000

curl -s localhost:3000/health | jq
```

> Host ports are 5433/6380 to avoid colliding with a local Postgres/Redis. The
> containers still talk to each other on the standard 5432/6379.

### Everything containerised

```bash
docker compose --profile full up -d --build
docker compose run --rm migrate
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | API server with watch reload |
| `npm run dev:scheduler` / `:worker` / `:watchdog` | the other processes |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` / `lint:fix` | ESLint (type-aware) |
| `npm run format` / `format:check` | Prettier |
| `npm test` / `test:watch` | Vitest (schema tests skip if no database) |
| `npm run migrate up` / `migrate down` | database migrations (dev DB, via `.env`) |
| `npm run db:test:setup` | create + migrate `cronmon_test` |
| `npm run build` / `npm start` | compile to `dist/` and run |

## Layout

```
src/
  config/         validated env
  lib/            logger, db, redis, cron, ssrf, crypto, errors, shutdown
  domain/         enums + entity types (mirrored from the DB)
  repositories/   SQL data access, one module per aggregate
  services/
    target/       target CRUD + validation
    audit/        immutable audit trail
    health-check/ executor, validator, failure classifier, auth
    scheduler/    scheduler, distributed lock, job runner, missed-run detector
    incident/     incident state machine
    alert/        channels, escalation, delivery, alert runner
    ai/           advisory analysis + statistical anomaly detection (Phase 10)
    reporting/    SLA computation, report runner, compliance export (Phase 11)
    digest/       SMS system-health digest (summary channel, state-change only)
    alert/sms-gateway.ts  iSmartGhana bulk-SMS transport (GET, credentials redacted)
  http/           express app, middleware, routes
  scheduler/      scheduler process entrypoint (cron + alerts + SLA reports)
  workers/        BullMQ worker entrypoint (idle stub — the horizontal-scale path)
  watchdog/       independent dead-man's-switch process
  tests/          shared setup + fixtures
migrations/       node-pg-migrate SQL migrations
docs/             runbooks (deployment, running-locally, testing-with-real-endpoints,
                            firebase-push-setup, sms-digest-notifications)
docker-compose.prod.yml   self-contained production stack (api/scheduler/watchdog/
                          worker + postgres + redis + Caddy TLS)
Caddyfile                 reverse proxy + automatic HTTPS for the API
web/vercel.json           dashboard build/SPA config for Vercel
```

Layering is enforced: **Controller → Service → Repository → Database**. Business logic
lives in services, never in controllers or workers.
