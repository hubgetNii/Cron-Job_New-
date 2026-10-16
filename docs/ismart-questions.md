# Questions for iSmart — sandbox load, correctness and security testing

**To:** iSmart API / platform team · **From:** Operations · **Purpose:** we plan to test the iSmartPay developer API in the **sandbox only** (`stgdeveloper-api.ismartghana.com`) before launch. The published docs do not answer the points below, and the answers set the safe limits for our tests and the accuracy of our compliance evidence. Until we hear back, our tests run at deliberately low volume (25 requests/second, 100 concurrent users, 30 minutes) and never touch production.

Please answer in the "Answer" column or in a reply.

## A. Needed before any real run

| # | Question | Why we ask | Answer |
|---|---|---|---|
| 1 | Please issue a **test-console API key** (client id + secret) for our testing, with permissions for collections, payouts, payout batches, wallet, transfers, checkout, fees and lookups (read + write). | Nothing has yet run against the real sandbox. | |
| 2 | What are the **sandbox rate limits** (per key, per IP, per endpoint), and what does the service return when exceeded (status code, `Retry-After`)? | Docs only mention `Retry-After`. We cap ourselves at 25 rps until told otherwise. | |
| 3 | Do you **agree to the test window and volume** we propose (date, duration, peak rps), and who should we notify beforehand? | Avoids alarming your on-call or tripping abuse protection. | |
| 4 | Can you provide a **second, separate sandbox account/key**? | Cross-account access tests (one customer reading another's payments) need two accounts. | |
| 5 | Can you provide a **read-only key** for the same account? | To prove read-only credentials cannot move money. | |

## B. Behaviours the docs leave open

| # | Question | Why we ask | Answer |
|---|---|---|---|
| 6 | How long are **idempotency keys retained**, and what exactly happens when the same key is replayed with a *different* body? | Our duplicate-payment checks assert the documented behaviour; the retention window is unstated. | |
| 7 | What **`failureReason` values** can a collection return (we know the wrong-PIN test number)? | Our reports translate failure reasons into plain language. | |
| 8 | Is there a **test mode for wallet-to-wallet transfers**, or do they move real balances even in sandbox? | Decides whether we may load-test them at all. | |
| 9 | Does **`POST /v1/settlements`** move real funds in the sandbox? | We exclude it from automated tests until confirmed. | |
| 10 | Utility purchases (airtime/data) are documented as sending **real** airtime even in test. Is there any way to disable that, or a recommended number/amount for testing? | We cap these at 1 request/second and require explicit approval. | |
| 11 | What is the **error code for insufficient wallet balance** on payouts and transfers? | We currently assume `insufficient_funds`. | |
| 12 | How are **fees rounded** (to pesewas, half-up?) and is there a minimum fee? | Our money-correctness checks recompute fees. | |
| 13 | Does **party lookup** (name/account validation) tolerate repeated calls at volume, or is it metered or provider-limited? | It calls through to the mobile-money provider. | |
| 14 | Webhooks: what is the exact **retry schedule** (documented as "6 attempts over about a day")? What **signature** header/algorithm is used and what is the replay-protection window? | Needed to test webhook authenticity and duplicate delivery correctly. | |
| 15 | Besides the Telecel numbers `233000000001`, `…003`, `…004`, are there **documented test numbers for MTN or CalBank**? | We will not guess real numbers. | |

## C. For our compliance evidence (PCI DSS, OWASP, Bank of Ghana)

| # | Question | Why we ask | Answer |
|---|---|---|---|
| 16 | Does iSmart hold a current **PCI DSS Attestation of Compliance** (and scope: card data stored? hosted fields?), and can you share it or a summary? | Our mapping marks controls as "evidenced by third party" only with a real document. | |
| 17 | Do you publish a **penetration-test summary** or allow **us to test authorization controls** beyond what is described here? | External testing is outside what our tool can prove. | |
| 18 | Which **Bank of Ghana directives** does iSmart treat as applicable to the API (e.g. payment-system and cyber/information-security directives), and is there a compliance contact we can coordinate with? | Our Bank of Ghana mapping lists themes, not clauses; we need the exact references. | |
| 19 | What are your **incident-notification** commitments and contact for sandbox/production incidents? | Part of our third-party and incident controls. | |

## What we will and will not do

- Sandbox only. No production traffic, no real customer data, no card data (test fixtures only).
- Low, stepped volume with an automatic stop on error spikes, and a kill switch we can pull at any moment.
- All test data is tagged `test_data` so you can recognise (and purge) it.
- We will share the resulting reports on request.
