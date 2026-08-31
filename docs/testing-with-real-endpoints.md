# Testing the cron engine against real endpoints

A hands-on runbook for exercising the whole system — the drift-free scheduler, the
execution guarantee, incident detection, alerting, SLA reports and the status page —
against live HTTP endpoints on your machine.

---

## 0. Safety first — which endpoints are safe to point at

This project has **no sandbox for money-moving rails**: a check against a real
payment-initiation / settlement endpoint hits production. When testing the *engine*:

- **Use read-only endpoints only.** Public test services (`https://httpbin.org/*`,
  `https://www.google.com`), or your own `GET` health / status endpoints.
- **Never set `isMoneyMoving: true` on a target that points at a real mutating
  endpoint** just to test the four-eyes flow — use a dummy URL for that.
- For real iSmartPay endpoints, register only `GET` health/status URLs, and leave
  `isMoneyMoving` false unless the URL is genuinely a safe read.

The engine sends a normal HTTP request every slot — treat it exactly like a client
calling that URL on a schedule.

---

## 1. Prerequisites

- Node.js 22+ and npm
- Docker (for Postgres + Redis) — or your own Postgres 16 / Redis 7
- `jq` and `curl` (the examples use them)
- Ports free on the host: **3000** (API), **5433** (Postgres), **6380** (Redis)

---

## 2. One-time setup

```bash
cd fintech-cron-monitor
cp .env.example .env
npm install
docker compose up -d            # postgres on :5433, redis on :6380
npm run migrate up              # apply all 11 migrations to the dev DB
```

For the fastest possible loop, turn auth off in `.env` (local dev only — the app
refuses this in `NODE_ENV=production`):

```dotenv
AUTH_ENABLED=false
```

> Keeping auth on instead? See **Appendix A** for the login flow. Every `curl`
> below then needs `-H "authorization: Bearer $TOKEN"`.

Optional but recommended for a full picture — the dashboard:

```bash
cd web && npm install && npm run dev      # http://localhost:5173, proxies /api to :3000
```

---

## 3. Start the processes

The engine is **three independent processes**. Run each in its own terminal so you
can watch the logs and kill them individually.

| Terminal | Command | What it is |
| --- | --- | --- |
| 1 | `npm run dev` | API server (`http://localhost:3000`) |
| 2 | `npm run dev:scheduler` | **the cron engine** — fires checks, runs incidents, alerts, SLA reports |
| 3 | `npm run dev:watchdog` | independent dead-man's-switch watching the scheduler heartbeat |

Sanity check:

```bash
curl -s localhost:3000/health | jq
curl -s localhost:3000/health/scheduler | jq      # "ok" once the scheduler has ticked
```

---

## 4. Register a real target

A plain HTTP 200 check every minute (non-money-moving, so any cadence is allowed):

```bash
curl -s -X POST localhost:3000/api/v1/targets \
  -H 'content-type: application/json' \
  -d '{
    "name": "httpbin ok",
    "endpointClass": "reporting",
    "url": "https://httpbin.org/status/200",
    "method": "GET",
    "frequencyCron": "*/1 * * * *",
    "expectedStatus": 200,
    "timeoutMs": 5000
  }' | jq
```

Save the `id` from the response:

```bash
TARGET=$(curl -s localhost:3000/api/v1/targets | jq -r '.data[0].id')
```

Notes on the payload:

- `frequencyCron` accepts standard 5-field **and** 6-field (`*/30 * * * * *` = every
  30 s). The scheduler tick is 1 s and anchored to wall-clock boundaries — it does
  not drift.
- `endpointClass` sets a default severity. `internal` targets that resolve to a
  private IP are refused by the SSRF guard unless you also pass
  `"allowPrivateNetwork": true`.
- A body check instead of / in addition to the status code:
  `"expectedResponse": { "type": "contains", "value": "\"status\": 200" }`
  (all rule types are in **Appendix B**).

