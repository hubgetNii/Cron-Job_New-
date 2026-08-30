# FinTech Cron Monitor

Cron-driven, minute-level health-check and incident-detection engine for iSmartPay's
production payment rails.

> The cron engine's guarantee that every check actually ran — on time, every time —
> and that its own silence is independently detectable, **is the product**. Health-check
> logic, incidents and alerting are built on top of that guarantee, never ahead of it.

Full specification: `../FINTECH_CRON_MONITOR_README.md` and the Obsidian vault at
`../iSmartPay Cron Monitor/` (start at **Project MOC**).

## Status

**Phases 1–7 complete.** The cron engine (the core deliverable) passed its GATE chaos
tests; incidents, tiered escalation and alert delivery sit on top of it.

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
  (`nodemailer`), SMS (generic provider POST); Teams/Push/Phone log until wired. A channel
  with no transport configured **logs** the notification rather than dropping it
- **Escalation engine**: one due tier per cycle per OPEN incident; tier delays measured
  from `started_at`; **stops the moment an incident is acknowledged**; a tier with
  `condition: "is_money_moving"` only fires for money-moving incidents (spec 8.9 tier 4)
- **Maintenance windows** (`POST/GET/DELETE /api/v1/maintenance-windows`, ≤30 days,
  target-specific or global): alerts for a target inside a window are marked `SUPPRESSED`,
  **the check still runs and records** — recovery alerts are never suppressed
- **Recovery fan-out**: when an incident resolves, `API_RECOVERED` is queued to every
  channel+recipient that was notified about it
- `GET /api/v1/alerts`, `GET/POST/PUT /api/v1/escalation-policies`, `GET /api/v1/on-call-schedules`

Not yet built: dashboard (Phase 8), security hardening (Phase 9), AI (Phase 10),
reporting (Phase 11).

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
  http/           express app, middleware, routes
  scheduler/      scheduler process entrypoint
  workers/        BullMQ worker entrypoint (idle stub — the horizontal-scale path)
  watchdog/       independent dead-man's-switch process
  tests/          shared setup + fixtures
migrations/       node-pg-migrate SQL migrations
```

Layering is enforced: **Controller → Service → Repository → Database**. Business logic
lives in services, never in controllers or workers.
