# Health-digest notifications (SMS + email)

The digest is a **summary channel**, not an event stream. The per-event channels
(WEBHOOK / SLACK / PUSH, and per-incident email) fire on every incident and
recovery. The digest does **not** — a periodic job snapshots overall system
health and, by default, notifies **only when the overall system level changes**.

- **SMS** — a short summary. State-change only, per contact (unless flagged
  `digest_every_run`).
- **Email** — a **full per-system status report** (text + HTML): every monitored
  system with its status, 24h uptime, last response time and whether it has an
  open incident, plus the overall level and open-incident count. Ibrahim
  (`ibrahim@ismartghana.com`) is registered with `digest_every_run = true`, so he
  gets the full report every run — "day in and out".

## Email setup

Set an SMTP transport in `.env` — either a nodemailer well-known service or a host:

```dotenv
SMTP_SERVICE=gmail            # gmail / outlook365 / zoho / …   (OR use SMTP_HOST)
# SMTP_HOST=mail.ismartghana.com
# SMTP_PORT=587
# SMTP_SECURE=                # true for 465
SMTP_USER=notifications@ismartghana.com
SMTP_PASSWORD=…               # an app password, not the login password
ALERT_EMAIL_FROM=cron-monitor@ismartghana.com
```

Restart the scheduler. Until SMTP is set the report is **logged only** (visible
in the scheduler log and the digest `reason`), never dropped.

The email report:

```
[DEGRADED] iSmart Health — 2/3 systems healthy         ← subject

iSmart Health — full platform status
31 Aug 2026, 10:00

Overall: ⚠️ DEGRADED  (was HEALTHY)
Systems: 2 healthy · 0 degraded · 1 down · 3 total
Open incidents: 1

All systems:
  🔴 DOWN      Payments API   up24h 71.20% · resp — · INCIDENT OPEN · money-moving
  ✅ UP        Ledger API     up24h 99.90% · resp 120 ms
  ✅ UP        SMS API        up24h 100.00% · resp 120 ms

Next check: 10:30 AM
```

(HTML alternative: a coloured status table.)

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
2 services need attention: Payment API, SMS API.
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

## Routine SMS status broadcast (hourly)

On top of Rule A, a second job sends the **full platform status** to *every* SMS
contact on a fixed cadence — hourly by default — **regardless of whether anything
changed**. This is the SMS counterpart of the every-run email: a recurring
heartbeat so the on-call always knows the platform is being watched.

Example message:

```
iSmart Health – 2:00 PM
Status: ✅ HEALTHY
Systems: 6 total · 6 up · 0 down
Open incidents: 0
Uptime 24h (avg): 98.94%
Next SMS: 3:00 PM.
```

When something needs attention it also lists the affected systems (money-moving
first, up to 6, then `…+N more`):

```
iSmart Health – 2:00 PM
Status: 🔴 CRITICAL
Systems: 6 total · 4 up · 2 down
Open incidents: 2
Uptime 24h (avg): 91.20%
Needs attention:
- Payment API: DOWN (money-moving)
- SMS API: DEGRADED
Next SMS: 3:00 PM.
```

- Recipients: **all** active SMS `notification_contacts` + `SMS_DIGEST_RECIPIENTS`
  — the `digest_every_run` flag does not apply, the broadcast always goes to
  everyone.
- Runs in the scheduler process. First send is one interval after start (no
  immediate fire on restart).
- Every broadcast is recorded in `health_digests` with `reason` starting
  `routine SMS status broadcast`.

Endpoints:

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/api/v1/health-digests/sms-preview` | the text + recipient list, no send |
| `POST` | `/api/v1/health-digests/broadcast-sms` | send now to every SMS contact (ADMIN/OPERATOR) |

## Configuration

```dotenv
SMS_DIGEST_ENABLED=true
SMS_DIGEST_INTERVAL_MINUTES=30          # 5–10 for near-immediate critical alerts
SMS_DIGEST_RECIPIENTS=+233200000000,+233240000000
SMS_DIGEST_TIMEZONE=Africa/Accra
SMS_STATUS_BROADCAST_ENABLED=true       # the hourly full-status SMS
SMS_STATUS_INTERVAL_MINUTES=60
SMS_DIGEST_LABEL=iSmart Health

# transport — the iSmartGhana bulk-SMS gateway (shared with per-event SMS)
SMS_GATEWAY_URL=http://157.180.53.137:5665/api/SendSms
SMS_API_ID=<from the provider>
SMS_API_PASSWORD=<from the provider>
SMS_SENDER_ID=Operation
SMS_TYPE=P            # P = promotional/plain
SMS_ENCODING=T        # T = text (GSM-7), U for unicode
SMS_VALIDITY_SECONDS=1800
SMS_CALLBACK_URL=     # optional delivery-report webhook
SMS_DLT_ENTITY_ID=    # optional
SMS_DLT_TEMPLATE_ID=  # optional
```

With no gateway configured (or no recipients), the digest still runs and is
recorded — the send is **logged only** (visible in the scheduler log and in the
digest's `reason`), never dropped.

### The gateway (`services/alert/sms-gateway.ts`)

The provider expects a **GET** with everything in the query string, including
`api_id` and `api_password`:

```
GET http://157.180.53.137:5665/api/SendSms
    ?api_id=…&api_password=…&sms_type=P&encoding=T&sender_id=Operation
    &phonenumber=233551530764&textmessage=…&ValidityPeriodInSeconds=1800
    &uid=<8 hex>&isScheduled=false[&callback_url=…]