---

## 5. Watch it execute

Give it 1–2 minutes, then:

```bash
# Cron runs — one row per slot, idempotency key targetId:slotEpoch
curl -s "localhost:3000/api/v1/scheduler/jobs/$TARGET/runs" | jq '.data[] | {scheduledSlot, status, attemptNumber, completedAt}'

# Health-check results
curl -s "localhost:3000/api/v1/health-checks/$TARGET?limit=5" | jq '.data[] | {checkedAt, status, httpStatus, responseTimeMs}'

# Scheduler-wide view
curl -s localhost:3000/api/v1/scheduler/status | jq
```

In the dashboard: **Scheduler** page (heartbeat + job runs), **Targets** page (live
status board), and the **Test** button on a target for a one-off ad-hoc check that
is not persisted.

---

## 6. Prove the execution guarantee (missed-run detection)

This is the core promise — that a slot that *should* have run and didn't is detected.

1. Note the current time.
2. **Stop the scheduler** (Ctrl-C in terminal 2). Wait ~3 minutes.
3. Restart it: `npm run dev:scheduler`.
4. Check:

```bash
curl -s localhost:3000/api/v1/scheduler/missed-runs | jq
```

The slots skipped while it was down are counted per target and scheduler-wide, and a
`SCHEDULER_HEARTBEAT_MISSED` alert is recorded:

```bash
curl -s "localhost:3000/api/v1/alerts?alertType=SCHEDULER_HEARTBEAT_MISSED" | jq '.data[] | {alertType, status, createdAt}'
```

---

## 7. Prove the watchdog (independent dead-man's switch)

The watchdog shares nothing with the primary alert engine — it only reads the
heartbeat and fires through `WATCHDOG_EXTERNAL_ENDPOINT`.

1. Get a throwaway URL from <https://webhook.site> and put it in `.env`:
   `WATCHDOG_EXTERNAL_ENDPOINT=https://webhook.site/<your-uuid>`
2. Restart the watchdog (terminal 3).
3. **Stop the scheduler** (terminal 2) and leave it down past
   `SCHEDULER_HEARTBEAT_GRACE_MS` (default 30 s).
4. Watch the watchdog log fire a CRITICAL, and the POST land on webhook.site.
5. Restart the scheduler — the watchdog recovers on the next healthy heartbeat.

---

## 8. Failure → incident → recovery

Add a target that fails, and watch the incident state machine (it runs *inside* the
job runner's transaction, so a check result and the incident it causes commit
together).

```bash
curl -s -X POST localhost:3000/api/v1/targets \
  -H 'content-type: application/json' \
  -d '{
    "name": "httpbin 500",
    "endpointClass": "psp_gateway",
    "url": "https://httpbin.org/status/500",
    "frequencyCron": "*/1 * * * *",
    "expectedStatus": 200
  }' | jq
BAD=$(curl -s localhost:3000/api/v1/targets | jq -r '.data[] | select(.name=="httpbin 500") | .id')
```

- A single 5xx is **retried** (transient) before it counts as DOWN — one blip never
  opens an incident.
- After a sustained failure an `OUTAGE` incident opens:

```bash
curl -s "localhost:3000/api/v1/incidents?apiId=$BAD" | jq '.data[] | {incidentNumber, incidentType, severity, status, failureType, failureCount}'
```

- An `API_DOWN` alert is recorded (and delivered if you configured a channel — see §10).
- **Recover it:** `PUT` the target's URL to `https://httpbin.org/status/200`:

```bash
curl -s -X PUT "localhost:3000/api/v1/targets/$BAD" \
  -H 'content-type: application/json' \
  -d '{"url": "https://httpbin.org/status/200"}' | jq
```

  The incident auto-resolves **only after `INCIDENT_RECOVERY_STREAK` (default 2)
  consecutive clean checks** — deterministic, and applied the same way to
  money-moving targets. An `API_RECOVERED` alert fans out to everyone who was
  notified.

