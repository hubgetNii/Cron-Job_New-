import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * iSmartPay developer-API contract — single source of truth for the simulator,
 * the scenario packs (Phase 24) and the correctness suite (Phase 25).
 *
 * PROVENANCE: transcribed 2026-10-15 from https://stgdocs.ismartghana.com
 * (guides: authentication, sandbox, idempotency-and-references, money-and-fees,
 * payment-statuses, errors, webhooks, going-live, utility-purchases,
 * payout-batches, wallet-transfers, settlements; reference pages for
 * collections, payouts, payout-batches, utility-purchases, transfers,
 * checkouts, settlements, wallet, limits, transactions, events,
 * payment-methods, webhooks). Where the docs are silent the entry is listed in
 * UNDOCUMENTED below so nobody mistakes a simulator convention for a fact.
 * Re-verify against the live docs before relying on this for sign-off.
 */

/* ── Primitives ─────────────────────────────────────────────────────────── */

export const REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const AMOUNT_RE = /^\d+\.\d{2}$/;
export const CURRENCY_RE = /^[A-Z]{3}$/;
/** Idempotency-Key: 1–255 characters (format otherwise unconstrained). */
export const IDEMPOTENCY_KEY_MAX = 255;
/** International format without the plus, e.g. 233244123456 (utility beneficiaries). */
export const MSISDN_233_RE = /^233\d{9}$/;

export const PROVIDERS = ['mtn', 'telecel', 'calbank'] as const;
export const PARTY_TYPES = ['msisdn', 'account', 'card'] as const;
export const FEE_BEARERS = ['initiator', 'non_initiator'] as const;

/* ── Statuses (docs: payment-statuses, utility-purchases, wallet-transfers) ─ */

export const COLLECTION_STATUSES = [
  'accepted',
  'dispatched',
  'in_review',
  'held',
  'settled',
  'failed',
  'expired',
] as const;
export const COLLECTION_FINAL = new Set(['settled', 'failed', 'expired']);

export const PAYOUT_STATUSES = [
  'accepted',
  'dispatching',
  'in_review',
  'held',
  'delivered',
  'failed',
  'refunded',
] as const;
/** `failed` ends the attempt but `refunded` may follow, so only `refunded`/`delivered` are truly final. */
export const PAYOUT_FINAL = new Set(['delivered', 'refunded']);

export const UTILITY_STATUSES = [
  'accepted',
  'awaiting_payment',
  'vending',
  'delivered',
  'failed',
  'refunding',
  'refunded',
  'refund_failed',
  'outcome_unknown',
] as const;
export const UTILITY_FINAL = new Set(['delivered', 'refunded']);

export const TRANSFER_STATUSES = ['pending', 'held', 'completed', 'declined', 'failed'] as const;
export const CHECKOUT_STATUSES = ['open', 'paid', 'expired', 'cancelled'] as const;
export const SETTLEMENT_RUN_STATUSES = ['running', 'completed'] as const;
export const SETTLEMENT_OUTCOMES = ['settled', 'failed_partial', 'failed_all'] as const;

/** The docs say unknown statuses must be treated as still in progress. */
export const isInProgress = (final: Set<string>, status: string): boolean => !final.has(status);

/* ── Errors (docs: errors) ──────────────────────────────────────────────── */

export const ERROR_HTTP: Record<string, number> = {
  invalid_input: 400,
  own_handle: 400,
  transfer_refused: 400,
  unauthenticated: 401,
  forbidden: 403,
  environment_mismatch: 403,
  tier_ineligible: 403,
  transaction_limit_exceeded: 403,
  daily_limit_exceeded: 403,
  monthly_limit_exceeded: 403,
  limits_missing: 403,
  limits_unusable: 403,
  business_suspended: 403,
  business_deactivated: 403,
  not_found: 404,
  product_not_found: 404,
  idempotency_key_reused: 409,
  request_in_flight: 409,
  duplicate_reference: 409,
  checkout_not_enabled: 409,
  checkout_not_open: 409,
  checkout_reference_taken: 409,
  settlement_in_progress: 409,
  resettlement_not_allowed: 409,
  settlement_already_retried: 409,
  transfer_not_held: 409,
  destination_not_verified: 422,
  product_not_sellable: 422,
  amount_out_of_range: 422,
  currency_not_supported: 422,
  beneficiary_invalid: 422,
  fee_unpriceable: 422,
  rate_limited: 429,
  internal: 500,
  provider_error: 502,
  environment_unknown: 503,
  utilities_unavailable: 503,
  checkout_unavailable: 503,
  destination_verification_unavailable: 503,
  upstream_timeout: 504,
  provider_timeout: 504,
};

