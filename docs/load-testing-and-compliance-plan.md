# Fintech Load Testing & Compliance Assurance — Feature Plan (Phases 21–28)

Status: **Phases 21–27 BUILT (2026-10-15/16); 28 planned.** Open items: see `docs/load-testing-open-items.md`. Continues numbering after Phases 12–20 (observability & reporting).

## 1. Goal

A module inside the Cron Monitor that, for fintech/payment APIs registered with it, can:

1. Generate and run **realistic load, stress, spike, soak and breakpoint** tests against those endpoints.
2. Run **fintech-specific correctness-under-load** tests (idempotency, double-spend races, callback replay, reconciliation, settlement).
3. Run **abuse-resilience** tests aligned to OWASP API Security Top 10.
4. Judge every run against explicit **SLO pass/fail gates**.
5. Produce a **compliance evidence pack** mapped to PCI DSS, OWASP, Bank of Ghana and global frameworks.
6. Answer one question per service: *"Is it production-ready, and what is the evidence?"*

**Non-goals / honesty clause.** A load-testing tool cannot *certify* PCI DSS or any regulation. It produces **evidence** and surfaces gaps. Formal attestation needs a QSA / auditor, and PCI 11.3/11.4 vulnerability scanning and penetration testing remain separate activities. The UI and reports must say this plainly. Control mappings in §6 must be reviewed by compliance before they are shown as "covered".

## 2. Safety model (non-negotiable — design this first)

Context: `ismartpay-no-sandbox-risk` — iSmartPay money-moving endpoints hit **production**. Load-testing them could move real money, exhaust wallets, trigger fraud/AML controls, or breach the provider's terms. So:

| Control | Rule |
|---|---|
| **Environment class** per target: `MOCK` / `SANDBOX` / `STAGING` / `PRODUCTION` | Stored on the target. Load profiles are gated by class. |
| Money-moving load | Allowed **only** on `MOCK`, `SANDBOX`, `STAGING`. Hard-blocked on `PRODUCTION` at validation layer *and* in the runner (defence in depth). |
| Production | Read-only endpoints only, capped RPS (default ≤ 2 rps, ≤ 5 min), explicit written-approval reference required. |
| Authorization to test | Each target needs `load_test_authorization` (who approved, scope, window, provider confirmation reference). Without it, tests cannot be created. |
| Four-eyes | Creating/approving a plan or raising any cap uses existing `config_change_requests` (different ADMIN approves). |
| Kill switch | Global `.run/DISABLED`-style flag + per-run abort button + automatic abort on error-rate/latency guardrail (e.g. >25% 5xx for 30s). |
| Hard ceilings | Env-configured max VUs / RPS / duration per environment class; plans cannot exceed them. |
| Test windows | Runs only inside an approved window; outside → rejected. |
| SSRF / egress | Reuse `lib/ssrf.ts`; runner egress allow-list = registered targets only. |
| Test data | Synthetic only: provider test PANs / test MSISDN ranges / test wallets. **Never real PAN, CVV, PIN or customer data.** Validator rejects Luhn-valid PANs that are not in the approved test-BIN list. |
| Monitor isolation | During a run the target's regular health checks are tagged/paused and a maintenance window suppresses alerts, so load traffic never opens false incidents or skews SLA/uptime (extends existing maintenance-window suppression). |
| Mock-first | Ship a **simulator** (configurable latency, error rate, rate-limit, idempotency, webhook behaviour) so every scenario can be rehearsed with zero provider risk before any sandbox run. |

## 3. Architecture

```
Dashboard (Load Tests page)
   │  REST  /api/v1/load-tests/*
   ▼
API ── plan/scenario/data-set CRUD, approvals, compliance matrix, reports
   │  enqueue (BullMQ, existing Redis)
   ▼
Load Orchestrator (new process: `loadtest-worker`)
   │  1. preflight (safety gates, authorization, window, monitor isolation)
   │  2. render scenario → k6 script
   │  3. spawn k6 (docker, resource-capped, egress-restricted)
   │  4. stream metrics (k6 JSON/StatsD) → aggregator, live guardrail checks
   │  5. teardown, evaluate SLO gates, write findings + evidence
   ▼
Postgres (results, findings, evidence)        Simulator (mock gateway) for rehearsal
```

**Engine decision (recommended): k6 as the load generator, orchestrated by our code.**
- Why: mature, efficient (Go), scenario executors for ramp/constant-arrival-rate/spike, thresholds, handles tens of thousands of rps per box; we avoid writing/validating a load engine.
- Alternative: native undici engine in Node — fine to ~1–2k rps, reuses our executor/masking, but we'd own coordinated-omission correctness and scaling. Keep as a *later* "lite" option, not v1.
- Open-model arrival rate (not closed-loop VUs) is the default for payment traffic, to avoid coordinated omission.

