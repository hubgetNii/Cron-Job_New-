# FinTech Cron Monitor

Cron-driven, minute-level health-check and incident-detection engine for iSmartPay's
production payment rails.

> The cron engine's guarantee that every check actually ran — on time, every time —
> and that its own silence is independently detectable, **is the product**. Health-check
> logic, incidents and alerting are built on top of that guarantee, never ahead of it.

Full specification: `../FINTECH_CRON_MONITOR_README.md` and the Obsidian vault at
`../iSmartPay Cron Monitor/` (start at **Project MOC**).

## Status

**Phase 1 — Foundation.** In place:

- Node.js 22 + TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- Express API skeleton with `/`, `/health`, `/ready`, `/live`, `/health/scheduler`
- Validated environment config (`zod`), fail-fast on misconfiguration
- Structured JSON logging (`pino`) with aggressive credential redaction
- PostgreSQL (`pg`) and Redis (`ioredis`) connection modules + health checks
- `node-pg-migrate` pipeline with a baseline migration
- Graceful shutdown (SIGINT/SIGTERM) for every process
- Process entrypoints for `scheduler`, `worker`, `watchdog` (idle stubs until their phases)
- ESLint (type-checked) + Prettier, Vitest, GitHub Actions CI
- `docker-compose.yml` with `postgres`, `redis`, `migrate`, `app`, `scheduler`, `worker`, `watchdog`

Not yet built: database schema (Phase 2), target management (Phase 3), health-check
execution engine (Phase 4), the cron engine (Phase 5), incidents (Phase 6), alerting
(Phase 7), dashboard (Phase 8), security hardening (Phase 9), AI (Phase 10), reporting (Phase 11).

## Getting started

```bash
cp .env.example .env
npm install
docker compose up -d          # postgres (host :5433) + redis (host :6380)
npm run migrate up            # apply migrations
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
| `npm test` / `test:watch` | Vitest |
| `npm run migrate up` / `migrate down` | database migrations |
| `npm run build` / `npm start` | compile to `dist/` and run |

## Layout

```
src/
  config/      validated env
  lib/         logger, db, redis, errors, shutdown, version
  http/        express app, middleware, routes
  scheduler/   scheduler process entrypoint   (Phase 5)
  workers/     health-check worker entrypoint  (Phase 4/5)
  watchdog/    independent dead-man's-switch   (Phase 5)
  tests/       shared test setup
migrations/    node-pg-migrate SQL migrations
```

Layering is enforced: **Controller → Service → Repository → Database**. Business logic
lives in services, never in controllers or workers.
