import type { LoadProfile } from '../../domain/enums.js';
import { PlanConfigSchema, type PlanConfig } from '../../domain/load-plan.js';

/**
 * Scenario packs (Phase 24): ready-made, contract-accurate plan templates per
 * iSmartPay channel. Every request shape below follows the documented API
 * (see ../contract/ismartpay.ts); amounts are decimal strings, every POST sends
 * an Idempotency-Key, and every reference is run-unique (`{{ref}}`).
 *
 * Sandbox facts that shape the packs (docs: sandbox):
 *  - ONLY Telecel has documented test numbers (233000000001 succeeds,
 *    …003 payout fails + refunds, …004 collection fails with a wrong PIN).
 *    MTN / CalBank have none — never guess them.
 *  - Utility purchases are REAL in test (real airtime, real money): flagged
 *    `realSideEffects`, held to ≤1 rps and explicit authorization by the gate.
 *  - Wallet transfers: the docs do not mention a test mode — `sandboxSupport: 'unknown'`.
 */

export interface PackParams {
  profile?: LoadProfile | undefined;
  targetRps?: number | undefined;
  durationSeconds?: number | undefined;
  maxVus?: number | undefined;
  dataSetId?: string | undefined;
  /** Items per request for batch packs. */
  batchSize?: number | undefined;
}

export interface ExampleDataSet {
  name: string;
  description: string;
  environment: 'sandbox';
  records: Record<string, unknown>[];
  /** True when a placeholder must be replaced before the set is usable. */
  needsEdit: boolean;
}

export interface ScenarioPack {
  id: string;
  title: string;
  channel: string;
  description: string;
  endpoint: { method: 'GET' | 'POST'; path: string };
  moneyMoving: boolean;
  realSideEffects: boolean;
  sandboxSupport: 'documented' | 'partial' | 'unknown' | 'none';
  /** Credential permissions the API key needs (docs: reference pages). */
  permissions: string[];
  expectedStatuses: number[];
  /** `{{data.*}}` fields every data-set record must carry. */
  dataFields: string[];
  recommended: { profile: LoadProfile; targetRps: number; durationSeconds: number; maxVus: number };
  notes: string[];
  /** Set when the endpoint touches something outside iSmartPay (e.g. calls the mobile-money provider). */
  caution?: string | undefined;
  exampleDataSets: ExampleDataSet[];
  body: (p: PackParams) => unknown;
  fanout: (p: PackParams) => number;
}

const tag = (id: string): Record<string, unknown> => ({
  test_data: true,
  test_case_id: id,
  environment: 'sandbox',
});

const none = (): undefined => undefined;
const one = (): number => 1;
const batchSize = (p: PackParams): number => Math.min(100, Math.max(1, p.batchSize ?? 10));

const READ_ONLY = { profile: 'LOAD', targetRps: 5, durationSeconds: 60, maxVus: 20 } as const;

