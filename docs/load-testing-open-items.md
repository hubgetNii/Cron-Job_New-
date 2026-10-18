# Load-testing programme — open-items register

_Living document. Opened 2026-10-16 at Phase 26; updated at Phase 27. Once Phases 27–28 are built we walk this list top to bottom and close every row. Owner: **U** = user / iSmart / compliance, **C** = code (Claude), **B** = both._

## A. Blocked on you or iSmart (cannot be closed from code)

| # | Item | Owner | Why it matters |
|---|---|---|---|
| A2 | Ask iSmart: **sandbox rate limits**; idempotency-key retention window; collection `failureReason` values; whether **wallet transfers have a test mode**; whether `POST /v1/settlements` moves real funds in test; party-lookup tolerance (forwarded to the provider); webhook retry gaps | U | The docs are silent. Ceilings are set to a cautious 25 rps until answered; simulator conventions are listed in `UNDOCUMENTED` in `src/loadtest/contract/ismartpay.ts`. |
| A3 | A **second-account credential** (`tokenUsernameB`/`tokenPasswordB`) and a genuinely **read-only key** | U | The key supplied as "read-only" on 2026-10-16 is identical to the full test key, so it proves nothing about permissions. Cross-account (BOLA) and permission checks stay SKIPPED until two distinct credentials exist. Note: sandbox account number 0553476530 was provided; a number is not a credential. |
| A4 | **Deploy the API at a public HTTPS address** and register `https://<address>/hooks/loadtest/<slug>` in the iSmart test console, then paste the signing secret into the dashboard's Webhook receiver | U | The receiver is built (B9); iSmart needs a public address to reach it. Not exposed from the Mac. |
| A5 | **Hetzner worker VM**: provision, install k6, set `LOAD_TEST_ENABLED=true`, `LT_SECRET_*`, DB access | U | Large runs must not share the monitor host or the Mac. |
| A7 | **Compliance owner: Ibrahim** (named 2026-10-16). Needed from them: which Bank of Ghana directives apply and their exact clauses; QSA scoping; sign-off on the DRAFT control mappings | U | Mappings must not be presented as "covered" until reviewed. Ibrahim needs a dashboard user with the COMPLIANCE role (only that role can approve) — email still needed. |

## B. Still to build

