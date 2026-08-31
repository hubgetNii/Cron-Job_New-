# SMS health-digest notifications

SMS is a **summary channel**, not an event stream. The per-event channels
(WEBHOOK / SLACK / EMAIL / PUSH) fire on every incident and recovery. SMS does
**not** — a periodic job snapshots overall system health and sends **at most one
SMS per run, and only when the overall system level changes**.

## The digest

A job in the scheduler process runs every `SMS_DIGEST_INTERVAL_MINUTES`
(default 30). Each run:

1. Reads the current status of every **active, already-checked** service
   (APIs, integrations, databases — anything registered as a target).
2. Rolls them up to one **system level**:
   | Level | When |
   |---|---|
   | `HEALTHY` | every service is UP |
   | `DEGRADED` | one or more services DOWN / DEGRADED / UNKNOWN, none of them money-moving |
   | `CRITICAL` | a **money-moving** or `payment_status` service is DOWN |
3. Compares that level to the previous digest's level.
4. Sends one SMS **iff the level changed** (see Rule A).
5. **Records the snapshot** in `health_digests` either way — so there is a full
   30-minute health history regardless of whether an SMS went out.

### Message format

```
iSmart Health – 10:00 AM
Status: ⚠️ DEGRADED
18/20 services healthy.
2 services require attention: Payment API, SMS API.
Next check: 10:30 AM.
```

CRITICAL calls the offending service out by name:

```
iSmart Health – 10:00 AM
Status: 🔴 CRITICAL
17/20 services healthy.
Critical: Payment API DOWN.
Also degraded: SMS API.
Next check: 10:30 AM.
```

Recovery:

```
iSmart Health – 11:00 AM
Status: ✅ HEALTHY
All 20 services healthy.
Recovered from CRITICAL.
Next check: 11:30 AM.
```

The label (`iSmart Health`) is `SMS_DIGEST_LABEL`; times use `SMS_DIGEST_TIMEZONE`.

## Rule A — send only on overall state change

| Transition | SMS? |
|---|---|
| `HEALTHY → DEGRADED` | ✅ send |
| `DEGRADED → CRITICAL` | ✅ send |
| `CRITICAL → DEGRADED` | ✅ send (partial recovery) |
| `DEGRADED → HEALTHY` | ✅ send (recovery summary) |
| `CRITICAL → HEALTHY` | ✅ send (recovery summary) |
| `HEALTHY → HEALTHY` | ❌ suppress — no routine "all good" SMS |
| `DEGRADED → DEGRADED` | ❌ suppress — "service remains down" does not re-notify |
| `CRITICAL → CRITICAL` | ❌ suppress — escalation is the primary alert engine's job |
| first-ever digest, system HEALTHY | ❌ suppress |
| first-ever digest, system not HEALTHY | ✅ send |

### How the trigger table maps to Rule A

| Requirement | Mechanism |
|---|---|
| Don't SMS every API failure/recovery | only the digest sends SMS; the incident engine's WEBHOOK/PUSH alerts are separate |
| System becomes degraded → send | `HEALTHY → DEGRADED` transition |
| Critical service down → send | `→ CRITICAL` transition (set `SMS_DIGEST_INTERVAL_MINUTES` low, e.g. 5, for near-immediate) |
| Multiple services fail → one consolidated SMS | the digest is a single message listing every affected service |
| Service remains down → don't repeat every 30 min | same level as last digest → suppressed |
| Service / system recovers → send | any downward transition, or `→ HEALTHY` |
| Minor / transient failure → suppress | a blip that retries clean before the next digest never shows a non-UP `last_status`; the incident engine already absorbs transient failures |
| No change from previous check → suppress | `previous === current` → suppressed |

## Configuration

```dotenv
SMS_DIGEST_ENABLED=true
SMS_DIGEST_INTERVAL_MINUTES=30          # 5–10 for near-immediate critical alerts
SMS_DIGEST_RECIPIENTS=+233200000000,+233240000000
SMS_DIGEST_TIMEZONE=Africa/Accra
SMS_DIGEST_LABEL=iSmart Health

# transport (shared with per-event SMS) — pending the real MPSMS SMS API
SMS_PROVIDER_URL=
SMS_PROVIDER_API_KEY=
```

With no `SMS_PROVIDER_URL` / no recipients, the digest still runs and is
recorded — the send is **logged only** (visible in the scheduler log and in the
digest's `reason`), never dropped.

## Endpoints

| | |
|---|---|
| `GET /api/v1/health-digests` | recent digests (history) |
| `GET /api/v1/health-digests/latest` | the current system-health summary |
| `GET /api/v1/health-digests/preview` | what the next digest *would* say — does not persist or send |
| `POST /api/v1/health-digests/evaluate` | force a run now (ADMIN/OPERATOR); sends an SMS only if the level changed |

## Testing it

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@admin.local","password":"pass"}' | jq -r '.data.accessToken')

# see what it would send right now
curl -s localhost:3000/api/v1/health-digests/preview -H "authorization: Bearer $TOKEN" | jq '.data.message,.data.reason'

# take a real snapshot (SMS only if the level changed since the last one)
curl -s -X POST localhost:3000/api/v1/health-digests/evaluate -H "authorization: Bearer $TOKEN" | jq

# break a target (see docs/testing-with-real-endpoints.md §8), evaluate again,
# and the digest flips HEALTHY → DEGRADED / CRITICAL and sends.
```

## Data model

`health_digests` — one row per run: `overall_level`, `previous_level`, service
counts, `affected` (jsonb list), `sms_sent`, `sms_recipients`, `reason`,
`next_check_at`. Migration `1725000012000`.

## Pending

The real MPSMS SMS API (`vend.ismartghana.com/api/topup` family, or a dedicated
SMS endpoint) will be wired into `SmsChannel` when the spec is provided. The
digest engine, rules, history and endpoints above are complete and transport-agnostic.