const CORE_PACKS: ScenarioPack[] = [
  {
    id: 'collections-momo-telecel',
    title: 'Mobile-money collection (Telecel)',
    channel: 'mobile_money',
    description: 'POST /v1/collections against the documented Telecel test numbers.',
    endpoint: { method: 'POST', path: '/v1/collections' },
    moneyMoving: true,
    realSideEffects: false,
    sandboxSupport: 'documented',
    permissions: ['collections.write'],
    expectedStatuses: [202],
    dataFields: ['amount', 'payerMsisdn'],
    recommended: { profile: 'LOAD', targetRps: 5, durationSeconds: 120, maxVus: 50 },
    notes: [
      '202 means accepted, not settled — read the outcome from status / webhook.',
      'Telecel only: 233000000001 settles, 233000000004 fails as a wrong PIN.',
      'References are unique forever; the runner derives them from the run id.',
    ],
    exampleDataSets: [
      {
        name: 'collections-success',
        description: 'Documented Telecel success number.',
        environment: 'sandbox',
        needsEdit: false,
        records: [{ ...tag('COLL-001'), amount: '1.00', payerMsisdn: '233000000001' }],
      },
      {
        name: 'collections-wrong-pin',
        description: 'Documented Telecel wrong-PIN failure number.',
        environment: 'sandbox',
        needsEdit: false,
        records: [{ ...tag('COLL-004'), amount: '1.00', payerMsisdn: '233000000004' }],
      },
    ],
    body: () => ({
      reference: '{{ref}}',
      amount: '{{data.amount}}',
      currency: 'GHS',
      provider: 'telecel',
      payer: { type: 'msisdn', value: '{{data.payerMsisdn}}' },
    }),
    fanout: one,
  },
  {
    id: 'payouts-momo-telecel',
    title: 'Mobile-money payout (Telecel)',
    channel: 'mobile_money',
    description: 'POST /v1/payouts against the documented Telecel test numbers.',
    endpoint: { method: 'POST', path: '/v1/payouts' },
    moneyMoving: true,
    realSideEffects: false,
    sandboxSupport: 'documented',
    permissions: ['disbursements.write'],
    expectedStatuses: [202],
    dataFields: ['amount', 'destinationMsisdn'],
    recommended: { profile: 'LOAD', targetRps: 5, durationSeconds: 120, maxVus: 50 },
    notes: [
      'The amount is reserved from the wallet on accept; a failed payout is refunded.',
      'Telecel only: 233000000001 delivers, 233000000003 fails and funds are returned.',
      'Never retry a payout with a new reference — only with the same Idempotency-Key and body.',
    ],
    exampleDataSets: [
      {
        name: 'payouts-success',
        description: 'Documented Telecel success number.',
        environment: 'sandbox',
        needsEdit: false,
        records: [{ ...tag('PAY-001'), amount: '1.00', destinationMsisdn: '233000000001' }],
      },
      {
        name: 'payouts-fail-refund',
        description: 'Documented Telecel failing payout number (funds returned).',
        environment: 'sandbox',
        needsEdit: false,
        records: [{ ...tag('PAY-003'), amount: '1.00', destinationMsisdn: '233000000003' }],
      },
    ],
    body: () => ({
      reference: '{{ref}}',
      amount: '{{data.amount}}',
      currency: 'GHS',
      provider: 'telecel',
      destination: { type: 'msisdn', value: '{{data.destinationMsisdn}}' },
    }),
    fanout: one,
  },
  {
    id: 'payout-batch-telecel',
    title: 'Payout batch (Telecel)',
    channel: 'mobile_money',
    description: 'POST /v1/payout-batches with up to 100 payouts per request.',
    endpoint: { method: 'POST', path: '/v1/payout-batches' },
    moneyMoving: true,
    realSideEffects: false,
    sandboxSupport: 'documented',
    permissions: ['disbursements.write'],
    expectedStatuses: [200],
    dataFields: ['amount', 'destinationMsisdn'],
    recommended: { profile: 'LOAD', targetRps: 1, durationSeconds: 120, maxVus: 20 },
    notes: [
      'One request = batchSize payments, so the safety gate judges requests/s × batchSize.',
      '200 does NOT mean every payout was sent — check each item’s status.',
      'There is no batch read endpoint; read payouts individually.',
    ],
    exampleDataSets: [
      {
        name: 'batch-success',
        description: 'Documented Telecel success number for every item.',
        environment: 'sandbox',
        needsEdit: false,
        records: [{ ...tag('BATCH-001'), amount: '1.00', destinationMsisdn: '233000000001' }],
      },
    ],
    body: (p) => ({
      reference: '{{ref}}',
      items: [
        {
          $repeat: batchSize(p),
          template: {
            reference: '{{ref}}-{{i}}',
            amount: '{{data.amount}}',
            currency: 'GHS',
            provider: 'telecel',
            destination: { type: 'msisdn', value: '{{data.destinationMsisdn}}' },
          },
        },
      ],
    }),
    fanout: batchSize,
  },
  {
    id: 'utility-purchase-airtime',
    title: 'Airtime / data purchase (REAL in test)',
    channel: 'utility',
    description: 'POST /v1/utility-purchases funded from the wallet.',
    endpoint: { method: 'POST', path: '/v1/utility-purchases' },
    moneyMoving: true,
    realSideEffects: true,
    sandboxSupport: 'none',
    permissions: ['disbursements.write', 'disbursements.read'],
    expectedStatuses: [202],
    dataFields: ['productId', 'amount', 'beneficiaryMsisdn'],
    recommended: { profile: 'SMOKE', targetRps: 1, durationSeconds: 30, maxVus: 3 },
    notes: [
      'There is NO sandbox for airtime and data: real airtime is sent and real money is spent.',
      'Use your OWN number, small amounts, ≤1 rps, and an authorization that allows real side effects.',
      'Read productId from GET /v1/utility-products — do not hard-code it.',
      'outcome_unknown / refund_failed are resolved by iSmartPay: never repurchase with a new reference.',
    ],
    exampleDataSets: [
      {
        name: 'utility-own-number',
        description:
          'Replace productId; the number comes from the worker secret LT_SECRET_LT_TEST_SIM_MSISDN.',
        environment: 'sandbox',
        needsEdit: true,
        records: [
          {
            ...tag('UTIL-001'),
            productId: 'REPLACE_WITH_PRODUCT_ID_FROM_/v1/utility-products',
            amount: '1.00',
            beneficiaryMsisdn: '{{secret:LT_TEST_SIM_MSISDN}}',
          },
        ],
      },
    ],
    body: () => ({
      reference: '{{ref}}',
      productId: '{{data.productId}}',
      amount: '{{data.amount}}',
      currency: 'GHS',
      beneficiary: { msisdn: '{{data.beneficiaryMsisdn}}' },
      funding: { type: 'wallet' },
    }),
    fanout: one,
  },
  {
    id: 'wallet-transfer',
    title: 'Wallet-to-wallet transfer',
    channel: 'wallet',
    description: 'POST /v1/transfers to another iSmartPay business handle.',
    endpoint: { method: 'POST', path: '/v1/transfers' },
    moneyMoving: true,
    realSideEffects: false,
    sandboxSupport: 'unknown',
    permissions: ['wallettransfer.write'],
    expectedStatuses: [200],
    dataFields: ['handle', 'amount'],
    recommended: { profile: 'SMOKE', targetRps: 1, durationSeconds: 30, maxVus: 3 },
    notes: [
      'The docs do not mention a test mode for transfers — confirm with iSmart before running.',
      'No PIN, no approval, no fee, and the API cannot reverse a transfer.',
      'Use a handle your own organisation controls.',
    ],
    exampleDataSets: [
      {
        name: 'transfer-own-handle',
        description: 'Replace the handle with a test business your team controls.',
        environment: 'sandbox',
        needsEdit: true,
        records: [{ ...tag('XFER-001'), handle: 'REPLACE_WITH_TEST_HANDLE', amount: '1.00' }],
      },
    ],
    body: () => ({
      reference: '{{ref}}',
      handle: '{{data.handle}}',
      amount: '{{data.amount}}',
      currency: 'GHS',
    }),
    fanout: one,
  },
  {
    id: 'hosted-checkout-create',
    title: 'Hosted checkout (payment link)',
    channel: 'checkout',
    description: 'POST /v1/checkouts — creates a payment link; money moves only if a payer pays.',
    endpoint: { method: 'POST', path: '/v1/checkouts' },
    moneyMoving: false,
    realSideEffects: false,
    sandboxSupport: 'partial',
    permissions: ['collections.write'],
    expectedStatuses: [201],
    dataFields: ['amount'],
    recommended: { profile: 'LOAD', targetRps: 2, durationSeconds: 60, maxVus: 20 },
    notes: [
      'Needs hosted checkout enabled by the business owner and verification tier 2.',
      'The returned url carries a public bearer token — never log or share it.',
    ],
    exampleDataSets: [
      {
        name: 'checkout-amount',
        description: 'Fixed-amount checkouts.',
        environment: 'sandbox',
        needsEdit: false,
        records: [{ ...tag('CHK-001'), amount: '1.00' }],
      },
    ],
    body: () => ({
      reference: '{{ref}}',
      amount: '{{data.amount}}',
      currency: 'GHS',
      description: 'Load test checkout',
    }),
    fanout: one,
  },
  {
    id: 'collection-status-poll',
    title: 'Collection status lookup',
    channel: 'mobile_money',
    description: 'GET /v1/collections/{reference} — the read path clients poll while waiting.',
    endpoint: { method: 'GET', path: '/v1/collections/{{data.reference}}' },
    moneyMoving: false,
    realSideEffects: false,
    sandboxSupport: 'documented',
    permissions: ['collections.read'],
    expectedStatuses: [200],
    dataFields: ['reference'],
    recommended: { ...READ_ONLY, targetRps: 10 },
    notes: ['Feed it references created by an earlier collections run.'],
    exampleDataSets: [
      {
        name: 'collection-references',
        description: 'Replace with real references from a previous run.',
        environment: 'sandbox',
        needsEdit: true,
        records: [{ ...tag('POLL-001'), reference: 'REPLACE_WITH_EXISTING_REFERENCE' }],
      },
    ],
    body: none,
    fanout: one,
  },
  {
    id: 'fee-quote-collections',
    title: 'Collection fee quote',
    channel: 'pricing',
    description: 'GET /v1/fee-quotes/collections — holds nothing, safe read.',
    endpoint: {
      method: 'GET',
      path: '/v1/fee-quotes/collections?provider=telecel&amount={{data.amount}}&currency=GHS&partyType=msisdn',
    },
    moneyMoving: false,
    realSideEffects: false,
    sandboxSupport: 'documented',
    permissions: ['collections.read'],
    expectedStatuses: [200],
    dataFields: ['amount'],
    recommended: READ_ONLY,
    notes: ['A quote holds nothing; the real request prices again when it runs.'],
    exampleDataSets: [
      {
        name: 'quote-amounts',
        description: 'A spread of amounts.',
        environment: 'sandbox',
        needsEdit: false,
        records: [
          { ...tag('QUOTE-001'), amount: '1.00' },
          { ...tag('QUOTE-002'), amount: '50.00' },
          { ...tag('QUOTE-003'), amount: '500.00' },
        ],
      },
    ],
    body: none,
    fanout: one,
  },
  ...(
    [
      ['wallet-balance', 'Wallet balance', '/v1/wallet', 'account'],
      ['limits', 'Limits and headroom', '/v1/limits', 'account'],
      ['payment-methods', 'Payment methods', '/v1/payment-methods', 'reference'],
      ['transactions-list', 'Transactions list', '/v1/transactions?limit=50', 'account'],
    ] as const
  ).map(([id, title, path, channel]): ScenarioPack => ({
    id,
    title,
    channel,
    description: `GET ${path.split('?')[0]} — read-only.`,
    endpoint: { method: 'GET', path },
    moneyMoving: false,
    realSideEffects: false,
    sandboxSupport: 'documented',
    permissions: id === 'payment-methods' ? ['collections.read'] : ['transactions.read'],
    expectedStatuses: [200],
    dataFields: [],
    recommended: READ_ONLY,
    notes: ['No data set needed.'],
    exampleDataSets: [],
    body: none,
    fanout: one,
  })),
];