You can also drive an incident manually:

```bash
curl -s -X POST "localhost:3000/api/v1/incidents/$INC/acknowledge" | jq   # stops escalation
curl -s -X POST "localhost:3000/api/v1/incidents/$INC/resolve" \
  -H 'content-type: application/json' -d '{"resolution": "upstream fixed"}' | jq
curl -s -X PATCH "localhost:3000/api/v1/incidents/$INC/root-cause" \
  -H 'content-type: application/json' -d '{"rootCause": "PSP maintenance"}' | jq
```

---

## 9. Flapping

Point a target at `https://httpbin.org/status/200,500` — httpbin returns one or the
other at random. Within ~10 minutes the ≥4-state-changes rule trips and you get a
single `FLAPPING` incident + one `FLAPPING_DETECTED` alert instead of an alert storm:

```bash
curl -s "localhost:3000/api/v1/incidents?incidentType=FLAPPING" | jq '.data[] | {incidentNumber, status}'
```

## 9b. Degraded (slow but passing)

`https://httpbin.org/delay/3` with `"timeoutMs": 5000` responds 200 but slowly →
status `DEGRADED`, opening a lower-severity `DEGRADATION` incident rather than an
outage.

---

## 10. Alerting through a real channel

Point the webhook channel at a webhook.site bin (`.env`, then restart the scheduler):

```dotenv
ALERT_WEBHOOK_URL=https://webhook.site/<your-uuid>
WEBHOOK_SIGNING_SECRET=any-local-secret
```

Trigger an outage (§8) and watch the signed POST arrive. Email/Slack/SMS work the
same way; a channel with **no transport configured logs the notification** rather
than dropping it, so you always see it in the scheduler log.

### Maintenance windows suppress alerts, not checks

```bash
curl -s -X POST localhost:3000/api/v1/maintenance-windows \
  -H 'content-type: application/json' \
  -d "{\"targetId\": \"$BAD\", \"startsAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\", \"endsAt\": \"$(date -u -v+1H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)\", \"reason\": \"load test\"}" | jq
```

Checks keep running and recording; new alerts for that target are marked
`SUPPRESSED`. Recovery alerts are never suppressed.

---

## 11. SLA reports

The report runner refreshes every `SLA_REPORT_INTERVAL_MINUTES` (default 30). Force
it now:

```bash
curl -s -X POST localhost:3000/api/v1/sla/refresh | jq      # ADMIN/COMPLIANCE if auth is on
curl -s localhost:3000/api/v1/sla/summary | jq
curl -s "localhost:3000/api/v1/sla/$BAD" | jq '.data[] | {periodKind, uptimePercent, slaMet, downtimeSeconds, excludedSeconds}'
```

Downtime that fell inside a maintenance window shows up as `excludedSeconds` — it is
still recorded, just not counted against the SLA. The `/app/sla` dashboard page shows
this per target and lets you export a compliance report (JSON, or incidents CSV) for
a date range.

```bash
curl -s "localhost:3000/api/v1/reports/compliance?from=2026-08-01T00:00:00Z&to=2026-09-01T00:00:00Z" | jq '.data | keys'
```

---

## 12. AI analysis (optional — needs an API key)

Add to `.env` and restart the API + scheduler:

```dotenv
ANTHROPIC_API_KEY=sk-ant-...
AI_ENABLED=true
```

Everything AI produces is **advisory** — it is stored in `ai_insights` with
`assistive = true` and never changes a health status, closes an incident, or edits a
target.

```bash
curl -s localhost:3000/api/v1/ai/status | jq                        # { configured: true }
curl -s -X POST "localhost:3000/api/v1/incidents/$INC/ai/analyze" | jq   # classification + root-cause + summary
curl -s "localhost:3000/api/v1/incidents/$INC/ai" | jq
```

