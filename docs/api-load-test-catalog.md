# iSmartPay APIs available for load testing

_Generated from `src/loadtest/contract/catalog.ts` (a test keeps it consistent with the scenario packs). Source: stgdocs.ismartghana.com/reference, read 2026-10-15._

**33 documented API endpoints** · 15 ready · 7 need data from an earlier run · 3 need caution · 7 deliberately excluded · 25 have a runnable scenario pack · 9 webhook events (inbound to your receiver).

| Status | Meaning |
|---|---|
| ✅ Ready | A pack exists and needs no pre-existing state. |
| 🟡 Needs data | A pack exists, but its data set must carry ids/references created by an earlier run (or a handle you control). |
| ⚠️ Caution | A pack exists, but the call reaches outside iSmartPay or has real-world effects — low rate and explicit sign-off. |
| ⛔ Excluded | Deliberately not load tested: configuration, destructive, or moves wallet money to a real settlement account. |

Sandbox facts: base URL `https://stgdeveloper-api.ismartghana.com`; the only documented test numbers are Telecel `233000000001` (succeeds), `233000000003` (payout fails + refunds), `233000000004` (collection fails, wrong PIN); utility purchases are **real** in test; the docs publish no rate limits.

## Auth

| Endpoint | What it does | Permission | Kind | Load test | Pack | Notes |
|---|---|---|---|---|---|---|
| `POST /v1/oauth/token` | Exchange client id/secret for a 5-minute bearer token | — | auth | — n/a | — | Shared identity path. Exercised implicitly by every run (one handshake per VU refresh); do not hammer it directly. |

## Collections

| Endpoint | What it does | Permission | Kind | Load test | Pack | Notes |
|---|---|---|---|---|---|---|
| `POST /v1/collections` | Collect money from a payer into your wallet | collections.write | money | ✅ Ready | `collections-momo-telecel` | Sandbox: Telecel fixtures only. |
| `GET /v1/collections/{reference}` | Get a collection | collections.read | read | 🟡 Needs data | `collection-status-poll` |  |
| `GET /v1/fee-quotes/collections` | Preview the fee on a collection | collections.read | read | ✅ Ready | `fee-quote-collections` |  |

## Checkouts

| Endpoint | What it does | Permission | Kind | Load test | Pack | Notes |
|---|---|---|---|---|---|---|
| `GET /v1/checkouts` | List hosted checkouts | collections.read | read | ✅ Ready | `checkouts-list` |  |
| `POST /v1/checkouts` | Create a hosted checkout (payment link) | collections.write | write | ✅ Ready | `hosted-checkout-create` | Needs hosted checkout enabled and verification tier 2. |
| `GET /v1/checkouts/{checkoutId}` | Get a hosted checkout | collections.read | read | 🟡 Needs data | `checkout-status-poll` |  |
| `POST /v1/checkouts/{checkoutId}/cancel` | Cancel a hosted checkout | collections.write | write | ⛔ Excluded | — | Needs a fresh open checkout per call; low value. Covered functionally, not under load. |

## Payouts

| Endpoint | What it does | Permission | Kind | Load test | Pack | Notes |
|---|---|---|---|---|---|---|
| `POST /v1/payouts` | Send money to a recipient | disbursements.write | money | ✅ Ready | `payouts-momo-telecel` | Sandbox: Telecel fixtures only. |
| `POST /v1/payout-batches` | Send up to 100 payouts at once | disbursements.write | money | ✅ Ready | `payout-batch-telecel` | Safety gate judges requests/s × batch size. |
| `GET /v1/payouts/{reference}` | Get a payout | disbursements.read | read | 🟡 Needs data | `payout-status-poll` |  |
| `GET /v1/fee-quotes/payouts` | Preview the fee on a payout | disbursements.write | read | ✅ Ready | `fee-quote-payouts` |  |

## Utilities