interface ReadPackDef {
  id: string;
  title: string;
  channel: string;
  path: string;
  permissions: string[];
  dataFields?: string[];
  example?: {
    name: string;
    description: string;
    records: Record<string, unknown>[];
    needsEdit: boolean;
  };
  expectedStatuses?: number[];
  notes?: string[];
  caution?: string;
  recommended?: ScenarioPack['recommended'];
}

const readPack = (d: ReadPackDef): ScenarioPack => ({
  id: d.id,
  title: d.title,
  channel: d.channel,
  description: `GET ${d.path.split('?')[0]} — read-only.`,
  endpoint: { method: 'GET', path: d.path },
  moneyMoving: false,
  realSideEffects: false,
  sandboxSupport: 'documented',
  permissions: d.permissions,
  expectedStatuses: d.expectedStatuses ?? [200],
  dataFields: d.dataFields ?? [],
  recommended: d.recommended ?? READ_ONLY,
  notes: d.notes ?? ['Read-only.'],
  caution: d.caution,
  exampleDataSets: d.example ? [{ ...d.example, environment: 'sandbox' }] : [],
  body: none,
  fanout: one,
});

const refExample = (
  name: string,
  field: string,
  caseId: string,
): NonNullable<ReadPackDef['example']> => ({
  name,
  description: `Replace with real ${field}s created by an earlier run.`,
  needsEdit: true,
  records: [{ ...tag(caseId), [field]: `REPLACE_WITH_EXISTING_${field.toUpperCase()}` }],
});

