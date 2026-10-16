/**
 * Every endpoint iSmartPay documents (stgdocs.ismartghana.com/reference, read
 * 2026-10-15) and what we can safely do with it under load.
 *
 * loadTest:
 *   ready          a scenario pack exists and needs no pre-existing state
 *   needs_data     a pack exists but its data set must carry ids/references
 *                  created by an earlier run (or a handle you control)
 *   caution        a pack exists but the call reaches outside iSmartPay or has
 *                  real-world effects — low rate, explicit sign-off
 *   excluded       deliberately NOT load-tested (configuration, destructive,
 *                  or moves wallet money to a real settlement account)
 *   other          not an API call we can drive at volume (see note)
 */
export type LoadTestStatus = 'ready' | 'needs_data' | 'caution' | 'excluded' | 'other';
export type EndpointKind = 'read' | 'money' | 'write' | 'config' | 'auth' | 'webhook';

export interface CatalogEntry {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path template exactly as documented (`{reference}` etc.). */
  path: string;
  area: string;
  summary: string;
  /** Credential permission(s) the docs name; empty when the docs do not name one. */
  permission: string[];
  kind: EndpointKind;
  moneyMoving: boolean;
  /** Real-world effect even in the test environment. */
  realSideEffects: boolean;
  loadTest: LoadTestStatus;
  /** Scenario pack that drives it, when one exists. */
  packId?: string;
  note?: string;
}

const e = (
  method: CatalogEntry['method'],
  path: string,
  area: string,
  summary: string,
  permission: string[],
  kind: EndpointKind,
  loadTest: LoadTestStatus,
  extra: Partial<Pick<CatalogEntry, 'packId' | 'note' | 'moneyMoving' | 'realSideEffects'>> = {},
): CatalogEntry => ({
  method,
  path,
  area,
  summary,
  permission,
  kind,
  moneyMoving: extra.moneyMoving ?? kind === 'money',
  realSideEffects: extra.realSideEffects ?? false,
  loadTest,
  ...(extra.packId ? { packId: extra.packId } : {}),
  ...(extra.note ? { note: extra.note } : {}),
});