| # | Item | Owner | Notes |
|---|---|---|---|
| B1 | ~~Phase 27 — SLO engine + readiness~~ | C | **Built** (see D). Remaining: a launch-volume figure (A6) so `requiredCapacityRps` has a real target. |
| B13 | **Compliance follow-ups**: optional pack signing with a managed key (hash is recorded today, not signed), second-person pack approval | C | Scheduled evidence refresh is done (D11). |

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
| D7 | **Run launcher and live console** (was B2): `/app/load-tests/launch` — pick service and scenario, tune profile/rps/duration/VUs, create example data sets, dry-run the safety gate, start or stop a run, live rps/p95/failure charts, recent runs, correctness and security suite launch. Remaining gap: no free-form plan editor (plans come from scenario packs) | B2, 2026-10-16 |
| D8 | **Read access for COMPLIANCE and MANAGEMENT** (was B12/B14): plans, runs, metrics, packs, catalog and suite runs are now readable by them; starting runs, data sets and kill switch stay closed; the Compliance matrix was already readable | 2026-10-16 |
| D9 | **Reference harvesting** (was B6): `POST /load-tests/runs/:id/harvest-references` rebuilds the references a finished run created (`LT-<salt>-<n>`) into a data set for the status-poll packs; dashboard "Save references" button; verified end-to-end with real k6 (every lookup found its collection). Caveat: failed iterations were never created, so a run with failures warns that some lookups may 404 | B6, 2026-10-16 |
| D10 | **Side-by-side run comparison** (was B11): `/app/load-tests/compare` — baseline vs newer load run, p50/p95/p99, errors, throughput with 5% noise band, SLO checks side by side, warns when the runs are not like for like (profile, shape, scenario, environment, saturated generator). The scheduled-regression view moves into B5 | B11, 2026-10-16 |
| D11 | **Scheduled regression** (was B5, part of B13): correctness and security suites on a cron cadence (hourly floor), via the worker; same safety gate as a manual run, skip-if-busy, no catch-up bursts, load tests never scheduled; dashboard card on the Run page | B5, 2026-10-16 |
| D12 | **Worker packaging** (was B4): `Dockerfile.loadtest-worker` (pinned k6 2.3.0, non-root), `docker-compose.loadtest-worker.yml` (read-only fs, no capabilities), env template, `docs/loadtest-worker-runbook.md`. Built and smoke-tested locally; the Hetzner VM itself is still A5 | B4, 2026-10-16 |
| D13 | **Static auth types** (was B8): load runs now authenticate with API key (header or query), bearer, basic and custom-header targets as well as OAuth2/none; credentials reach k6 only through env; verified with real k6 against a capture server. The correctness/security suites remain iSmartPay-OAuth specific | B8, 2026-10-16 |
| D14 | **Monitor OAuth2 `form` mode** (was B10): a target with `tokenMode: "form"` (and optional `tokenResource`) now authenticates the cron monitor with iSmartPay-style client credentials, so the developer API itself can be health-checked; short tokens refresh at 70% of life | B10, 2026-10-16 |
| D15 | **Test-console API key** (was A1): registered as the sandbox load-test target (inactive for the monitor, class SANDBOX); a live token request returned HTTP 200 with a 300-second bearer token, matching the transcribed contract | 2026-10-16 |
| D16 | **Launch volume** (was A6): Test 1 = 10,000 tx/day (sustained peak 10 TPS, high 20, stress 50); Test 2 = 100,000 tx/day (avg 1.16 TPS, peak 20, stress 50), six tiers each, available as presets in the Run page and `GET /load-tests/programme`; provisional pending confirmed volumes. Under today's sandbox ceiling (25 rps / 100 users / 30 min) the 30–50 TPS tiers, 250+ user tiers and 8-hour endurance run are automatically capped and flagged — raising the ceiling needs iSmart's agreement (A2) | 2026-10-16 |
| D17 | **k6 + Node hybrid engine** confirmed (was A8) and the current production policy accepted (was A9: read-only ≤2 rps, 5 min, authorization required; money-moving production load refused) | 2026-10-16 |
| D18 | **Pushed to GitHub** (was A10): `84486be..202c722`, 13 commits. Later work is local until pushed again | 2026-10-16 |
| D19 | **Webhook receiver** (the build half of B9): public `POST /hooks/loadtest/<slug>` verifying the documented signature over the raw body, answering 401/503/404 correctly, recording every delivery with retry counts and masked bodies; dashboard card to create it, store the secret, and watch deliveries | 2026-10-16 |
| D20 | **Live webhook check** (was B9): new check `webhook.live-delivery` makes a real sandbox collection, waits for the webhook to reach the receiver, and verifies signature, envelope-id = header id, collection event type, our 200 acknowledgement, and that the best webhook status equals the API state. Skips (never fails) with an instruction when no receiver/secret exists or nothing arrives in 90 s. Mapped to the third-party-API and webhook controls. Tested end-to-end against the real receiver. Still needs A4 (public address) to run for real | 2026-10-16 |
| D21 | **Live webhooks proven on the real sandbox** (2026-10-18, via a temporary Cloudflare tunnel): iSmart delivered `webhook.test`, then `collection.accepted` → `status_changed(dispatched)` → `status_changed(settled)` for one collection, 5 s apart; every delivery verified with the secret used exactly as issued; `webhook.live-delivery` PASSES. A first run failed only because the check compared the first event with the API's final state — fixed to wait for the matching event and covered by tests. The tunnel is temporary: a permanent public address is still needed before launch (A4, Option B in the deploy notes) | 2026-10-18 |