/** Read-only endpoints the docs describe — status polls, lists, quotes and lookups. */
const READ_PACKS: ScenarioPack[] = [
  readPack({
    id: 'payout-status-poll',
    title: 'Payout status lookup',
    channel: 'mobile_money',
    path: '/v1/payouts/{{data.reference}}',
    permissions: ['disbursements.read'],
    dataFields: ['reference'],
    example: refExample('payout-references', 'reference', 'POLL-PAY'),
    notes: ['Feed it references created by an earlier payouts run.'],
  }),
  readPack({
    id: 'utility-purchase-status-poll',
    title: 'Utility purchase status lookup',
    channel: 'utility',
    path: '/v1/utility-purchases/{{data.reference}}',
    permissions: ['disbursements.read'],
    dataFields: ['reference'],
    example: refExample('utility-references', 'reference', 'POLL-UTIL'),
  }),
  readPack({
    id: 'transfer-status-poll',
    title: 'Wallet transfer status lookup',
    channel: 'wallet',
    path: '/v1/transfers/{{data.reference}}',
    permissions: ['wallettransfer.read'],
    dataFields: ['reference'],
    example: refExample('transfer-references', 'reference', 'POLL-XFER'),
  }),
  readPack({
    id: 'checkout-status-poll',
    title: 'Hosted checkout lookup',
    channel: 'checkout',
    path: '/v1/checkouts/{{data.id}}',
    permissions: ['collections.read'],
    dataFields: ['id'],
    example: refExample('checkout-ids', 'id', 'POLL-CHK'),
  }),
  readPack({
    id: 'checkouts-list',
    title: 'Hosted checkouts list',
    channel: 'checkout',
    path: '/v1/checkouts?limit=20',
    permissions: ['collections.read'],
  }),
  readPack({
    id: 'fee-quote-payouts',
    title: 'Payout fee quote',
    channel: 'pricing',
    path: '/v1/fee-quotes/payouts?provider=telecel&amount={{data.amount}}&currency=GHS&partyType=msisdn',
    permissions: ['disbursements.write'],
    dataFields: ['amount'],
    example: {
      name: 'payout-quote-amounts',
      description: 'A spread of amounts.',
      needsEdit: false,
      records: [
        { ...tag('PQ-1'), amount: '1.00' },
        { ...tag('PQ-2'), amount: '100.00' },
      ],
    },
    notes: ['A quote holds nothing; needs disbursements.write even though it only reads.'],
  }),
  readPack({
    id: 'fee-quote-utilities',
    title: 'Utility fee quote',
    channel: 'pricing',
    path: '/v1/fee-quotes/utilities?productId={{data.productId}}&amount={{data.amount}}&currency=GHS',
    permissions: ['disbursements.write'],
    dataFields: ['productId', 'amount'],
    example: {
      name: 'utility-quote',
      description: 'Replace productId with one from GET /v1/utility-products.',
      needsEdit: true,
      records: [{ ...tag('UQ-1'), productId: 'REPLACE_WITH_PRODUCT_ID', amount: '5.00' }],
    },
    notes: ['A quote buys nothing and sends no airtime.'],
  }),
  readPack({
    id: 'utility-products',
    title: 'Utility products list',
    channel: 'utility',
    path: '/v1/utility-products',
    permissions: ['disbursements.read'],
  }),
  readPack({
    id: 'settlements-list',
    title: 'Settlement runs list',
    channel: 'settlement',
    path: '/v1/settlements?limit=20',
    permissions: ['settlements.read'],
  }),
  readPack({
    id: 'settlement-latest',
    title: 'Latest settlement run',
    channel: 'settlement',
    path: '/v1/settlements/latest',
    permissions: ['settlements.read'],
    expectedStatuses: [200, 404],
    notes: ['404 is accepted: a business with no settlements yet has no latest run.'],
  }),
  readPack({
    id: 'events-list',
    title: 'Events catch-up',
    channel: 'events',
    path: '/v1/events?limit=50',
    permissions: [
      'collections.read',
      'disbursements.read',
      'settlements.read',
      'wallettransfer.read',
    ],
    notes: ['You only see event types your key holds permissions for; events are kept 90 days.'],
  }),
  readPack({
    id: 'recipient-lookup',
    title: 'Recipient handle lookup',
    channel: 'wallet',
    path: '/v1/recipients/{{data.handle}}',
    permissions: ['wallettransfer.write'],
    dataFields: ['handle'],
    example: refExample('recipient-handles', 'handle', 'RCP-1'),
  }),
  readPack({
    id: 'party-lookup',
    title: 'Mobile-money name lookup',
    channel: 'reference',
    path: '/v1/party-lookups?provider=telecel&partyValue={{data.partyMsisdn}}',
    permissions: ['collections.read'],
    dataFields: ['partyMsisdn'],
    example: {
      name: 'party-fixture',
      description: 'Documented Telecel fixture number.',
      needsEdit: false,
      records: [{ ...tag('PL-1'), partyMsisdn: '233000000001' }],
    },
    caution:
      'Each lookup is forwarded to the mobile-money provider (provider_error / provider_timeout exist). Keep it low-rate and confirm provider tolerance with iSmart.',
    recommended: { profile: 'SMOKE', targetRps: 1, durationSeconds: 30, maxVus: 3 },
    notes: ['Only mobile-money numbers can be looked up; mtn and telecel only.'],
  }),
];