| Endpoint | What it does | Permission | Kind | Load test | Pack | Notes |
|---|---|---|---|---|---|---|
| `GET /v1/utility-products` | List airtime and data products | disbursements.read | read | ✅ Ready | `utility-products` |  |
| `GET /v1/fee-quotes/utilities` | Preview the fee on a utility purchase | disbursements.write | read | 🟡 Needs data | `fee-quote-utilities` | Needs a productId from the product list. |
| `POST /v1/utility-purchases` | Buy airtime or data | disbursements.write | money | ⚠️ Caution | `utility-purchase-airtime` | **REAL side effects in test.** REAL airtime and money even in test. ≤1 rps, own number, explicit authorization. |
| `GET /v1/utility-purchases/{reference}` | Get a utility purchase | disbursements.read | read | 🟡 Needs data | `utility-purchase-status-poll` |  |

## Settlements

| Endpoint | What it does | Permission | Kind | Load test | Pack | Notes |
|---|---|---|---|---|---|---|
| `GET /v1/settlement-policy` | Get where and when settlements are paid | settlement_policies.read | read | ⛔ Excluded | — | Configuration read; no meaningful load profile. |
| `PUT /v1/settlement-policy` | Set where and when settlements are paid | settlement_policies.write | config | ⛔ Excluded | — | Changes where real money is paid out. |
| `DELETE /v1/settlement-policy` | Turn settlement off | settlement_policies.write | config | ⛔ Excluded | — | Destructive configuration change. |
| `GET /v1/settlements` | List settlement runs | settlements.read | read | ✅ Ready | `settlements-list` |  |
| `POST /v1/settlements` | Settle now | settlements.write | money | ⛔ Excluded | — | Pays the wallet out to a verified account; the docs do not say whether test runs move real funds. |
| `GET /v1/settlements/latest` | Get the latest settlement run | settlements.read | read | ✅ Ready | `settlement-latest` |  |
| `GET /v1/settlements/{id}` | Get a settlement run | settlements.read | read | ⛔ Excluded | — | Same read path as the list/latest packs. |
| `POST /v1/settlements/{id}/resettlements` | Retry a failed settlement run | settlements.write | money | ⛔ Excluded | — | Moves money; a run can be retried only once. |

## Transfers

| Endpoint | What it does | Permission | Kind | Load test | Pack | Notes |
|---|---|---|---|---|---|---|
| `GET /v1/recipients/{handle}` | Check who a handle belongs to | wallettransfer.write | read | 🟡 Needs data | `recipient-lookup` | Use handles your organisation controls. |
| `POST /v1/transfers` | Send money to another business | wallettransfer.write | money | ⚠️ Caution | `wallet-transfer` | Docs do not mention a test mode; cannot be reversed. Confirm with iSmart first. |
| `GET /v1/transfers/{reference}` | Get a transfer | wallettransfer.read | read | 🟡 Needs data | `transfer-status-poll` |  |

## Reference

| Endpoint | What it does | Permission | Kind | Load test | Pack | Notes |
|---|---|---|---|---|---|---|
| `GET /v1/payment-methods` | List providers you can use | collections.read | read | ✅ Ready | `payment-methods` |  |
| `GET /v1/party-lookups` | Look up the name on a mobile money number | collections.read | read | ⚠️ Caution | `party-lookup` | Forwarded to the mobile-money provider; keep low-rate. |

## Account

| Endpoint | What it does | Permission | Kind | Load test | Pack | Notes |
|---|---|---|---|---|---|---|
| `GET /v1/limits` | Read limits and remaining headroom | transactions.read | read | ✅ Ready | `limits` |  |
| `GET /v1/wallet` | Read wallet balances | transactions.read | read | ✅ Ready | `wallet-balance` |  |
| `GET /v1/transactions` | List transactions | transactions.read | read | ✅ Ready | `transactions-list` |  |

## Events

| Endpoint | What it does | Permission | Kind | Load test | Pack | Notes |
|---|---|---|---|---|---|---|
| `GET /v1/events` | Catch up on missed events | collections.read, disbursements.read, settlements.read, wallettransfer.read | read | ✅ Ready | `events-list` |  |

## Webhooks (iSmartPay → your endpoint)

Not APIs we drive: they are tested through the correctness suite (signature, duplicates, ordering, retries).

- `collection.accepted`
- `collection.status_changed`
- `payout.accepted`
- `payout.status_changed`
- `utility_purchase.accepted`
- `utility_purchase.status_changed`
- `settlement.status_changed`
- `transfer.status_changed`
- `transfer.received`