/** Safe to retry with the SAME Idempotency-Key and body. */
export const RETRYABLE_WITH_SAME_KEY = new Set([429, 500, 502, 503, 504]);
/** Never retry: the same request would fail the same way. */
export const NEVER_RETRY = new Set([400, 401, 403, 404]);

/**
 * Codes/behaviour the docs do NOT specify. The simulator uses these
 * conventions; do not treat them as iSmartPay facts.
 */
export const UNDOCUMENTED = {
  insufficientFundsCode: 'insufficient_funds', // payout/transfer with too little wallet balance
  rateLimitThresholds: 'unknown — only Retry-After is documented',
  idempotencyRetentionWindow: 'unknown',
  feeRounding: 'unknown — simulator rounds half-up to pesewas, min 0.10',
  webhookEventsPerRetryGap: 'unknown — "6 attempts over about a day, growing gaps"',
  collectionFailureReasons: 'unknown — simulator uses wrong_pin / declined',
} as const;

/* ── Request schemas ────────────────────────────────────────────────────── */

const amount = z.string().regex(AMOUNT_RE);
const currency = z.string().regex(CURRENCY_RE);
const reference = z.string().regex(REFERENCE_RE);
const note = z
  .string()
  .max(50)

  .regex(/^[^\u0000-\u001f\u007f]*$/);
const party = z.object({ type: z.enum(PARTY_TYPES), value: z.string().min(1).max(100) }).strict();

export const TokenFormSchema = z.object({
  grant_type: z.literal('client_credentials'),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  resource: z.literal('ismartpay'),
});

export const CollectionRequestSchema = z
  .object({
    reference,
    amount,
    currency,
    provider: z.string().min(1),
    payer: party,
    note: note.optional(),
  })
  .strict();

export const PayoutRequestSchema = z
  .object({
    reference,
    amount,
    currency,
    provider: z.string().min(1),
    destination: party,
    note: note.optional(),
  })
  .strict();

export const PayoutBatchRequestSchema = z
  .object({ reference, items: z.array(PayoutRequestSchema).min(1).max(100) })
  .strict();