Anomaly detection is **pure statistics, no LLM** — it runs on a throttled 5-minute
scan in the scheduler and needs ~30 baseline samples. Force a scan:

```bash
curl -s -X POST localhost:3000/api/v1/anomalies/scan | jq
curl -s localhost:3000/api/v1/anomalies | jq
```

Incident drawer in the dashboard shows the AI panel (ASSISTIVE badge + confidence
bars); the overview shows an anomalies card.

---

## 13. Public status page

```bash
curl -s localhost:3000/api/v1/status | jq
```

Unauthenticated, `STATUS_PAGE_ENABLED`-gated, 30 s cache, and sanitised — no URLs,
ids or failure detail leave the perimeter. Only `production`-environment targets
appear. The dashboard renders it at `http://localhost:5173/status` (no login).

---

## 14. Cleanup

```bash
# delete test targets (ADMIN if auth is on)
for id in $(curl -s localhost:3000/api/v1/targets | jq -r '.data[].id'); do
  curl -s -X DELETE "localhost:3000/api/v1/targets/$id" > /dev/null
done

docker compose down          # add -v to also wipe the Postgres/Redis volumes
```

---

## Appendix A — testing with auth on

Leave `AUTH_ENABLED=true` and set in `.env`:

```dotenv
BOOTSTRAP_ADMIN_EMAIL=admin@ismartpay.local
BOOTSTRAP_ADMIN_PASSWORD=            # choose a strong one
JWT_SECRET=local-dev-secret-at-least-16-chars
```

The API creates that admin on first start (or run `npm run create-admin`). Then:

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"YOUR_ADMIN_PASSWORD"}' | jq -r '.data.accessToken')

curl -s localhost:3000/api/v1/targets -H "authorization: Bearer $TOKEN" | jq
```

Role rules: reads = any authenticated user; target config = `DEVELOPER`/`ADMIN`;
incidents & maintenance windows = `OPERATOR`/`ADMIN`; escalation policies & deletes =
`ADMIN`; compliance report = `COMPLIANCE`/`MANAGEMENT`/`ADMIN`. A create/update of a
money-moving target returns **202 + a pending `config_change_request`** that a
*different* admin must approve via `POST /api/v1/config-requests/:id/approve`.

## Appendix B — response validation rule types

`expectedResponse` accepts any one of these (or a `composite` of them):

| `type` | Fields | Passes when |
| --- | --- | --- |
| `status` | `equals` | HTTP status equals |
| `contains` | `value`, `negate?` | body contains (or, with `negate`, does not) |
| `json_equals` | `path`, `equals` | value at dot-path deep-equals |
| `json_path_equals` | `path`, `equals` | same, JSONPath syntax |
| `numeric` | `path`, `op` (`< <= > >= ==`), `value` | numeric compare at path |
| `json_schema` | `schema` | body validates against the JSON schema |
| `composite` | `mode` (`all`/`any`), `rules[]` | children pass per mode |

`HTTP 200` alone is never "healthy" — pair it with a body rule for anything that
matters.

## Appendix C — key `.env` knobs for testing

| Var | Default | Effect |
| --- | --- | --- |
| `AUTH_ENABLED` | `true` | `false` = no auth (dev only) |
| `INCIDENT_RECOVERY_STREAK` | `2` | clean checks needed to auto-resolve |
| `FLAPPING_THRESHOLD` / `FLAPPING_WINDOW_MINUTES` | `4` / `10` | flapping sensitivity |
| `SCHEDULER_HEARTBEAT_GRACE_MS` | `30000` | how long before the watchdog fires |
| `ALERT_SUPPRESSION_WINDOW_MINUTES` | `30` | min gap between repeat alerts |
| `SLA_REPORT_INTERVAL_MINUTES` | `30` | SLA refresh cadence |
| `WATCHDOG_EXTERNAL_ENDPOINT` | – | where the dead-man's switch POSTs |
| `ANTHROPIC_API_KEY` | – | enables AI analysis endpoints |
