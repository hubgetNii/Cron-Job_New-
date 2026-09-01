# Comprehensive Reporting & Observability — Plan

**Objective:** for every health check, an administrator can trace exactly *what was
tested, what was sent, what was received, how long it took, what failed, why it
failed, the business/technical impact, and what to do next* — and move
Incident → Health Check → Request → Payload → Response → Dependency → Recommendation
without losing context.

This is an **operational intelligence layer**, not a log viewer. The raw log says
*what happened*; the reporting engine says *when · what was affected · why · how
severe · whether it is recurring · what it will impact · what to do · whether it
is resolved*.

---

## What already exists (as of `25eb2c2`)

| Spec area | Current state |
| --- | --- |
| Per-check result row | `health_check_results` — status, `http_status`, `response_time_ms`, `error_type` (classified enum), `error_message`, `validation_result` jsonb, `response_code`, soft link to `cron_job_runs` via `job_run_id` |
| Execution record | `cron_job_runs` — scheduled slot, worker, timings, status, attempt number |
| Failure classification | `check_failure_type` enum + `failure-classifier.ts` (transport + HTTP status) |
| Retry/backoff visibility | `outcome.attempts` recorded |
| Response body | **only** a 4 KB PCI-scrubbed `response_sample` in the outcome (not persisted to its own column), plus `validation_result` |
| Secret handling | `pci.ts` — scrubs card numbers / long digit runs only |
| Incidents | `incidents` — severity, type, `failure_type`, `duration_seconds`, `root_cause` (free text), `resolution`, ack/resolve timestamps, `failure_count` |
| Alerts | `alerts` — type, channel, recipient, status, tier |
| SLA | `sla_reports` — rolling-30d + calendar-month, maintenance-window carve-out; `sla.service.ts`, `compliance.service.ts` (+ incident CSV) |
| AI (advisory) | `ai_insights` — `failure_classification`, `root_cause` (hypotheses+evidence+confidence+next step), `incident_summary`; hard `assistive = true` DB CHECK |
| Anomaly detection | `anomaly.service.ts` — statistical z-score latency + error-rate vs rolling baseline (no LLM) |
| Latency stats | `dashboard.repo` computes **P95 only**, 5-min buckets, last 6 h |
| Audit | `audit_logs` — append-only (trigger-enforced), `before`/`after` changes jsonb, actor, ip, request_id |
| Dashboard | overview · status · incidents · alerts · sla · scheduler · targets · approvals |

## The gaps

1. **No Health Check ID.** The scheduler runs per-target anchored slots — there is
   no "one sweep of N services" object with `HC-YYYYMMDD-HHMMSS-NNNNNN`,
   `Services Tested / Healthy / Degraded / Failed`, overall status, duration.
2. **No request/response capture.** Sent headers, request payload, response
   headers, response size, content-type, and the full (masked) response body are
   not stored.
3. **Masking is PCI-only.** No redaction of `Authorization`, API keys, bearer
   tokens, passwords, PINs, CVV, encryption keys, or sensitive JSON fields.
4. **Latency is one number.** No avg/min/max/P50/P90/P99, no deviation-from-baseline
   assessment, no **per-API** configurable thresholds.
5. **Flat failure enum.** No Connectivity / Authentication / Application /
   Database / Dependency / Performance / Configuration taxonomy.
6. **RCA is LLM-only and unstructured.** No deterministic evidence → probable
   cause → confidence → impact → recommendation.
7. **No recommendations engine** (finding → action lookup + historical modifier).
8. **No historical comparison** ("+63 % vs same period yesterday", "3rd
   occurrence in 24 h", "failure rate 0.4 % → 7.8 % over 2 h").
9. **No service health score** (weighted Availability/Latency/Error/Dependency).
10. **No incident timeline** (event stream per incident).
11. **Correlation IDs not threaded** (Request ID, Correlation ID per check).
12. **Reports:** only SLA + compliance. Missing API Performance, Failure,
    Incident, Dependency, Latency, Security/Auth, Executive.
13. **No log explorer** (multi-field search + presets + CSV/Excel/PDF export).
14. **Retention** not formalised (no partitioning / per-class TTL).
15. **SMS/email don't use the intelligence layer** (digest rolls up raw status,
    not RCA probable-cause + impact).

---

## Progress

