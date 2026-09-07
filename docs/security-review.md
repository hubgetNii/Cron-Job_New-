# Security review — pre-public-exposure

Audit run 2026-09-06 against the checklist: API keys · RLS · IDOR · git secret
scan · admin-route locking · user isolation · rate limiting · storage buckets ·
input validation · unauthenticated routes · SQL injection · sensitive logs ·
response trimming.

The trigger is the plan to expose the API publicly through a tunnel so a
Vercel-hosted dashboard can reach it. That changes the threat model from
"trusted LAN" to "internet".

---

## Must fix before public exposure

> **Status 2026-09-07:** #1, #2, #3 **done** on the local instance — new
> `JWT_SECRET`; new `CREDENTIAL_ENCRYPTION_KEY` + all 4 target credentials
> resealed and verified checking UP; `niiaayitey@gmail.com` is the sole active
> ADMIN, `admin@admin.local` + `admin@ismartpay.local` disabled (login returns
> 401), all their sessions revoked. #4 and #5 are deploy-time.

### 1. JWT signing secret is a published placeholder — HIGH ✅ done
`.env` has `JWT_SECRET=local-dev-jwt-secret-change-me-please`. That exact string
was published in this repo's git history (10 occurrences in old commits/docs).
**Anyone who reads the repo can forge valid access tokens for any role,
including ADMIN** — the entire auth layer is bypassed.

**Fix:** `openssl rand -hex 48` → set `JWT_SECRET`, restart the API. All existing
sessions are invalidated (expected). Do this *before* the tunnel is up.

### 2. Credential encryption key falls back to a public hard-coded key — HIGH ✅ done
`CREDENTIAL_ENCRYPTION_KEY` is unset, so `credential-cipher.ts` uses
`DEV_KEY = sha256("fintech-cron-monitor:dev-kek")` — a constant in the
open-source tree. Every monitored target's stored credentials (MPSMS
accesscode/clientcode, any future API keys) are "encrypted at rest" with a key
anyone can compute. The DB is not reachable through the tunnel, but the
at-rest protection is void.

**Fix:** `npm run reseal-credentials` generates a fresh key, re-encrypts every
stored target credential under it (decrypting each with whatever key still opens
it), and prints the key to add to `.env`. Restart the API + scheduler after.
No target delete / re-seed needed.

### 3. Bootstrap admin password published + a trivially weak user — MEDIUM ✅ done
- `BOOTSTRAP_ADMIN_PASSWORD=cronmon-admin-2026` appears 25× in git history.
- A user `admin@admin.local` / `pass` exists (created for local testing). `pass`
  is a dictionary word — cracked in the first handful of guesses even against
  the login limiter.

**Fix:** `npm run rotate-admin -- <your-email>` — ensures `<email>` is an ADMIN
with a fresh 24-char generated password (printed once), **disables** the two
test accounts (not deleted — they're referenced by config-change-request
history) and revokes every session it touches. `BOOTSTRAP_ADMIN_PASSWORD` is
already cleared in `.env`.

