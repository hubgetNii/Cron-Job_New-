# Load-testing programme — open-items register

_Living document. Opened 2026-10-16 at Phase 26; updated at Phase 27. Once Phases 27–28 are built we walk this list top to bottom and close every row. Owner: **U** = user / iSmart / compliance, **C** = code (Claude), **B** = both._

## A. Blocked on you or iSmart (cannot be closed from code)

| # | Item | Owner | Why it matters |
|---|---|---|---|
| A1 | A **test-console API key** (client id + secret) with `collections.write`, `disbursements.write`, `transactions.read` (+ the `.read` variants) | U | Nothing has run against the real sandbox yet. Everything so far is proven against the contract-accurate simulator. Then `npm run seed:ismart-sandbox`. |
| A2 | Ask iSmart: **sandbox rate limits**; idempotency-key retention window; collection `failureReason` values; whether **wallet transfers have a test mode**; whether `POST /v1/settlements` moves real funds in test; party-lookup tolerance (forwarded to the provider); webhook retry gaps | U | The docs are silent. Ceilings are set to a cautious 25 rps until answered; simulator conventions are listed in `UNDOCUMENTED` in `src/loadtest/contract/ismartpay.ts`. |
| A3 | A **second-account credential** (`tokenUsernameB`/`tokenPasswordB`) and a **read-only key** | U | Without them the live cross-account (BOLA) and permission checks are SKIPPED. |
| A4 | A **public HTTPS webhook endpoint** (tunnel or the deployed API) registered in the test console | U | Live webhook authenticity/duplicate/retry checks need a receiver iSmart can reach. |
| A5 | **Hetzner worker VM**: provision, install k6, set `LOAD_TEST_ENABLED=true`, `LT_SECRET_*`, DB access | U | Large runs must not share the monitor host or the Mac. |
| A6 | **Launch volume estimate** (expected peak TPS per channel) | U | Plans use relative tiers until then; readiness scoring (Phase 27) needs a target. |
| A7 | **Compliance owner**: which Bank of Ghana directives apply; QSA scoping; sign-off on DRAFT control mappings (Phase 28) | U | Mappings must not be presented as "covered" until reviewed. |
| A8 | Confirm the **k6 + Node hybrid** engine decision explicitly | U | Assumed, never explicitly confirmed. |
| A9 | Decide the policy for **read-only load on PRODUCTION** (currently ≤2 rps, 5 min, authorization required) and for any production approvals | U | Money-moving production load is hard-blocked regardless. |
| A10 | **Push** the local commits to GitHub (you use your own token) | U | Work is only on this machine. |

## B. Still to build

| # | Item | Owner | Notes |
|---|---|---|---|
| B1 | ~~Phase 27 — SLO engine + readiness~~ | C | **Built** (see D). Remaining: a launch-volume figure (A6) so `requiredCapacityRps` has a real target. |
| B2 | **Dashboard: plan builder, run launcher and live run console** (create a plan from a pack, pick a data set, queue/abort a run, watch it live) | C | The Load Tests area is read-only: reports, readiness and the catalog are built; runs are still started via the API. Needs a live metrics stream (SSE) or polling view. |
| B11 | **Side-by-side run comparison** and a **scheduled regression** view (trend is per plan today) | C | Trend table exists; no diff view yet. |
| B12 | Compliance/management roles can read reports but **cannot read plans, runs or the catalog** endpoints directly | C | Intentional for now (reports only); revisit with Phase 28. |
| B4 | **Worker packaging**: Dockerfile/compose service + deployment runbook for `loadtest-worker` | C | Today it is `npm run loadtest-worker` with k6 on PATH. |
| B5 | **Scheduled regression runs** (correctness + security on a cadence; CI hook) | C | Phase 29 in the original plan. |
| B6 | **Reference harvesting**: turn the references a run created into a data set for the `needs_data` poll packs | C | 7 catalog endpoints need ids from an earlier run; today that is manual. |
| B8 | Runner auth beyond `NONE` / `OAUTH2` (API key, bearer, custom header) | C | Fails with a clear message today. |
| B9 | Live-mode webhook receiver deployment for the correctness suite | B | Depends on A4. |
| B10 | Monitoring the iSmart developer API itself in the cron monitor needs OAuth2 `form` mode in the health-check token cache (it only does Basic) | C | Only if you want to monitor, not just load-test, that API. |
| B13 | **Compliance follow-ups**: scheduled evidence refresh (re-run suites so evidence never goes stale), optional pack signing with a managed key (hash is recorded today, not signed), second-person pack approval | C | Phase 28 follow-on. |
| B14 | **Compliance page for MANAGEMENT** (read-only) — today the matrix is readable by COMPLIANCE/ADMIN; confirm who else needs it | U | Ties to B12. |

## C. Housekeeping / known issues

| # | Item | Owner |
|---|---|---|
| C1 | One e2e test (`denies by default and requires roles`) failed once in a full run (404 vs 403), not reproducible in two reruns | C |
| C2 | 27 files already fail `prettier --check` at HEAD (pre-existing, not from this work); decide whether to normalise them in a separate commit | B |
| C3 | Git author is `Ismar Ghana` — guessed from the home directory, never confirmed | U |
| C4 | Re-verify `src/loadtest/contract/ismartpay.ts` against the live docs before any sign-off (it is a transcription as of 2026-10-15) | C |
| C5 | Simulator conventions that are not iSmart facts: fee rounding (1 %, min 0.10), `insufficient_funds` code, failure-reason strings, settlement/resettlement behaviour | C |
| C7 | Demo data currently lives in the **dev database** (target “Demo — iSmartPay Simulator”); remove with `npm run demo:loadtest -- --clean` before any real evidence is gathered, or it will sit in the reports index | U |
| C6 | Excluded endpoints to revisit once A2 is answered: settle-now, resettlements, checkout cancel, settlement-policy writes | B |

## D. Closed

| # | Item | Closed |
|---|---|---|
| D1 | SLO engine, findings, readiness gates and the report builder (JSON, HTML, XLSX, CSV, PDF) | Phase 27, 2026-10-16 |
| D2 | Human-readable report page (Summary / Technical toggle) in the dashboard, role access for COMPLIANCE and MANAGEMENT | Phase 27, 2026-10-16 |
| D3 | False "saturated generator" on slow targets (VU pre-allocation assumed fast responses) | Phase 27, 2026-10-16 |
| D4 | Demo data for the dashboard (`npm run demo:loadtest`, removable with `-- --clean`) | Phase 27, 2026-10-16 |
| D5 | **Phase 28 compliance evidence** (was B3): 32-control DRAFT library, assessment engine, COMPLIANCE-only sign-off, tamper-evident evidence packs with verifier CLI, dashboard Compliance page | Phase 28, 2026-10-16 |
| D6 | **Retention** for load-test and correctness run tables (was B7); compliance tables never pruned | Phase 28, 2026-10-16 |
