# Load-test worker — deployment runbook

The worker is the only component that generates traffic. It runs **on a dedicated, disposable VM** (decision 2026-10-15) — never on the monitor host, which would load-test itself, and never on a laptop. It needs the monitor's Postgres, the `k6` binary and outbound access to the sandbox. Nothing else.

> Status: the image and compose file are built and smoke-tested locally (k6 v2.3.0 inside, non-root, clean start/stop against Postgres). The Hetzner VM itself is not provisioned yet (register item A5).

## What is in the box

| File | Purpose |
|---|---|
| `Dockerfile.loadtest-worker` | Compiled worker + pinned k6 (`K6_VERSION` build arg), non-root, `dumb-init` |
| `docker-compose.loadtest-worker.yml` | One service; read-only filesystem, `/tmp` tmpfs, no capabilities, 3 GB memory cap, 40 s stop grace |
| `.env.loadtest-worker.example` | Every variable the worker needs, with the safe defaults |

## 1. Provision the VM

- A small Linux VM is enough for the current ceilings (sandbox ≤ 25 rps / 100 VUs): 2 vCPU / 4 GB. Resize only if a run reports *generator saturated* — that verdict means the VM, not the service, was the limit.
- Install Docker + the compose plugin. Enable automatic security updates.
- **Firewall:** inbound — SSH only, from your admin IPs. Outbound — HTTPS to `stgdeveloper-api.ismartghana.com`, and to the monitor's Postgres over the private link. Nothing else is required, so deny the rest.
- The VM may be destroyed after a test window and rebuilt from this runbook; it keeps no state (runs, metrics and evidence live in Postgres).

## 2. Give it a private route to Postgres

The production compose file does **not** publish Postgres, which is correct. Pick one:

1. **WireGuard / provider private network** between the VM and the monitor host, with Postgres listening only on the private address. *(Recommended.)*
2. SSH tunnel from the VM (`ssh -L`), as a stop-gap.

Either way use `sslmode=require` in `DATABASE_URL`. A dedicated, narrowed database role for the worker is the right end state, but the exact table-by-table grants have **not** been reviewed yet (the worker touches the `load_test_*` tables, target configuration, maintenance windows and the audit log) — until that review is done, use a role that is reachable only over the private link and never the admin role.

## 3. Configure

```bash
cp .env.loadtest-worker.example .env.loadtest-worker
chmod 600 .env.loadtest-worker
```

Set `DATABASE_URL` and `CREDENTIAL_ENCRYPTION_KEY` (the same key the API uses — the worker decrypts target credentials with it, so treat the file like a secret). Plans that use `{{secret:NAME}}` read the value from the worker's environment as `LT_SECRET_NAME`; add those here too. Leave `LOAD_TEST_ENABLED=false` for the first start.

## 4. Start, verify, enable

```bash
docker compose -f docker-compose.loadtest-worker.yml up -d --build
docker compose -f docker-compose.loadtest-worker.yml logs -f worker
```

Expected: `LOAD_TEST_ENABLED=false — worker will idle` then `load-test worker started`. Check `docker compose … exec worker k6 version`. When ready, set `LOAD_TEST_ENABLED=true` and `docker compose … up -d`. The API host must also have `LOAD_TEST_ENABLED=true` — that is what lets runs be queued at all.

First real run, in order (details in the plan doc's "Runbook: first real sandbox run"): run the **money-correctness** suite, then **security**, then a **SMOKE** load run. Do not start with load.

## 5. Operate

- **Stop a run:** the dashboard's *Stop this run*, or the kill switch (ADMIN). The worker also stops itself on authorization expiry or an error-rate guardrail.
- **Stop the worker:** `docker compose … stop` — an active run is aborted cleanly and recorded (stop grace is 40 s).
- **Update:** `git pull && docker compose … up -d --build`. Apply database migrations from the monitor host first.
- **Several workers:** safe — runs are claimed with `FOR UPDATE SKIP LOCKED`, one run per worker.
- **Scheduled suites** (correctness / security cadence) are queued by the worker loop, so at least one worker must be running for schedules to fire.

## 6. Guard rails to keep

- Production hosts stay in `LOAD_TEST_PRODUCTION_HOSTS` (the built-in default). The list is how production is recognised and refused — never blank it.
- Keep `LOAD_TEST_CEILINGS` at the defaults until iSmart confirms the sandbox's rate limits (register item A2).
- Utility purchases send **real** airtime/data even in the test environment; the gate caps them at 1 rps and requires an approved authorization.
- Tear the VM down, or set `LOAD_TEST_ENABLED=false`, when no test window is active.