| Phase | Status |
| --- | --- |
| **15** Failure taxonomy · RCA · recommendations | ✅ done — commit `bc69084`. `src/domain/failure-taxonomy.ts`, `src/domain/recommendations.ts`, `src/services/intelligence/rca.service.ts`, `incidents.rca` column, `GET/POST /incidents/:id/rca`, dashboard RCA panel. |
| **12** Trace capture & masking | ✅ done — commit `79bb5f9`. `src/lib/masking.ts`, `health_check_traces` table (masked + encrypted raw), executor + job-runner capture, `GET /observability/traces*` (search / masked / ADMIN raw-reveal / CSV), Observability dashboard page, hourly retention prune. |
| **13** Health Check Run aggregation & IDs | ✅ done — `health_check_runs` table + `HC-YYYYMMDD-HHMMSS-NNNNNN` IDs, 5-min roll-up runner, `health_check_results.hc_run_id` backlink, `GET /observability/health-checks[/:hcId]`, dashboard runs table + per-service drawer. `npm run demo:reset` wipes history and backfills ~98% uptime. |
| **14** Latency intelligence | ✅ done — `latency_thresholds` table + class-based defaults (`src/domain/latency.ts`), `latency-stats.service.ts` (P50/P90/P95/P99 + current/avg/min/max over a window, 7-day baseline, deviation %, assessment from P95 vs bands), `GET /observability/latency[/:apiId]`, `PUT/DELETE /observability/latency/:apiId/thresholds` (ADMIN), dashboard "Latency intelligence" table + detail drawer. |
| **16** Incident timeline | pending |
| **17** Health score & historical comparison | pending |
| **18** Reports & Log Explorer (CSV only) | partial — trace CSV export shipped in 12 |
| **19** Intelligence-driven notifications + dashboard IA | pending |
| **20** Retention & audit hardening | partial — trace retention + reveal-audit shipped |

## Phased delivery

Each phase is independently shippable, tested, committed. Ordering is
dependency-driven — 12 and 13 are the data foundation everything else reads.

### Phase 12 — Trace capture & secret masking *(foundation)*
- `src/lib/masking.ts` — `maskHeaders()`, `maskJson()`, `maskText()`, extends
  `scrubPci`. Redacts `authorization`, `cookie`, `*api*key*`, `*token*`,
  `x-*-key`, and JSON keys `password|pin|cvv|cvc|secret|otp|privateKey|
  encryptionKey|accessToken|pan|cardNumber` (+ configurable extra keys).
  **Masking happens at capture — raw secrets are never written to the DB.**
- Executor returns a `trace`: request `{method, url (query-masked), headers
  (masked), bodyMasked, bodySize, source}`, response `{httpStatus, headers
  (masked), bodyMasked, sizeBytes, contentType, responseTimeMs}`.
- Migration: `health_check_traces` (1:1 with `health_check_results`, separate
  table for retention/partitioning), + `request_id`, `correlation_id`.
- `TRACE_RETENTION_DAYS` (default 30) + a prune job.
- Dashboard: trace viewer — **Masked payload** / **Formatted JSON** tabs
  (there is no unmasked view; "raw" = exactly-as-sent with secrets masked).

### Phase 13 — Health Check Run aggregation & IDs
- Migration: `health_check_runs` — `hc_id`, `started_at`, `completed_at`,
  `environment`, `duration_ms`, `services_tested`, `healthy`, `degraded`,
  `failed`, `overall_status`. `health_check_results.hc_run_id` nullable FK.
- `health-check-run.service.ts` — rolls per-target results into a run on the
  digest cadence (the scheduler has no single sweep; a run = one roll-up window).
- `GET /observability/health-checks`, `GET /observability/health-checks/:hcId`
  (drill-in: per-service rows + trace links).

### Phase 14 — Latency intelligence
- Migration: `monitored_apis.latency_thresholds jsonb`
  `{normalMs, degradedMs, criticalMs}` — class-based defaults, per-API override.
- `latency-stats.service.ts` — current / avg / min / max / P50 / P90 / P95 / P99
  over a configurable window (`percentile_cont`), deviation % vs baseline,
  assessment (NORMAL / DEGRADED / CRITICAL / HIGH-LATENCY).
- `GET /observability/latency/:apiId`.

### Phase 15 — Failure taxonomy · RCA · recommendations *(deterministic core)*
- `failure-taxonomy.ts` — `categorize(failureType, httpStatus, errorMessage,
  bodyMasked)` → `{category, subtype}`.