export const UtilityPurchaseRequestSchema = z
  .object({
    reference,
    productId: z.string().min(1),
    amount,
    currency,
    beneficiary: z
      .object({
        msisdn: z.string().regex(MSISDN_233_RE),
        accountNumber: z
          .string()
          .regex(/^[A-Za-z0-9]{1,32}$/)
          .optional(),
      })
      .strict(),
    funding: z
      .object({
        type: z.enum(['wallet', 'collection']),
        payer: z
          .object({ provider: z.enum(['mtn', 'telecel']), msisdn: z.string().regex(MSISDN_233_RE) })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

export const TransferRequestSchema = z
  .object({
    reference: reference.refine((r) => !r.startsWith('rvr-'), 'reference must not start with rvr-'),
    handle: z.string().min(1).max(40),
    amount,
    currency,
  })
  .strict();

export const SettleNowRequestSchema = z.object({ reference }).strict();

/* ── Response schemas (lenient: docs say fields may be absent / others appear) ─ */

const looseStatus = z.string();
const reconciliation = z.object({
  status: z.enum(['unchecked', 'matched', 'mismatched']),
  checkedAt: z.string().optional(),
});

export const MoneyMovementSchema = z
  .object({
    reference: z.string(),
    status: looseStatus,
    amount: amount.optional(),
    currency: currency.optional(),
    provider: z.string().optional(),
    fee: amount.optional(),
    feeBearer: z.enum(FEE_BEARERS).optional(),
    payerAmount: amount.optional(),
    recipientAmount: amount.optional(),
    note: z.string().optional(),
    failureReason: z.string().optional(),
    createdAt: z.string().optional(),
    completedAt: z.string().optional(),
    channel: z.string().optional(),
    settlementStatus: z.enum(['not_eligible', 'eligible', 'claimed', 'settled']).optional(),
    reconciliation: reconciliation.optional(),
  })
  .passthrough();

export const BatchResponseSchema = z.object({
  batchId: z.string(),
  reference: z.string(),
  items: z.array(
    z
      .object({
        reference: z.string(),
        status: z.number().int(),
        payout: MoneyMovementSchema.optional(),
        error: z.object({ code: z.string(), message: z.string() }).optional(),
      })
      .passthrough(),
  ),
});

export const ErrorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export const TransferResponseSchema = z
  .object({
    reference: z.string(),
    amount,
    currency,
    status: looseStatus,
    recipientHandle: z.string().optional(),
    recipientName: z.string().optional(),
    failureReason: z.string().optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();

export const WalletResponseSchema = z.object({
  items: z.array(
    z
      .object({
        name: z.string(),
        balances: z.record(z.string(), amount),
        reserved: z.record(z.string(), amount).optional(),
        createdAt: z.string().optional(),
      })
      .passthrough(),
  ),
});

/* ── Sandbox fixtures (docs: sandbox) ───────────────────────────────────── */

/**
 * The ONLY documented test numbers: Telecel, in `233…` or short `000…` form.
 * MTN / CalBank have none ("do not guess them"). Any other number is not a
 * test number. Note these are structurally invalid Ghana mobile numbers
 * (national part starts with 0), so they satisfy the Class-A data rule.
 */
export const TELECEL_FIXTURES = {
  '233000000001': { collection: 'settled', payout: 'delivered' },
  '233000000003': { collection: null, payout: 'failed_refunded' },
  '233000000004': { collection: 'failed_wrong_pin', payout: null },
} as const;

export function normalizeFixtureNumber(value: string): string {
  const digits = value.replace(/[^\d]/g, '');
  if (/^0{9}\d{3}$/.test(digits)) return `233${digits.slice(-9)}`; // short form 000000000001
  return digits;
}

/* ── Permissions (per credential) ───────────────────────────────────────── */

export const PERMISSIONS: Record<string, string> = {
  'POST /v1/collections': 'collections.write',
  'POST /v1/checkouts': 'collections.write',
  'POST /v1/payouts': 'disbursements.write',
  'POST /v1/payout-batches': 'disbursements.write',
  'POST /v1/utility-purchases': 'disbursements.write',
  'GET /v1/utility-products': 'disbursements.read',
  'POST /v1/transfers': 'wallettransfer.write',
  'GET /v1/recipients/{handle}': 'wallettransfer.write',
  'POST /v1/settlements': 'settlements.write',
  'PUT /v1/settlement-policy': 'settlement_policies.write',
  'GET /v1/wallet': 'transactions.read',
  'GET /v1/limits': 'transactions.read',
  'GET /v1/transactions': 'transactions.read',
};

/* ── Webhooks (docs: webhooks) ──────────────────────────────────────────── */

export const WEBHOOK_EVENT_TYPES = [
  'collection.accepted',
  'collection.status_changed',
  'payout.accepted',
  'payout.status_changed',
  'utility_purchase.accepted',
  'utility_purchase.status_changed',
  'settlement.status_changed',
  'transfer.status_changed',
  'transfer.received',
] as const;

export const WEBHOOK_TOLERANCE_SECONDS = 300;

export interface WebhookEnvelope {
  id: string;
  type: string;
  createdAt: string;
  data: Record<string, unknown>;
}

/** `v1,` + base64(HMAC-SHA256(secret, "<id>.<timestamp>.<raw body>")). Secret used exactly as issued. */
export function signWebhook(
  secret: string,
  id: string,
  timestamp: string,
  rawBody: string,
): string {
  return `v1,${createHmac('sha256', secret).update(`${id}.${timestamp}.${rawBody}`).digest('base64')}`;
}

export type WebhookVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Receiver-side verification exactly as documented: signed text over the RAW
 * body, constant-time compare, reject timestamps >5 min from now. The header
 * may carry several space-separated `v1,<sig>` values during secret rotation.
 */
export function verifyWebhook(input: {
  secret: string;
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  nowSeconds?: number;
}): WebhookVerdict {
  const { secret, id, timestamp, signature, rawBody } = input;
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing headers' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' };
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > WEBHOOK_TOLERANCE_SECONDS)
    return { ok: false, reason: 'timestamp outside tolerance' };
  const expected = Buffer.from(signWebhook(secret, id, timestamp, rawBody));
  for (const candidate of signature.split(' ')) {
    const got = Buffer.from(candidate);
    if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true };
  }
  return { ok: false, reason: 'signature mismatch' };
}

/** Fee maths from the docs (money-and-fees). All values in pesewas. */
export function applyFee(
  amountPesewas: number,
  feePesewas: number,
  bearer: (typeof FEE_BEARERS)[number],
): { payerAmount: number; recipientAmount: number } {
  return bearer === 'initiator'
    ? { payerAmount: amountPesewas + feePesewas, recipientAmount: amountPesewas }
    : { payerAmount: amountPesewas, recipientAmount: amountPesewas - feePesewas };
}