export const CATALOG: CatalogEntry[] = [
  // Auth
  e(
    'POST',
    '/v1/oauth/token',
    'Auth',
    'Exchange client id/secret for a 5-minute bearer token',
    [],
    'auth',
    'other',
    {
      note: 'Shared identity path. Exercised implicitly by every run (one handshake per VU refresh); do not hammer it directly.',
    },
  ),

  // Collections
  e(
    'POST',
    '/v1/collections',
    'Collections',
    'Collect money from a payer into your wallet',
    ['collections.write'],
    'money',
    'ready',
    { packId: 'collections-momo-telecel', note: 'Sandbox: Telecel fixtures only.' },
  ),
  e(
    'GET',
    '/v1/collections/{reference}',
    'Collections',
    'Get a collection',
    ['collections.read'],
    'read',
    'needs_data',
    { packId: 'collection-status-poll' },
  ),
  e(
    'GET',
    '/v1/fee-quotes/collections',
    'Collections',
    'Preview the fee on a collection',
    ['collections.read'],
    'read',
    'ready',
    { packId: 'fee-quote-collections' },
  ),

  // Checkouts
  e(
    'GET',
    '/v1/checkouts',
    'Checkouts',
    'List hosted checkouts',
    ['collections.read'],
    'read',
    'ready',
    { packId: 'checkouts-list' },
  ),
  e(
    'POST',
    '/v1/checkouts',
    'Checkouts',
    'Create a hosted checkout (payment link)',
    ['collections.write'],
    'write',
    'ready',
    {
      packId: 'hosted-checkout-create',
      note: 'Needs hosted checkout enabled and verification tier 2.',
    },
  ),
  e(
    'GET',
    '/v1/checkouts/{checkoutId}',
    'Checkouts',
    'Get a hosted checkout',
    ['collections.read'],
    'read',
    'needs_data',
    { packId: 'checkout-status-poll' },
  ),
  e(
    'POST',
    '/v1/checkouts/{checkoutId}/cancel',
    'Checkouts',
    'Cancel a hosted checkout',
    ['collections.write'],
    'write',
    'excluded',
    {
      note: 'Needs a fresh open checkout per call; low value. Covered functionally, not under load.',
    },
  ),

  // Payouts
  e(
    'POST',
    '/v1/payouts',
    'Payouts',
    'Send money to a recipient',
    ['disbursements.write'],
    'money',
    'ready',
    { packId: 'payouts-momo-telecel', note: 'Sandbox: Telecel fixtures only.' },
  ),
  e(
    'POST',
    '/v1/payout-batches',
    'Payouts',
    'Send up to 100 payouts at once',
    ['disbursements.write'],
    'money',
    'ready',
    { packId: 'payout-batch-telecel', note: 'Safety gate judges requests/s × batch size.' },
  ),
  e(
    'GET',
    '/v1/payouts/{reference}',
    'Payouts',
    'Get a payout',
    ['disbursements.read'],
    'read',
    'needs_data',
    { packId: 'payout-status-poll' },
  ),
  e(
    'GET',
    '/v1/fee-quotes/payouts',
    'Payouts',
    'Preview the fee on a payout',
    ['disbursements.write'],
    'read',
    'ready',
    { packId: 'fee-quote-payouts' },
  ),

  // Utilities
  e(
    'GET',
    '/v1/utility-products',
    'Utilities',
    'List airtime and data products',
    ['disbursements.read'],
    'read',
    'ready',
    { packId: 'utility-products' },
  ),
  e(
    'GET',
    '/v1/fee-quotes/utilities',
    'Utilities',
    'Preview the fee on a utility purchase',
    ['disbursements.write'],
    'read',
    'needs_data',
    { packId: 'fee-quote-utilities', note: 'Needs a productId from the product list.' },
  ),
  e(
    'POST',
    '/v1/utility-purchases',
    'Utilities',
    'Buy airtime or data',
    ['disbursements.write'],
    'money',
    'caution',
    {
      packId: 'utility-purchase-airtime',
      realSideEffects: true,
      note: 'REAL airtime and money even in test. ≤1 rps, own number, explicit authorization.',
    },
  ),
  e(
    'GET',
    '/v1/utility-purchases/{reference}',
    'Utilities',
    'Get a utility purchase',
    ['disbursements.read'],
    'read',
    'needs_data',
    { packId: 'utility-purchase-status-poll' },
  ),

  // Settlements
  e(
    'GET',
    '/v1/settlement-policy',
    'Settlements',
    'Get where and when settlements are paid',
    ['settlement_policies.read'],
    'read',
    'excluded',
    { note: 'Configuration read; no meaningful load profile.' },
  ),
  e(
    'PUT',
    '/v1/settlement-policy',
    'Settlements',
    'Set where and when settlements are paid',
    ['settlement_policies.write'],
    'config',
    'excluded',
    { note: 'Changes where real money is paid out.' },
  ),
  e(
    'DELETE',
    '/v1/settlement-policy',
    'Settlements',
    'Turn settlement off',
    ['settlement_policies.write'],
    'config',
    'excluded',
    { note: 'Destructive configuration change.' },
  ),
  e(
    'GET',
    '/v1/settlements',
    'Settlements',
    'List settlement runs',
    ['settlements.read'],
    'read',
    'ready',
    { packId: 'settlements-list' },
  ),
  e(
    'POST',
    '/v1/settlements',
    'Settlements',
    'Settle now',
    ['settlements.write'],
    'money',
    'excluded',
    {
      note: 'Pays the wallet out to a verified account; the docs do not say whether test runs move real funds.',
    },
  ),
  e(
    'GET',
    '/v1/settlements/latest',
    'Settlements',
    'Get the latest settlement run',
    ['settlements.read'],
    'read',
    'ready',
    { packId: 'settlement-latest' },
  ),
  e(
    'GET',
    '/v1/settlements/{id}',
    'Settlements',
    'Get a settlement run',
    ['settlements.read'],
    'read',
    'excluded',
    { note: 'Same read path as the list/latest packs.' },
  ),
  e(
    'POST',
    '/v1/settlements/{id}/resettlements',
    'Settlements',
    'Retry a failed settlement run',
    ['settlements.write'],
    'money',
    'excluded',
    { note: 'Moves money; a run can be retried only once.' },
  ),

  // Transfers
  e(
    'GET',
    '/v1/recipients/{handle}',
    'Transfers',
    'Check who a handle belongs to',
    ['wallettransfer.write'],
    'read',
    'needs_data',
    { packId: 'recipient-lookup', note: 'Use handles your organisation controls.' },
  ),
  e(
    'POST',
    '/v1/transfers',
    'Transfers',
    'Send money to another business',
    ['wallettransfer.write'],
    'money',
    'caution',
    {
      packId: 'wallet-transfer',
      note: 'Docs do not mention a test mode; cannot be reversed. Confirm with iSmart first.',
    },
  ),
  e(
    'GET',
    '/v1/transfers/{reference}',
    'Transfers',
    'Get a transfer',
    ['wallettransfer.read'],
    'read',
    'needs_data',
    { packId: 'transfer-status-poll' },
  ),

  // Reference
  e(
    'GET',
    '/v1/payment-methods',
    'Reference',
    'List providers you can use',
    ['collections.read'],
    'read',
    'ready',
    { packId: 'payment-methods' },
  ),
  e(
    'GET',
    '/v1/party-lookups',
    'Reference',
    'Look up the name on a mobile money number',
    ['collections.read'],
    'read',
    'caution',
    { packId: 'party-lookup', note: 'Forwarded to the mobile-money provider; keep low-rate.' },
  ),

  // Account
  e(
    'GET',
    '/v1/limits',
    'Account',
    'Read limits and remaining headroom',
    ['transactions.read'],
    'read',
    'ready',
    { packId: 'limits' },
  ),
  e(
    'GET',
    '/v1/wallet',
    'Account',
    'Read wallet balances',
    ['transactions.read'],
    'read',
    'ready',
    { packId: 'wallet-balance' },
  ),
  e(
    'GET',
    '/v1/transactions',
    'Account',
    'List transactions',
    ['transactions.read'],
    'read',
    'ready',
    { packId: 'transactions-list' },
  ),

  // Events
  e(
    'GET',
    '/v1/events',
    'Events',
    'Catch up on missed events',
    ['collections.read', 'disbursements.read', 'settlements.read', 'wallettransfer.read'],
    'read',
    'ready',
    { packId: 'events-list' },
  ),

  // Webhooks — outbound from iSmartPay to YOUR endpoint
  ...(
    [
      'collection.accepted',
      'collection.status_changed',
      'payout.accepted',
      'payout.status_changed',
      'utility_purchase.accepted',
      'utility_purchase.status_changed',
      'settlement.status_changed',
      'transfer.status_changed',
      'transfer.received',
    ] as const
  ).map((type) =>
    e(
      'POST',
      `webhook:${type}`,
      'Webhooks',
      `iSmartPay → your endpoint: ${type}`,
      [],
      'webhook',
      'other',
      {
        note: 'Inbound to OUR receiver, not an API we drive. Verified by the correctness suite (signature, duplicates, ordering, retries); load = how many events our receiver absorbs.',
      },
    ),
  ),
];

/** `/v1/payouts/{{data.reference}}?x=1` → `/v1/payouts/{reference}` for matching packs to the catalog. */
export function normalizePackPath(path: string): string {
  return path.split('?')[0]!.replace(/\{\{data\.([A-Za-z0-9_.]+)\}\}/g, '{$1}');
}

export interface CatalogSummary {
  total: number;
  apiEndpoints: number;
  byStatus: Record<LoadTestStatus, number>;
  /** Endpoints with a runnable pack today (ready + needs_data + caution). */
  withPack: number;
}

export function catalogSummary(entries: CatalogEntry[] = CATALOG): CatalogSummary {
  const byStatus: Record<LoadTestStatus, number> = {
    ready: 0,
    needs_data: 0,
    caution: 0,
    excluded: 0,
    other: 0,
  };
  for (const x of entries) byStatus[x.loadTest]++;
  return {
    total: entries.length,
    apiEndpoints: entries.filter((x) => x.kind !== 'webhook').length,
    byStatus,
    withPack: entries.filter((x) => x.packId).length,
  };
}