export const PACKS: ScenarioPack[] = [...CORE_PACKS, ...READ_PACKS];

export const packById = (id: string): ScenarioPack | undefined => PACKS.find((p) => p.id === id);

/** Builds a validated plan config from a pack and the caller's overrides. */
export function planFromPack(pack: ScenarioPack, params: PackParams): PlanConfig {
  const rec = pack.recommended;
  const body = pack.body(params);
  return PlanConfigSchema.parse({
    profile: params.profile ?? rec.profile,
    method: pack.endpoint.method,
    path: pack.endpoint.path,
    ...(body === undefined ? {} : { body }),
    idempotencyHeader: pack.endpoint.method === 'GET' ? null : 'Idempotency-Key',
    targetRps: params.targetRps ?? rec.targetRps,
    durationSeconds: params.durationSeconds ?? rec.durationSeconds,
    maxVus: params.maxVus ?? rec.maxVus,
    expectedStatuses: pack.expectedStatuses,
    moneyMoving: pack.moneyMoving,
    realSideEffects: pack.realSideEffects,
    fanout: pack.fanout(params),
    packId: pack.id,
    ...(params.dataSetId ? { dataSetId: params.dataSetId } : {}),
  });
}

/** Pack summary without example records, for list views. */
export function packSummary(p: ScenarioPack): Omit<
  ScenarioPack,
  'body' | 'fanout' | 'exampleDataSets'
> & {
  exampleDataSets: { name: string; description: string; needsEdit: boolean }[];
} {
  const { body: _b, fanout: _f, exampleDataSets, ...rest } = p;
  return {
    ...rest,
    exampleDataSets: exampleDataSets.map(({ name, description, needsEdit }) => ({
      name,
      description,
      needsEdit,
    })),
  };
}