- `rca.service.ts` — deterministic evidence (statuses seen, consecutive
  failures, latency delta, dependency hints from body regex
  `/database|connection pool|deadlock|timeout|upstream|gateway|unavailable/`),
  probable cause + confidence heuristic, impact from `endpoint_class` +
  `is_money_moving`, recommendation. Optionally enriched by the existing
  advisory `ai_insights` path.
- `recommendation.ts` — finding → action table (500 → review app logs/traces;
  401 → validate credentials/token expiry; 403 → permissions; 404 →
  endpoint/version; 429 → rate limits; 502 → gateway/upstream; 503 →
  availability; 504 → upstream timeout; DNS → DNS config; TLS → cert validity;
  repeated timeout → network/dependency latency) + historical modifier.
- Migration: `incidents.rca jsonb` (structured; keeps `root_cause` text).

### Phase 16 — Incident timeline & correlation
- Migration: `incident_events` — `incident_id`, `at`, `kind`, `detail` jsonb,
  `source`. Kinds: `detected`, `latency_threshold_exceeded`, `p95_exceeded`,
  `first_timeout`, `state_change`, `alert_sent`, `escalated`,
  `dependency_error`, `recovered`.
- Appended from the state machine, alert dispatcher, recovery, SLA checker.
- `GET /incidents/:id/timeline`. Every payload carries `hc_id`, `request_id`,
  `correlation_id`, `service_id`, `incident_id` for lossless navigation.

### Phase 17 — Health score & historical comparison
- `health-score.service.ts` — 0–100, sub-scores Availability / Latency /
  Error Rate / Dependency Health; weights configurable
  (`scoring_config` table or env, default 40/25/20/15).
- `trends.service.ts` — vs same period yesterday, failure-rate over last N h,
  Nth occurrence in 24 h.
- `GET /observability/services/:id/score`, `.../trends`.

### Phase 18 — Reports & Log Explorer
- Report builders (`GET /reports/<type>?from&to&format=json|csv|xlsx|pdf`):
  System Health · API Performance · Failure · Incident · Dependency · Latency ·
  Security/Auth · Executive. (SLA + compliance already exist.)
- Export: `exceljs` (xlsx) + `pdfkit` (pdf) — **new dependencies, needs sign-off.**
- Log Explorer: `GET /observability/search` — filter by request id / hc id /
  incident id / service / endpoint / http status / error code / time / env /
  severity / response time / correlation id; presets (30 m, today, yesterday,
  7 d, custom); CSV/Excel/PDF export. Dashboard page.

### Phase 19 — Intelligence-driven notifications + dashboard IA
- Incident-driven SMS/email pull probable cause + impact + recommendation from
  the RCA layer (spec §18 sample text; recovery text with current latency).
- Dashboard nav reorg (§19): Dashboard · Services · Health Checks ·
  Observability · Intelligence · Incidents · Notifications · Reports · Audit.
  New pages: Health Checks, Observability (log explorer + trace viewer),
  Intelligence (RCA · anomalies · scores), Reports hub, Audit.
- Config-change audit coverage: threshold / weight edits write `audit_logs`
  with `before`/`after`.

### Phase 20 — Retention & audit hardening
- Monthly partitioning for `health_check_results` + `health_check_traces`.
- Per-class retention TTL: operational, health-check, incident, audit,
  notification, config-change.
- `REVOKE UPDATE, DELETE` on `audit_logs` from the app role in prod.

---

## Decisions (2026-09-01)

1. **Raw payloads — DECIDED: store unmasked, ADMIN-only view.** Persist both the
   true payload and a masked copy. Non-ADMIN roles only ever see the masked
   copy. The unmasked view is gated behind ADMIN role **and writes an
   `audit_logs` entry per view** (`action = observability.trace.reveal`). The
   at-capture masked copy still exists so the common path never touches secrets.
   Encrypt the raw column at rest with the existing credential cipher.
2. **Export formats — DECIDED: CSV now, Excel/PDF later.** Phase 18 ships CSV
   only. `exceljs` + `pdfkit` are a deferred follow-up.
3. **Phase order — DECIDED: resequenced** (see below).

## Still open

- **Retention windows** per log class — default proposal: traces 30 d,
  health-check results 90 d, incidents + audit + notifications indefinite.
- **Health Check "run" definition** — since the scheduler is per-target
  anchored, a run = one roll-up window (digest cadence). Confirm vs. adding an
  explicit synchronized sweep mode.
- **Score weights** — 40/25/20/15 (Availability/Latency/Error/Dependency).