New process joins docker-compose (`loadtest-worker`); k6 runs as a child container with CPU/mem limits. The worker is separate from api/scheduler/watchdog so a heavy run can never starve the cron engine (the project's core guarantee).

## 4. Test taxonomy

### 4.1 Performance profiles (per endpoint or journey)
Smoke · Baseline · Load (expected peak) · Stress (to failure) · Spike (sudden 10×) · Soak (4–24h, leak/drift) · Breakpoint (find max sustainable TPS) · Scalability (step-ups) · Recovery (post-spike return to baseline).
Fintech peaks to model: salary-day / month-end, festive spikes, utility-bill deadlines, flash promos, settlement-cutoff bursts.

### 4.2 Fintech correctness under load
- **Idempotency**: same `Idempotency-Key`/reference fired N× concurrently → exactly one financial effect.
- **Double-spend / race**: parallel debits on one wallet near zero balance → no negative balance, no over-spend.
- **Duplicate callback / webhook replay**, out-of-order and delayed callbacks, signature validation under load.
- **Timeout & retry storms**: provider slow → client retries → amplification check; verify no duplicate charge on retry.
- **Partial failure**: debit succeeded / credit failed → reconciliation produces correct state.
- **Reconciliation & settlement**: counts and amounts of accepted requests == ledger == settlement file (zero tolerance on mismatch).
- **Amount/currency boundaries**: min/max/precision/rounding (GHS 2dp), limits, velocity limits.
- **Auth lifecycle under load**: token expiry storms, refresh thundering herd (existing OAuth2 cache pattern is a good target).
- **Status-check consistency**: `check`/query returns terminal state consistently under load.

### 4.3 Channel coverage (scenario packs)
| Pack | Examples |
|---|---|
| Mobile money | collections (pull/USSD prompt), disbursements (push), status query, callbacks — MTN MoMo, Telecel Cash, AT Money |
| Cards | authorise/capture/refund/void, 3-D Secure redirect flow, tokenised card-on-file |
| Bank / interbank | account verification (name enquiry), transfers (GhIPSS-style), direct debit |
| Wallet | top-up, P2P, balance, statement |
| Utility / bills | ECG, GWCL, airtime, data bundles (existing MPSMS topup targets) |
| QR / USSD | QR pay, USSD session flow |
| Messaging | SMS/OTP throughput and delivery receipts |
| Back-office | settlement fetch, dashboard metrics, reporting endpoints |

Each pack = reusable scenario templates with parameterised payloads, fed from approved test data sets.

### 4.4 Abuse-resilience (OWASP API Security Top 10 — 2023), *low-rate, non-exploit*
API1 BOLA (ID enumeration returns 403/404 not data) · API2 broken auth (invalid/expired/missing tokens rejected at volume, lockout/limiter behaviour) · API3 property-level exposure (response field allow-list check) · **API4 unrestricted resource consumption** (rate limits actually engage, payload-size/pagination caps) · **API6 sensitive business flows** (automated abuse of payment/OTP/top-up flows is throttled) · API7 SSRF (webhook URLs) · API8 security misconfiguration (headers, TLS version, CORS, verbose errors) · API9 improper inventory (undocumented/legacy versions reachable) · API10 unsafe consumption of third-party APIs.
Scope guard: this validates *defences hold under pressure*; it is not an exploit framework and stays within authorised targets.

## 5. Pass/fail model (SLOs as code)

Per scenario, thresholds stored with the plan and evaluated post-run (and live for guardrails):
- Latency: P95/P99 vs per-API bands (reuse `latency_thresholds`).
- Error rate (separate: 5xx, 4xx-unexpected, timeouts, business-declines).
- Throughput achieved vs target TPS; drop/queue rate.
- **Correctness: zero tolerance** — duplicate charges, negative balances, reconciliation mismatches, unsigned/replayed callbacks accepted.
- Resource/recovery: time-to-recover after spike, no monotonic latency growth in soak.
- Security: rate-limit engaged, no sensitive data in responses/logs, TLS/headers baseline.
Verdict per run: `PASS` / `PASS_WITH_WARNINGS` / `FAIL`; per service rollup → **Production Readiness Score** (reuse `health-score.ts` pattern, with correctness & security as gating rather than weighted).

## 6. Compliance mapping (evidence, not certification)

Model: `compliance_controls` (framework, control id, title, how-testable) ⇄ `compliance_evidence` (control × run × result × artefact). A run auto-attaches evidence to the controls its scenarios exercise.

| Framework | What load testing can evidence |
|---|---|
| **PCI DSS v4.0.1** | Req 3/4: no PAN/CVV persisted or logged in test artefacts, TLS ≥1.2 on all channels · Req 6: error handling doesn't leak data, input handling at volume · Req 7/8: auth/session controls, lockout, token expiry · Req 10: audit logs captured and complete under load · Req 11: scheduled resilience/regression testing evidence (supports, does **not** replace, 11.3 scans / 11.4 pen tests) · Req 12.10: incident detection/alerting worked during stress. |
| **OWASP** | API Security Top 10 (2023) per §4.4; ASVS V-series for auth/session/API where applicable. |
| **Bank of Ghana** | Payment Systems & Services Act 2019 (Act 987) and BoG operational-resilience / cyber & information-security directives: availability, capacity, DR/recovery evidence, incident response, reconciliation integrity. Exact clause references to be supplied/verified by the compliance owner. |
| **Data protection** | Ghana Data Protection Act 2012 (Act 843); GDPR where EU data subjects — test data contains no personal data; logs masked. |
| **EMV / 3DS / PSD2 SCA** | 3-D Secure flow stability and challenge/frictionless ratio under load (card channels only). |
| **ISO 20022 / ISO 8583** | Message validation and field-handling robustness where those formats are used. |
| **AML/CFT & fraud** (FATF-aligned) | Velocity/limit controls trigger correctly at volume; no bypass via parallelism. |
| **SOC 2 / ISO 27001** | Availability and change-management evidence (test run records, approvals, audit trail). |
| **Operational resilience** (DORA-style, NIST CSF) | Documented resilience testing cadence, results, remediation tracking. |

Every mapping row carries a `reviewed_by` and `status` (`DRAFT` until compliance signs off) — consistent with the project rule that unverified response/validation rules are drafts.

## 7. Data model (new migrations)

- `load_targets_config` — per-target `environment_class`, authorization ref, window, caps.
- `load_test_plans` / `load_test_scenarios` — profile, executor, stages, payload templates, thresholds, data set ref.
- `load_test_data_sets` — approved synthetic data (test BINs/MSISDNs/wallets); no real PII; validated on write.
- `load_test_runs` — plan, started/ended, status, verdict, aborted_by/reason, k6 version, git/commit of target config, environment snapshot.
- `load_test_metrics` — per-run time-bucketed aggregates (rps, P50–P99, error classes) — **aggregates only**, not per-request rows, to bound storage; sampled masked traces for failures only (reuse `masking.ts` + trace pipeline).
- `load_test_findings` — typed findings (perf / correctness / security / compliance), severity, evidence, recommendation (reuse failure-taxonomy + recommendations style).
- `compliance_controls`, `compliance_evidence`.
- Everything audited via existing `audit_logs`; retention classes added to `retention.service.ts`.

## 8. API surface (`/api/v1/load-tests/*`, RBAC + audit)

`plans` CRUD + submit-for-approval · `plans/:id/approve` (four-eyes) · `plans/:id/run` · `runs`, `runs/:id`, `runs/:id/abort`, `runs/:id/live` (SSE) · `runs/:id/findings` · `data-sets` · `compliance/controls`, `compliance/matrix?service=` · `readiness/:apiId` · reports via existing `/reports/:type` (new types: `load-test`, `production-readiness`, `compliance-evidence`; CSV/XLSX/PDF already supported).
Roles: DEVELOPER/OPERATOR create & dry-run on MOCK; ADMIN approves anything beyond MOCK; COMPLIANCE read-only on evidence.

## 9. Dashboard

New **Load Testing** nav section: Plans · Run console (live rps/latency/error charts, abort) · Results (verdict, SLO table, percentile charts, comparison vs previous run) · Findings · Compliance matrix (framework × control × evidence status) · Readiness scorecard per service. Reuses dataviz palette, Observability drawer patterns, ASSISTIVE-style badges for DRAFT mappings.

## 10. Integration with what exists

- Target registry (`monitored_apis`) is the source of endpoints/auth; OAuth2 token cache reused for handshake scenarios.
- `masking.ts`, `pci.ts`, `ssrf.ts`, RBAC, four-eyes, audit log, retention, reports engine, latency thresholds, health-score, maintenance windows — all reused.
- Incident engine: load-run findings **do not** open production incidents; they open `load_test_findings`. Guardrail aborts raise one alert to the run owner.
- Optional later: AI advisory summary of a run (same advisory-only `AiClient` seam; never in the verdict path).

## 11. Phases

| Phase | Deliverable | Gate |
|---|---|---|
| **21 Safety foundation** | env classes, authorization records, window/ceiling config, kill switch, monitor isolation, migrations, RBAC/four-eyes wiring | Unit/DB tests prove PRODUCTION money-moving load is rejected at API *and* runner |
| **22 Simulator** | mock gateway for mobile money/card/bank/utility with tunable latency/errors/rate-limit/idempotency/webhooks | Deterministic, used by all later tests |
| **23 Runner & orchestrator** | `loadtest-worker`, k6 script generator, arrival-rate profiles, live aggregation, guardrail abort, results storage | Smoke→load→spike on simulator; abort works |
| **24 Scenario packs & data** | channel packs (§4.3), synthetic data sets + validator, payload templating (extends `{{uuid}}`) | Packs run green against simulator |
| **25 Correctness suite** | idempotency, race, callback replay, retry storm, reconciliation checks | Seeded simulator bugs are *caught* (test the tests) |
| **26 Security/abuse suite** | OWASP API Top-10 resilience scenarios, rate-limit/auth/size checks, header/TLS baseline | Findings generated for deliberately weak simulator mode |
| **27 SLO engine & readiness** | thresholds, verdicts, findings + recommendations, readiness score, run comparison | Reproducible verdicts on stored runs |
| **28 Compliance evidence & reporting** | controls library (DRAFT), auto-evidence, matrix UI, PDF/XLSX evidence pack, retention | Compliance owner reviews & signs off mappings |
| *29 (later)* | Distributed runners, scheduled regression load tests in CI, native "lite" engine, AI run summaries | — |

Suggested order: 21 → 22 → 23 first (nothing touches a real provider until all three pass), then 24/25 in parallel with 26.

## 12. Risks

- **Real-money / provider harm** — mitigated by §2; no production money-moving load, ever, without sandbox or written provider approval.
- **Generator becomes the bottleneck** (false results) — monitor generator CPU/lag; flag runs where generator saturated; open-model arrival rates.
- **Load worker starves core monitor** — separate process/container, resource caps.
- **False compliance confidence** — DRAFT mappings, explicit disclaimer, reviewer sign-off field.
- **Test data leakage** — synthetic-only validator, masking on every stored artefact.
- **Provider rate-limits/bans** — per-target ceilings, ramp-ups, abort guardrails, advance notice to provider.
- **Non-deterministic third-party behaviour** — rely on simulator for regression; sandbox runs are periodic confirmation.

## 13. Decisions (answered 2026-10-15)

1. **Ownership/permission:** iSmart owns the APIs; the Head of Operations authorises load testing pre-commercial-launch. Still recorded per target in `load_test_authorization` (approver, scope, window) so the audit trail exists.
2. **Environment:** sandbox. Production money-moving load stays hard-blocked regardless.
3. **Volumes:** no peak figures yet → plan uses **relative tiers** (1×/2×/5×/10× of an agreed launch estimate) plus **breakpoint tests that discover real capacity empirically**. Business can set the launch estimate later; results then read "sustained N× target".
4. **Worker host:** dedicated, ephemeral Linux VM (Hetzner, same account), *not* the Mac and *not* the monitor host. Placed in the sandbox's region where possible. Start 4 vCPU / 8 GB; scale out to several runners for large tests. Spun up per run or kept small and idle otherwise.
5. **Compliance depth:** audit-grade, serving two audiences — internal/QSA (PCI DSS v4.0.1 evidence) and Bank of Ghana (resilience, availability, reconciliation, incident response). Adds: immutable evidence (hashed run artefacts), reviewer sign-off workflow, control-to-evidence traceability, versioned control library.
6. **Engine:** see section 14.

## 14. Engine: k6 vs all-Node

| | **k6** | **All Node** |
|---|---|---|
| Requirements | k6 binary or `grafana/k6` Docker image on the worker VM; Docker (already used); scripts are JavaScript but run in k6's own runtime (no Node APIs/npm unless bundled); metrics out via JSON/StatsD/Prometheus; AGPL licence is fine for running it as an external tool | Nothing new; Node 22 already in the repo |
| Throughput | Go; roughly thousands of rps per vCPU for simple APIs | Single-threaded loop; needs worker_threads/cluster beyond a few k rps |
| Timing accuracy | Built-in arrival-rate executors; avoids coordinated omission | We must implement and validate ourselves; GC pauses skew latency |
| Load shapes | Ramp, spike, soak, constant-arrival-rate, thresholds built in | Build and test each |
| Reuse of our code | None directly (scripts generated by us) | Direct: executor, masking, OAuth2 cache, templating, SSRF |
| Correctness checks (ledger/DB reconciliation) | Awkward | Natural |
| Maintenance/risk | Low engine risk; one more tool to operate | We own engine bugs; false results if generator saturates |

**Recommendation: hybrid.** k6 generates load (the part where accuracy and scale matter); Node does orchestration, simulator, reconciliation and idempotency assertions, SLO evaluation and reporting. A Node "lite" engine can come later for tiny smoke runs.

## 15. Test Reports (priority deliverable)

One **Load Test Reports** area serving two audiences from the same data.

**Per-run report (web page, shareable link, PDF/XLSX/CSV/JSON export):**
1. **Executive summary (business-readable):** verdict banner (PASS / PASS WITH WARNINGS / FAIL), plain-language headline ("Mobile-money collections sustained 5× expected load with 0 duplicate charges; P95 1.2 s"), go/no-go recommendation, top 3 risks, readiness score, comparison to previous run.
2. **What we tested & why:** scenarios in plain English, load shape chart, environment, data set, approver, window.
3. **Results at a glance:** SLO table (target vs actual, green/amber/red), throughput, latency percentiles (P50–P99), error breakdown by class, capacity ("breaking point ≈ N tps").
4. **Money-safety section:** duplicate charges, negative balances, reconciliation (requests vs ledger vs settlement) — zero-tolerance, shown prominently.
5. **Security & resilience:** OWASP API checks, rate-limit behaviour, TLS/header baseline.
6. **Findings & recommendations:** ranked, each with severity, plain-language impact, technical cause, suggested fix, owner field, status (open/accepted/fixed/retested).
7. **Compliance evidence:** controls exercised (PCI DSS, BoG, OWASP…), evidence links, sign-off status, DRAFT/REVIEWED markers.
8. **Developer logs (tabbed):** timeline of events, error log with masked request/response traces (existing trace viewer + ADMIN audited reveal), slow-request samples, k6 raw summary, generator health, run config JSON, reproduce command.
9. **Trend view:** this run vs last N runs per service (regression detection).

**Presentation rules:** glossary tooltips for jargon, every number has a plain-English caption, "Business view" / "Technical view" toggle, print-friendly PDF with cover page (run id, hash, approvers) for QSA/BoG packs.
**Evidence pack export:** zip of PDF report + XLSX data + JSON + masked logs + manifest with SHA-256 hashes (tamper-evident).
**Reports index page:** filter by service/channel/verdict/date; compare two runs side by side; schedule recurring regression runs later.

Built on the existing reports engine (`reports.service.ts`, `reportToPdf/Xlsx`) and Observability page patterns, as Phase 28 plus a new **Phase 27b: report page**.

## 16. Remaining open items
- Launch volume estimate (can be added later; tiers are relative).
- Sandbox base URLs, credentials and test-data rules (test BINs/MSISDNs/wallets) from iSmart.
- Which Bank of Ghana directives apply — compliance owner to confirm exact references.
- Hetzner VM provisioning approval (cost small).

## 17. Build log

### Phase 21 — safety foundation (done, 341 tests total in repo)
- Migration `1725000022000_load-test-safety.sql`: `load_test_target_config`, `load_test_authorizations` (DB-enforced four-eyes), `load_test_control` (DB kill switch, fail-closed).
- `src/domain/load-safety.ts` — pure `evaluateLoadSafety`; deny-by-default. Rules: kill switch/enable flag, classification required, class cannot be downgraded below the target's own environment, host allow-lists (a "sandbox" class pointed at a production host is blocked), PRODUCTION state-changing/money-moving never allowed, per-class ceilings, approved + in-window authorization with caps, real-side-effect endpoints need explicit authorization and ≤1 rps.
- `src/domain/load-test-data.ts` — iSmartPay test-data rules: tagging (`test_data`, `test_case_id`, `environment`), no clear-text secrets (`{{secret:NAME}}` refs only), Luhn-valid PANs rejected unless an approved processor fixture, synthetic `*-TST-######` IDs, `.test` emails, E.164 Ghana normalisation, Class A (invalid-format) vs Class B (provider-authorised) phone numbers. Violations never echo the offending value.
- API (`/api/v1/load-tests/*`): `safety/status`, `safety/preflight` (dry-run), `targets/:id/config`, `authorizations` (+approve/reject/revoke), `kill-switch`, `data-sets/validate`. RBAC + audit on every mutation.
- Config: `LOAD_TEST_ENABLED` (default **false**), `LOAD_TEST_CEILINGS`, host lists, approved card fixtures.
- **Finding from iSmart docs:** utility purchases send real airtime/data even in the test environment → modelled as `has_real_side_effects`.

### Phase 22 — simulator (done)
- `npm run simulator` → `src/loadtest/simulator/`, loopback only (default :4010). Mirrors the documented contract: bearer tokens via `POST /v1/oauth/token`, mandatory `Idempotency-Key` on POST, decimal-string amounts, `429 rate_limited` + `Retry-After`, `{error:{code,message}}`, `403 environment_mismatch` for `live_` credentials, `Request-Id` header.
- Endpoints: collections, payouts, payout-batches (≤100), utility-purchases, transfers, checkouts, settlements (+policy), wallet, limits, payment-methods, utility-products, party-lookups, recipients, transactions, events, fee-quotes.
- Fault knobs (`PUT /__sim/config`, seeded & deterministic): latency/jitter/tail, 5xx rate, timeout rate, rate-limit rps, idempotency `correct|broken`, `raceBug` (overspend), signed webhooks with duplicate/out-of-order delivery, weak modes (`bola`, `acceptAnyToken`, `verboseErrors`) for Phase 26.
- Ledger + `GET /__sim/state` exposes `duplicateEffects`, `ledgerDriftPesewas`, `negativeBalances` for Phase 25 reconciliation. Amount fixtures: `.01` declined, `.02` stays pending, `.03` payer insufficient funds.
- Simulator conventions NOT confirmed by iSmart docs: fee maths, status names, webhook signature scheme (`x-sim-signature: v1=HMAC-SHA256(ts.body)`), batch response shape. Replace with real values once the per-endpoint reference pages are read.

### Phase 23 — runner & orchestrator (done, 376 tests total)
- Migration `1725000023000_load-test-runs.sql`: `load_test_plans`, `load_test_runs` (frozen `plan_snapshot`, heartbeat, abort flag), `load_test_metrics` (5-second aggregates only — never per-request rows).
- **Plans** (`src/domain/load-plan.ts`): one request shape + profile (SMOKE/LOAD/STRESS/SPIKE/SOAK/BREAKPOINT) → k6 `ramping-arrival-rate` stages (open model). Credential headers are refused in a plan. Per-profile minimum durations. The safety gate judges the plan's **peak** rps (a SPIKE at 50× is judged at 50×, not at its nominal rate).
- **Script generator** (`k6-script.ts`): plan values embedded as JSON literals only; secrets arrive via env (`LT_TOKEN_*`), never in the script or argv. Unique `IDEM-TST-<salt><n>` idempotency key and `{{ref}}/{{idem}}/{{iter}}/{{uuid}}` templating per request; OAuth2 token fetched once in `setup()`, refreshed on 401.
- **Aggregator** (`metrics-aggregator.ts`): streams k6's JSON, log-scale histogram (~2% error, never under-reports), per-bucket P50/P95/P99, error classes (5xx / 429 / 4xx / network), dropped-iterations → `generatorSaturated`, `maxSustainedRps`. Auth traffic excluded.
- **Worker** (`npm run loadtest-worker`): polls Postgres (`FOR UPDATE SKIP LOCKED`), so it can run on a separate VM with only DB access + k6. Re-runs the safety gate at execution time; creates a target-scoped **maintenance window** for monitor isolation (removed afterwards); heartbeats; stale runs → FAILED.
- **Live protections** (every 1–2 s): server-failure **guardrail** (default >25% 5xx/network over 30 s with ≥50 samples → stop k6; for BREAKPOINT/STRESS this is a valid "limit reached" finding, otherwise ABORTED), abort button, DB kill switch, revoked/expired authorization, hard deadline.
- API: `POST/GET /load-tests/plans`, `POST /plans/:id/runs` (202 or 422 + violations), `GET /runs`, `/runs/:id`, `/runs/:id/metrics`, `POST /runs/:id/abort`.
- Verified with **real k6 v2.3.0 against the simulator**: completion, guardrail abort, breakpoint finding, abort, kill switch.
- Lessons: k6 v2 removed `--no-summary` (omitted; parser ignores non-sample lines) and cannot reopen `/dev/stdout` on a pipe (use `--out json=-`); k6 emits `"metric"` before `"type"` in each line.
- Not done / known limits: only auth types NONE and OAUTH2 are supported by the runner; test-data sets (Phase 24) are not yet wired into request bodies; no Docker image for the worker yet (install k6 on the worker VM); live SSE stream deferred to the report UI (poll `/metrics` for now).

### Contract corrections (2026-10-15) — what the real docs changed

Read from stgdocs.ismartghana.com (guides + per-endpoint reference). Source of truth now lives in `src/loadtest/contract/ismartpay.ts` (with provenance + an `UNDOCUMENTED` list of everything the docs do not say).

| I had assumed | The docs say | Fixed in |
|---|---|---|
| Token via Basic auth + JSON, long-lived | `POST /v1/oauth/token`, **form-encoded** `grant_type, client_id, client_secret, resource=ismartpay`; **5-minute** token, no refresh grant; same host as the API | simulator, k6 script (`form` mode; per-VU proactive refresh 45–75 s before expiry, never earlier than 30% of TTL) |
| Responses wrapped in `{data: …}`, `{items}` only sometimes | Bare objects; lists are `{items}` | simulator |
| Error codes `unauthorized`, `idempotency_conflict`, 422 for bad amounts | `unauthenticated`, `idempotency_key_reused`, `request_in_flight`, `duplicate_reference`, 400 `invalid_input`, `upstream_timeout`, full catalogue | contract + simulator |
| Statuses PENDING/SUCCESSFUL/FAILED | collections `accepted→dispatched→settled/failed/expired`; payouts `accepted→dispatching→delivered / failed→refunded`; utility `…vending→delivered`, `outcome_unknown` | contract + simulator |
| Webhook header `x-sim-signature: v1=hex` | `Webhook-Id`, `Webhook-Timestamp`, `Webhook-Signature: v1,<base64 HMAC-SHA256 of id.timestamp.rawBody>`; 5-min tolerance; 6 attempts; at-least-once, out of order | contract (`signWebhook`/`verifyWebhook`) + simulator |
| Magic amounts (.01/.02/.03) decide outcomes | **No amount fixtures.** Only Telecel test numbers: `233000000001` succeeds, `…003` payout fails + refunds, `…004` collection fails (wrong PIN). MTN/CalBank have none — "do not guess" | simulator, packs, tests |
| `Idempotent-Replayed` header | Not documented | removed |
| Same reference reusable | References unique **forever**; same ref + new key + same body → original payment; different body → `409 duplicate_reference` | simulator; runner salt now derived from the **run id** (the old time-based salt repeated every ~16 min) |
| Batch = array of payouts | `{reference, items[1..100]}` → 200 with per-item `{status, payout|error}`; no batch read endpoint | simulator, pack |
| Utility purchase body | `productId`, `beneficiary{msisdn(233…), accountNumber?}`, `funding{type wallet|collection}`; **real airtime in test**; products read from `/v1/utility-products` | simulator, pack (`realSideEffects`) |
| Wallet/limits shapes | `{items:[{name,balances,reserved}]}`, `{items:[{perTransaction,daily{in,out},monthly}]}` | simulator |

**Safety gaps closed in the same pass**
- Token endpoint host is now checked against the class allow-list before any credential is sent (a stored `tokenUrl` could previously point anywhere).
- Guardrail now also stops runs on a **401/403 flood** (bad/expired key, `daily_limit_exceeded`, `business_suspended`) and on sustained **429s** — previously only 5xx tripped it. An auth-refusal flood always aborts (never a "finding").
- Plan-level `moneyMoving` / `realSideEffects` flags + `fanout` (a 100-item payout batch at 1 rps is 100 payments/s to the safety gate).
- SANDBOX/STAGING default ceilings lowered to 25 rps / 100 VUs / 30 min until iSmart confirms its rate limits (docs give none). Raise via `LOAD_TEST_CEILINGS`.
- New simulator fault: **ambiguous timeout** (request applied but client sees 504) — the docs' "outcome unknown" case; a same-key retry must replay the real result.

### Phase 24 — scenario packs & data (done, 447 tests total)
- Migration `1725000024000`: `load_test_data_sets` (validated on write; secrets only as `{{secret:NAME}}` refs).
- Plan model: `path` (origin always from the target — a plan cannot redirect traffic), `dataSetId`, `{{data.field}}`, `{"$repeat":N,"template":…}` (`{{i}}`), `moneyMoving`, `realSideEffects`, `fanout`, `packId`.
- Secrets: `{{secret:NAME}}` resolves from the **worker's** env `LT_SECRET_NAME` at run time into a 0600 temp file that is deleted afterwards. Never in DB, plan, script or logs.
- 12 packs (`src/loadtest/packs/packs.ts`, `GET /api/v1/load-tests/packs`): collections, payouts, payout batch, utility purchase (REAL), wallet transfer (sandbox support unknown), hosted checkout, collection status, fee quote, wallet, limits, payment-methods, transactions. Every generated script is checked with `k6 inspect`.
- API: `POST/GET/DELETE /load-tests/data-sets`, `GET /load-tests/packs[/:id]`, `POST /packs/:id/example-datasets/:name`, `POST /packs/:id/plans`.
- Seed: `npm run seed:ismart-sandbox` registers the sandbox target (inactive, so the cron monitor never polls it) and classifies it SANDBOX.
- End-to-end verified with real k6 vs the contract simulator: data flows into requests, batch `$repeat` produces N unique payouts per request, references never collide across runs, tokens refresh before a 5-second TTL with zero 401s, secrets resolve only from worker env, a foreign token host is refused.

### Runbook: first real sandbox run
1. In the **test** console create an API key with `collections.write`, `disbursements.write`, `transactions.read` (add `collections.read`/`disbursements.read` for reads).
2. `ISMARTPAY_SANDBOX_CLIENT_ID=… ISMARTPAY_SANDBOX_CLIENT_SECRET=… npm run seed:ismart-sandbox`.
3. `POST /load-tests/authorizations` (ADMIN/OPERATOR) with a small window and caps ≤ the ceiling; a **different ADMIN** approves.
4. `POST /load-tests/packs/collections-momo-telecel/example-datasets/collections-success`, then `POST /load-tests/packs/collections-momo-telecel/plans` with `{apiId, dataSetId}` (SMOKE first).
5. `POST /load-tests/plans/:id/runs` → worker (`LOAD_TEST_ENABLED=true npm run loadtest-worker`, k6 on PATH) → `GET /load-tests/runs/:id` and `/metrics`.
6. Start with SMOKE at ≤2 rps, then LOAD at 5 rps; raise only after iSmart confirms rate limits. Never run the utility pack except with your own number and an authorization that allows real side effects.

### Phase 25 — correctness suite & API catalog (done, 504 tests total)
**What it is.** 16 deterministic, low-volume checks (never more than 10 concurrent requests) that assert *money-safety properties load can break*. They run as a queued job on the same worker, through the **same safety gate** (classification, authorization, window, caps, kill switch), and store a per-check verdict, per-assertion detail and per-call evidence (method, path, status, Request-Id, Idempotency-Key, reference — never bodies, tokens or secrets).

| Check | Property proven | Mode |
|---|---|---|
| `idem.sequential-replay` | same key + same body is applied once and replayed | live + sim |
| `idem.concurrent-twins` | 10 simultaneous identical requests apply exactly once (202 / 409 `request_in_flight` only) | live + sim |
| `idem.key-reuse-different-body` | key reuse with a different body → 409 `idempotency_key_reused`, original untouched | live + sim |
| `reference.duplicate-rules` | same ref + new key + same body → original payment; different body → `duplicate_reference` | live + sim |
| `validation.malformed-rejected` | 9 malformed shapes, missing/oversize Idempotency-Key → 400 and **nothing created** | live + sim |
| `auth.invalid-token-rejected` | missing / garbage / tampered token → 401, nothing created | live + sim |
| `payout.fixture-delivered` | delivered; reserve released; wallet debited exactly `payerAmount` | live + sim |
| `payout.failure-refunds-wallet` | failed → refunded; wallet back to exactly where it started | live + sim |
| `collection.fixture-outcomes` | settles / fails as documented; wallet credited exactly `recipientAmount` | live + sim |
| `batch.items-and-retry` | each item paid once; retries and new-key resends pay nothing twice; malformed batch refused whole | live + sim |
| `status.list-matches-detail` | `/transactions` and the detail endpoint agree | live + sim |
| `sim.ambiguous-timeout-retry` | request ran but returned 504 → same-key retry replays, never double-applies | sim |
| `sim.concurrent-overspend` | 10 concurrent payouts can never spend more than the wallet holds | sim |
| `webhook.signature-duplicates-order` | signatures verify over the RAW body; duplicates collapse by `Webhook-Id`; best-ranked status wins over arrival order; tampered/stale rejected | sim |
| `webhook.retry-keeps-id` | failed deliveries retried with the same id, fresh timestamp, valid signature | sim |
| `sim.ledger-reconciliation` | no duplicate effects, no negative balance, wallet == opening + ledger | sim |

**"Test the tests".** Mutation tests plant each known defect in the simulator and assert the matching check goes red: broken idempotency, the overspend race, a server that accepts any bearer token, a webhook secret mismatch, a payout that never settles. A suite that cannot fail proves nothing.

**Modes.** Against the simulator (class MOCK) all 16 run. Against the live sandbox the 11 API-observable checks run; the 5 that need fault injection or ledger access are reported `SKIPPED`, never faked. Webhook checks against the live sandbox additionally need a public HTTPS receiver (not yet provisioned).

**API.** `GET /load-tests/correctness-checks`, `POST /load-tests/correctness-runs` (ADMIN/OPERATOR → 202 or 422 + safety violations), `GET /load-tests/correctness-runs[/:id]`.

**API catalog.** `GET /load-tests/api-catalog` and `docs/api-load-test-catalog.md` (generated from `src/loadtest/contract/catalog.ts`): all 33 documented endpoints + 9 webhook events, each with permission, risk and load-test status (15 ready · 7 need data · 3 caution · 7 excluded). A test keeps it consistent with the 25 scenario packs. New read-only packs: payout/utility/transfer/checkout status polls, checkouts list, payout & utility fee quotes, utility products, settlements list/latest, events, recipient lookup, party lookup (caution: forwarded to the mobile-money provider).

### Phase 26 — security / abuse-resilience suite (done, 17 checks)
Aligned to the **OWASP API Security Top 10 (2023)**. It checks that defences *hold* under hostile-but-ordinary input; it is not exploit tooling: low volume (≤20 concurrent), no brute force, nothing destructive, and only against targets the safety gate has cleared. It reuses the correctness pipeline (same queue, worker, gate, kill switch, evidence format), selected with `suite: 'security'`.

| OWASP | Check | What must hold |
|---|---|---|
| API1 BOLA | `bola.cross-account-access` | account B cannot read A's payments, its list excludes them, and "exists but not yours" is indistinguishable from "does not exist" |
| API2 Auth | `auth.bogus-client-rejected` | unknown clients / wrong secrets never get a token; identical responses (no account enumeration) |
| API2 Auth | `auth.token-expiry-enforced` | an expired token is refused (sim) |
| API3 BOPLA | `bopla.mass-assignment-rejected` | a client cannot set `status`, `fee`, amounts or admin flags on create |
| API3 BOPLA | `bopla.response-allowlist` | no secret/internal/ledger fields, no card-like values, no infrastructure material in responses |
| API4 Resources | `resource.rate-limit-behaviour` | bursts → 429 + numeric `Retry-After`, never 5xx, recovers after waiting |
| API4 Resources | `resource.payload-limits` | 600 KB bodies, 3000-deep nesting, 10k-char fields → clean 4xx, no hang, service healthy after |
| API4 Resources | `resource.pagination-caps` | `limit=100000` refused or clamped to ≤100; nonsense limits → 4xx |
| API5 Function authz | `authz.permission-enforced` | a read-only credential gets 403 on payout/collection/transfer (sim; live needs a read-only key) |
| API6 Business flows | `flows.limits-bound-automation` | 15 rapid payouts stop at the daily limit; per-transaction limit enforced |
| API7 SSRF | `ssrf.url-fields` | checkout URLs pointing at 169.254.169.254, localhost, 10.x, `file:`, `gopher:` are refused |
| API8 Misconfig | `misconfig.headers-tls-cors` | no banners, no reflected CORS origin, TLS ≥1.2 and cert validity on https targets |
| API8 Misconfig | `misconfig.error-hygiene` | errors are generic JSON: no stack traces, paths, SQL or connection strings |
| API8 Misconfig | `misconfig.methods-and-debug-paths` | wrong methods refused; `/debug`, `/.env`, `/actuator`, … not served |
| API9 Inventory | `inventory.undocumented-paths` | `/v0`, `/v2`, `/api/v1`, `/admin`, `/internal` return nothing |
| API10 Consumption | `consumption.schema-conformance` | real responses match the documented contract (decimal-string amounts, error body) — catches vendor drift |
| Injection robustness | `input.hostile-strings-inert` | SQL/XSS/JNDI/template/traversal/unicode strings: no 5xx, stored verbatim or refused, control chars refused |

**Assertion levels.** A failed *required* assertion fails the check. A failed *advisory* assertion (a missing hardening header, or behaviour the vendor's docs leave unspecified) is a **warning**: counted in the summary, visible in the report, never hidden, but not verdict-changing.

**Mutation-tested.** The simulator can plant 16 defect classes (BOLA, open token endpoint, non-expiring tokens, mass assignment, field leakage, no rate limit, no page cap, ignored permissions, ignored limits, internal-URL redirects, reflected CORS, server banner, stack traces, debug endpoints, legacy unauthenticated version, numeric-amount contract drift, crash on a quote). Each has a test that proves the matching check goes red and goes green when the defect is absent. The first run caught a defect in my own simulator (a flag that was never consulted).

**Live vs simulator.** Simulator: all 17 run. Live sandbox: `auth.token-expiry-enforced` and `authz.permission-enforced` are simulator-only (SKIPPED); `bola.cross-account-access` needs a credential for a second account (`tokenUsernameB` / `tokenPasswordB` on the target) or is SKIPPED; wrong-secret attempts are never made against the REAL client id on a live identity service (lockout risk) — only bogus ids; `ssrf` and `flows` are advisory live. API: `GET /load-tests/security-checks`, `POST/GET /load-tests/security-runs[/:id]`. Safety-gate peak: 20 concurrent (fits the 25 rps sandbox ceiling).

### Phase 27 — SLO engine, readiness and the report page (done)
**One report model, two audiences.** Every report is a single JSON structure; the dashboard page, the printable HTML, PDF, Excel, CSV and (Phase 28) the evidence pack are all rendered from it, so they cannot disagree. The *Summary* view is written for business and compliance readers (a decision, plain sentences, no jargon); the *Technical* view carries the chart, percentiles, status codes, plan history, event log, run configuration and reproduction commands.

**SLO engine** (`src/domain/load-slo.ts`, pure, tested). Each run is graded against objectives derived from the request type (read / write / batch) and overridable per plan (`slo`): P95/P99 latency, service failures (5xx/timeouts), valid requests refused (4xx), throttling (429), planned-volume delivered, token rejections, generator health, and — for BREAKPOINT/STRESS — sustained capacity. Every check carries a one-sentence plain-language explanation. Verdicts: **PASS · PASS_WITH_WARNINGS · FAIL · INCONCLUSIVE**. A run that cannot prove anything (generator saturated, stopped by a person or the kill switch, invalidated by credentials/limits, or the runner failed) is INCONCLUSIVE — never a pass, never a blame on the service. A guardrail trip on 5xx/429 *is* a FAIL, because the service began failing under load.

**Findings** (`src/domain/load-findings.ts`). Every failed objective or assertion becomes a finding with *what it means for customers*, *what we saw*, and *what to do*, rated by the worst affected control (idempotency, ledger and reconciliation failures are CRITICAL; an advisory miss is a LOW "hardening suggestion"). Deterministic wording, so reports are comparable and auditable.

**Production readiness** (`src/domain/load-readiness.ts`). Gates, not a weighted average: money correctness, security and steady load are hard gates; spike, capacity and freshness are advisory unless they fail. A missing required gate is **INCOMPLETE**, never silently passed. **Simulator evidence can never make a service READY** — it proves the tests work, not that the vendor's service does — and the report says so on every page. The 0–100 score is provisional and secondary.

**API** (business roles COMPLIANCE and MANAGEMENT can read; only operators start runs): `GET /load-tests/reports` (index), `/runs/:id/report`, `/correctness-runs/:id/report`, `/security-runs/:id/report`, `/readiness/:apiId`, each with `?format=json|html|xlsx|csv|pdf` (CSV takes `&table=`). The HTML download is script-free, escapes every dynamic value, and is served with `default-src 'none'; style-src 'unsafe-inline'`. CSV neutralises spreadsheet-formula injection.

**Dashboard** — new **Load tests** area: *Reports* (filter by type, service, "real service only"), *Readiness* (gate table + next steps per service), *API catalog* (all 33 endpoints with status), and the report detail page with the Summary / Technical toggle, "Open printable report" and PDF / Excel / CSV / JSON downloads. Verified in a real browser against real data.

**Demo data.** `npm run demo:loadtest` drives the real runner, the correctness suite and the security suite against the simulator and stores real results (one deliberately degraded run, so a FAIL report exists). It attaches them to an inactive target named "Demo — iSmartPay Simulator"; `npm run demo:loadtest -- --clean` removes it.

**Bugs found by looking at the real output.** (1) The degraded demo run came out *Inconclusive* instead of *Fail*: the runner pre-allocated k6 virtual users assuming ~100 ms responses, so against a slow service k6 dropped iterations while spinning up VUs and the SLO engine rightly distrusted the run. Pre-allocation now scales with the peak rate (≈2 s response). (2) The decision sentence appeared twice, the headline had nested parentheses, the event log listed each lifecycle step twice, and the extra nav item overflowed the header — all fixed.

### Open items
1. **Ask iSmart:** sandbox rate limits; idempotency-key retention; collection `failureReason` values; whether wallet transfers have a test mode; permissions for a test key; whether `POST /v1/settlements` moves real funds in test; party-lookup tolerance.
2. **Live webhook checks** need a public HTTPS endpoint (tunnel or the deployed API).
3. One e2e test (`denies by default and requires roles`) failed once in a full run with 404 instead of 403 and did not reproduce in two reruns — unexplained; watch for recurrence.

### Next
Phase 26 — security / abuse-resilience suite (OWASP API Top 10: BOLA, auth, resource consumption, business-flow abuse, misconfiguration) · Phase 28 — compliance evidence (PCI DSS / OWASP / Bank of Ghana mapping, tamper-evident evidence packs).