```

- Numbers are normalised to digits only (`+233…` / `00233…` → `233…`).
- Each message gets a random 8-hex `uid` for tracking.
- `api_password` is on the logger's redact list and the built URL is never
  logged — only `{ to, uid, statusCode, ok }` plus the response body (which
  carries no credentials) so the exact response shape can be confirmed on the
  first real send.
- A 2xx with an obvious error flag in the body (`status: "Failed"`,
  `ErrorCode` ≠ 0, an `error` string) is treated as a failure; anything
  ambiguous is left as success so real sends are never hidden.

> The gateway is plain **HTTP** and puts the password in the URL — that is the
> provider's contract, not a choice. Keep `SMS_API_PASSWORD` out of source
> control (it's in `.env`, which is gitignored).

## Recipients — the `notification_contacts` table

The standing list of who gets notifications "day in and out". One row per
address:

| column | meaning |
|---|---|
| `channel` | `EMAIL` or `SMS` |
| `address` | email address or phone number |
| `digest` | receives the health digest (default true) |
| `digest_every_run` | `true` → every run (a full-status heartbeat); `false` → only on a level change (Rule A) |
| `incident_alerts` | `true` → also gets an alert on this contact's channel every time an incident **opens**, is flagged **flapping**, or **recovers** (in addition to `ALERT_DEFAULT_CHANNELS`). Independent of `digest`. |
| `is_active` | soft on/off |

> `incident_alerts` is per-incident, not per-check — one alert on open, one on
> recovery. It rides the normal alert delivery cycle (maintenance windows still
> suppress it). For SMS the text is the incident subject + failure type + count.

Managed via the API (ADMIN):

```bash
# add an SMS number, state-change only
curl -s -X POST localhost:3000/api/v1/notification-contacts \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Ops phone","channel":"SMS","address":"233553476530"}'

# add an email that gets the full status every run
curl -s -X POST localhost:3000/api/v1/notification-contacts \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Ibrahim","channel":"EMAIL","address":"ibrahim@ismartghana.com","digestEveryRun":true}'

curl -s localhost:3000/api/v1/notification-contacts -H "authorization: Bearer $TOKEN" | jq
```

`SMS_DIGEST_RECIPIENTS` (env) is still honoured and merged into the SMS list.

## Endpoints

| | |
|---|---|
| `GET /api/v1/health-digests` | recent digests (history) |
| `GET /api/v1/health-digests/latest` | the current system-health summary |
| `GET /api/v1/health-digests/preview` | what the next digest *would* say — does not persist or send |
| `POST /api/v1/health-digests/evaluate` | force a run now (ADMIN/OPERATOR); notifies per Rule A / `digest_every_run` |
| `GET/POST/PUT/DELETE /api/v1/notification-contacts` | manage the recipient list (ADMIN for writes) |

## Testing it

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"YOUR_ADMIN_PASSWORD"}' | jq -r '.data.accessToken')

# see what it would send right now
curl -s localhost:3000/api/v1/health-digests/preview -H "authorization: Bearer $TOKEN" | jq '.data.message,.data.reason'

# take a real snapshot (SMS only if the level changed since the last one)
curl -s -X POST localhost:3000/api/v1/health-digests/evaluate -H "authorization: Bearer $TOKEN" | jq

# break a target (see docs/testing-with-real-endpoints.md §8), evaluate again,
# and the digest flips HEALTHY → DEGRADED / CRITICAL and sends.
```

## Data model

- `health_digests` — one row per run: `overall_level`, `previous_level`, service
  counts, `affected` (jsonb), `sms_sent`/`sms_recipients`,
  `email_sent`/`email_recipients`, `reason`, `next_check_at`.
  Migrations `1725000012000` + `1725000014000`.
- `notification_contacts` — the recipient registry. Migration `1725000013000`.

## Testing a real send

```bash
# per-event style — sends one SMS immediately to a number
curl -s -X POST localhost:3000/api/v1/alerts/test \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"channel":"SMS","recipient":"+233551530764","message":"cron monitor test"}' | jq

# digest style — evaluate now; sends only if the overall level changed
curl -s -X POST localhost:3000/api/v1/health-digests/evaluate \
  -H "authorization: Bearer $TOKEN" | jq
```

Check the scheduler / API log line `SMS gateway response` for the provider's
raw body. Confirmed shape (successful send):

```json
{ "message_id": 2026083116353908975, "status": "S",
  "remarks": "Message Submitted", "uid": "5bf9ba43",
  "phonenumber": "233553476530", "peId": null, "dltTempId": null }
```

`status: "S"` = accepted. `looksLikeFailure()` treats any `status` not in the
success set, or a `remarks`/`error` that reads as a failure, as a failed send.