### 4. Run the exposed instance as `NODE_ENV=production` — MEDIUM
`NODE_ENV=development` keeps the insecure-KEK fallback (see #2), pretty-print
logging, and skips the env layer's production assertions
(`CREDENTIAL_ENCRYPTION_KEY` required, `AUTH_ENABLED=false` refused). For the
public deploy, build and run properly:
```bash
npm run build && NODE_ENV=production node dist/server.js   # + scheduler, watchdog
```
or the `docker-compose.prod.yml` path.

### 5. Audit-log privilege hardening — do it now
`scripts/harden-audit.sql` (`REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs`) has
not been run against this database. Run it as the DB superuser.

---

## Fixed in this review (commit accompanying this file)

| # | Issue | Fix |
|---|---|---|
| 6 | `POST /auth/refresh` — unauthenticated, no rate limit, does a DB + hash lookup per call | added a per-IP limiter (`refreshRateLimit`, 6× the login points) |
| 7 | Login limiter keyed by `ip:email` only — credential-stuffing across accounts from one IP was uncapped | added a parallel per-IP login bucket (3× the points) |
| 8 | `GET /notification-contacts` returned all contact phone numbers / emails to **any** authenticated principal (incl. VIEWER) | now `ADMIN / OPERATOR / COMPLIANCE` only |
| 9 | `GET /health-digests/sms-preview` returned the SMS recipient phone list to any authenticated principal | now `ADMIN / OPERATOR` only |

---

## Reviewed — no action needed

| Area | Finding |
|---|---|
| **SQL injection** | Clean. Every query is parameterised; the only string-interpolated SQL fragments are hard-coded column lists / whitelisted `SET` columns (`monitored-apis.repo`, `notification-contacts.repo`, the dynamic `WHERE` builders in `incidents` / `alerts` / `traces` / `retention`). No user value ever reaches a SQL string. |
| **Input validation** | Clean. Every route body/query/param goes through a `zod` schema `.parse()`. `express.json({ limit: '1mb' })` caps body size. IDs validated as `z.string().uuid()`. |
| **Unauthenticated routes** | Only `/live` `/ready` `/health` `/health/scheduler` (probes), `/api/v1/status` (sanitised public status page, `STATUS_PAGE_ENABLED`-gated, HTTP-cached), and `/api/v1/auth/{login,refresh}` are open. Everything under `/api/v1/*` is behind `authenticate` + `apiRateLimit`. |
| **Admin-route locking** | Every mutation is role-gated: target write = `DEVELOPER/ADMIN`, delete = `ADMIN`; incident ack/resolve = `OPERATOR/ADMIN`; alerts/push/escalation-policies/contacts = `ADMIN`; four-eyes config requests = `ADMIN` (+ DB `CHECK reviewed_by <> proposed_by`); latency thresholds / retention run / trace raw-reveal = `ADMIN`; trace raw-reveal is additionally audited per call. |
| **IDOR / user isolation** | No per-user or per-tenant data partition exists *by design* — this is a single-org tool with global RBAC roles; every operator sees every target/incident. Resource ids are server-generated UUIDs, `zod`-validated. The one sensitive cross-boundary action (unmasked trace reveal) is `ADMIN` + audited. No classic IDOR. |
| **Rate limiting** | `apiRateLimit` (300/min per user-or-IP) on the whole authed surface; login now double-bucketed (see #7). Redis-backed with in-memory insurance fallback. |
| **Sensitive logs** | `pino` redacts `authorization`/`cookie`/`x-api-key` headers and `*.token` `*.password` `*.secret` `*.apiSecret` `*.encrypted_credentials` `credentials` etc. The OAuth2 token cache and FCM client deliberately never log token bodies (masked+scrubbed server-side line instead). The error handler returns a generic `"Internal server error"` on any 5xx — no stack trace, no `err.message`, to the client. |
| **Response trimming** | Target responses expose `hasCredentials: boolean` only — never the credential envelope. `GET /auth/me` returns no password hash (`findUserById` → `toUser`, hash-free; only `login` reads the hash and only to compare it). Public status page strips URLs, ids and failure detail. Trace reads are masked; the unmasked copy is the audited ADMIN path. |
| **Git secret scan** | `.env` never committed (`git log --all -- .env` empty). Full-history `git grep` for every real secret value (Gmail app pw, SMS gateway pw, MPSMS accesscode, Firebase apiKey/VAPID) → **0 hits**. No `-----BEGIN` private keys. The only leaked strings are the *placeholder* `JWT_SECRET` and `BOOTSTRAP_ADMIN_PASSWORD` — which are the values actually in use → issues #1 and #3. |
| **RLS** | N/A — raw PostgreSQL via `pg`, authz enforced in the application (RBAC middleware), not row-level policies. Defense-in-depth option: give the app a least-privilege DB role and `REVOKE` on `audit_logs` (partly covered by `harden-audit.sql`). Not a vulnerability, a hardening opportunity. |
| **Storage buckets** | N/A — the platform has no object storage. Report exports and trace CSV/XLSX are generated in-memory and streamed; nothing is persisted to a bucket. |

---

## Lower-priority notes

- **Health endpoints leak operational metadata** unauthenticated: `/health`
  returns the app version; `/health/scheduler` returns `instanceId`,
  `missedRunTotal`, `queueDepth`. `/health/scheduler` is intentionally open so
  external uptime monitors can watch it (see deployment.md). Acceptable, but if
  you want it tighter, put a shared-secret query param on it and drop
  `instanceId`.
- **AI analyze endpoint spends real Anthropic credits** — `POST
  /incidents/:id/ai/analyze` = 3 model calls. Gated to `OPERATOR/ADMIN` and rate
  limited, but a compromised operator token could run up a bill. Consider a
  per-day cap if the API is broadly exposed.
- **`pino` redact wildcards are single-level** (`*.token` matches `x.token`, not
  `a.b.token`). Mitigated by the masking helpers being used at every log site
  that touches vendor payloads; still, avoid `log.info({ vendorResponse })`.
