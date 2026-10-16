import { verifyWebhook, WEBHOOK_TOLERANCE_SECONDS } from '../contract/ismartpay.js';
import type { ApiClient, ApiResponse } from './client.js';
import type { WebhookReceiver } from './receiver.js';

/**
 * Correctness checks (Phase 25). Each one asserts a MONEY-SAFETY property that
 * load can break: idempotent retries apply once, a duplicate reference never
 * pays twice, a failed payout returns the funds, a webhook is authentic and
 * safe to receive twice, and the ledger reconciles. They are deliberately
 * deterministic and low-volume — they find *wrong* behaviour, not slow behaviour.
 *
 * `requires: ['simulator']` checks need the simulator's control plane (to inject
 * faults and read the ledger); everything else runs against the live sandbox too
 * and uses only the documented Telecel fixtures.
 */

export interface Assertion {
  name: string;
  pass: boolean;
  detail?: string;
  /** A failed advisory assertion is a WARNING: reported, but it does not fail the check. */
  advisory?: boolean;
}

/** Returned by a check that cannot run here (e.g. needs a second credential). Reported as SKIPPED. */
export interface SkipResult {
  skip: string;
}

export interface SimControl {
  config(patch: Record<string, unknown>): Promise<void>;
  reset(patch: Record<string, unknown>): Promise<void>;
  /** Sets a wallet's available balance through a ledger entry (reconciliation stays exact). */
  setBalance(walletId: string, amount: string): Promise<void>;
  state(): Promise<SimState>;
}

export interface SimState {
  wallets: { id: string; balance: string; reserved: string; driftPesewas: number }[];
  duplicateEffects: number;
  ledgerDriftPesewas: number;
  negativeBalances: string[];
  counters: Record<string, number>;
}

/** A webhook delivery as recorded by the live receiver. */
export interface ProbeDelivery {
  eventId: string;
  envelopeId: string | null;
  eventType: string | null;
  eventStatus: string | null;
  attempt: number;
  signatureOk: boolean;
  reason: string | null;
  respondedWith: number;
}

/** Lets a live run look at what iSmart actually delivered to our public receiver. */
export interface LiveWebhookProbe {
  label: string;
  deliveriesFor(reference: string): Promise<ProbeDelivery[]>;
}

export interface CheckContext {
  /** Present on live runs when a receiver able to verify signatures exists for the target. */
  liveWebhook: LiveWebhookProbe | null;
  /** How long the live webhook check waits for a delivery. */
  webhookWaitMs: number;
  api: ApiClient;
  /** The API credential id (also the simulator wallet id). */
  clientId: string;
  clientSecret: string;
  /** A credential belonging to a DIFFERENT account (simulator: derived; live: only if configured). */
  second: ApiClient | null;
  /** A fresh client for another credential id — simulator only (it accepts any id). */
  clientFor(id: string): ApiClient | null;
  sim: SimControl | null;
  /** HTTP URL the simulator should deliver webhooks to is created per check via `receiver()`. */
  receiver(
    secret?: string,
    failWith?: (id: string, attempt: number) => number | null,
  ): Promise<{ rx: WebhookReceiver; url: string }>;
  webhookSecret: string;
  ref(): string;
  idem(): string;
  payout(ref: string, over?: Record<string, unknown>): Record<string, unknown>;
  collection(ref: string, over?: Record<string, unknown>): Record<string, unknown>;
  refsOf(kind: 'payout' | 'collection'): Promise<Set<string>>;
  countByRef(kind: 'payout' | 'collection', ref: string): Promise<number>;
  wallet(): Promise<{ available: number; reserved: number }>;
  waitFor<T>(
    fn: () => Promise<T | null | false | undefined>,
    timeoutMs?: number,
  ): Promise<T | null>;
  /** How long to wait for a payment to reach a final status. */
  settleTimeoutMs: number;
}

export interface Check {
  id: string;
  title: string;
  /** Generic control tags, mapped to frameworks in Phase 28. */
  controls: string[];
  requires: 'simulator'[];
  /** Only meaningful against a real environment; it is not part of simulator runs at all. */
  liveOnly?: true;
  /** OWASP API Security Top 10 (2023) category, for security checks. */
  owasp?: string;
  run(c: CheckContext): Promise<Assertion[] | SkipResult>;
}

export const ok = (name: string, pass: boolean, detail?: string): Assertion => ({
  name,
  pass,
  ...(detail ? { detail } : {}),
});
export const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const word = (v: unknown, fallback = 'timeout'): string =>
  typeof v === 'string' ? v : fallback;
export const errCode = (r: ApiResponse): string | undefined =>
  str(rec(rec(r.body)['error'])['code']);

export const toPesewas = (v: unknown): number | null => {
  if (typeof v !== 'string' || !/^\d+\.\d{2}$/.test(v)) return null;
  const [a, b] = v.split('.') as [string, string];
  return Number(a) * 100 + Number(b);
};

const FIXTURE = {
  ok: '233000000001',
  payoutFails: '233000000003',
  collectionWrongPin: '233000000004',
} as const;

const PAYOUT_FINAL = new Set(['delivered', 'refunded']);
const COLLECTION_FINAL = new Set(['settled', 'failed', 'expired']);
/** Higher = later in the lifecycle; unknown statuses rank as "in progress". */
const RANK: Record<string, number> = {
  accepted: 1,
  dispatched: 2,
  dispatching: 2,
  in_review: 3,
  held: 3,
  settled: 9,
  failed: 9,
  expired: 9,
  delivered: 9,
  refunded: 10,
};

async function pollStatus(
  c: CheckContext,
  path: string,
  final: Set<string>,
): Promise<Record<string, unknown> | null> {
  return c.waitFor(async () => {
    const r = await c.api.call('GET', path);
    const body = rec(r.body);
    return r.status === 200 && typeof body['status'] === 'string' && final.has(body['status'])
      ? body
      : null;
  }, c.settleTimeoutMs);
}

export const CHECKS: Check[] = [
  {
    id: 'idem.sequential-replay',
    title: 'Same Idempotency-Key + same body is applied once and replayed',
    controls: ['idempotency', 'ledger-integrity'],
    requires: [],
    async run(c) {
      const ref = c.ref();
      const key = c.idem();
      const body = c.payout(ref);
      const a = await c.api.call('POST', '/v1/payouts', { body, key });
      const b = await c.api.call('POST', '/v1/payouts', { body, key });
      return [
        ok('first request is accepted', a.status === 202, `HTTP ${a.status}`),
        ok('the retry returns the same status', b.status === a.status, `HTTP ${b.status}`),
        ok(
          'the retry returns the SAME payment (reference and createdAt)',
          rec(a.body)['reference'] === rec(b.body)['reference'] &&
            rec(a.body)['createdAt'] === rec(b.body)['createdAt'],
        ),
        ok(
          'exactly one payment exists for the reference',
          (await c.countByRef('payout', ref)) === 1,
        ),
      ];
    },
  },
  {
    id: 'idem.concurrent-twins',
    title: 'Ten simultaneous identical requests apply exactly once',
    controls: ['idempotency', 'ledger-integrity'],
    requires: [],
    async run(c) {
      const ref = c.ref();
      const key = c.idem();
      const body = c.payout(ref);
      const rs = await Promise.all(
        Array.from({ length: 10 }, () => c.api.call('POST', '/v1/payouts', { body, key })),
      );
      const bad = rs.filter(
        (r) => r.status !== 202 && !(r.status === 409 && errCode(r) === 'request_in_flight'),
      );
      return [
        ok(
          'every response is 202 or 409 request_in_flight',
          bad.length === 0,
          bad.map((r) => `${r.status}/${errCode(r) ?? '-'}`).join(', '),
        ),
        ok(
          'at least one request was accepted',
          rs.some((r) => r.status === 202),
        ),
        ok('exactly one payment exists', (await c.countByRef('payout', ref)) === 1),
      ];
    },
  },
  {
    id: 'idem.key-reuse-different-body',
    title: 'Reusing a key with a different body is refused and changes nothing',
    controls: ['idempotency', 'input-validation'],
    requires: [],
    async run(c) {
      const ref = c.ref();
      const key = c.idem();
      const a = await c.api.call('POST', '/v1/payouts', {
        body: c.payout(ref, { amount: '1.00' }),
        key,
      });
      const b = await c.api.call('POST', '/v1/payouts', {
        body: c.payout(ref, { amount: '2.00' }),
        key,
      });
      const after = await c.api.call('GET', `/v1/payouts/${ref}`);
      return [
        ok('the original is accepted', a.status === 202),
        ok(
          'the changed body gets 409 idempotency_key_reused',
          b.status === 409 && errCode(b) === 'idempotency_key_reused',
          `HTTP ${b.status}/${errCode(b) ?? '-'}`,
        ),
        ok(
          'the stored payment still has the ORIGINAL amount',
          rec(after.body)['amount'] === '1.00',
          String(rec(after.body)['amount']),
        ),
        ok('still exactly one payment', (await c.countByRef('payout', ref)) === 1),
      ];
    },
  },
  {
    id: 'reference.duplicate-rules',
    title:
      'A reference is paid once: same body replays the original, a different body is duplicate_reference',
    controls: ['idempotency', 'ledger-integrity'],
    requires: [],
    async run(c) {
      const ref = c.ref();
      const first = await c.api.call('POST', '/v1/payouts', {
        body: c.payout(ref, { amount: '1.00' }),
        key: c.idem(),
      });
      const sameBody = await c.api.call('POST', '/v1/payouts', {
        body: c.payout(ref, { amount: '1.00' }),
        key: c.idem(),
      });
      const otherBody = await c.api.call('POST', '/v1/payouts', {
        body: c.payout(ref, { amount: '3.00' }),
        key: c.idem(),
      });
      return [
        ok('first request accepted', first.status === 202),
        ok(
          'same reference + new key + same body returns the original payment',
          sameBody.status < 300 &&
            rec(sameBody.body)['reference'] === ref &&
            rec(sameBody.body)['createdAt'] === rec(first.body)['createdAt'],
          `HTTP ${sameBody.status}`,
        ),
        ok(
          'same reference + different body is 409 duplicate_reference',
          otherBody.status === 409 && errCode(otherBody) === 'duplicate_reference',
          `HTTP ${otherBody.status}/${errCode(otherBody) ?? '-'}`,
        ),
        ok('exactly one payment exists', (await c.countByRef('payout', ref)) === 1),
      ];
    },
  },
  {
    id: 'validation.malformed-rejected',
    title: 'Malformed money requests are rejected and create nothing',
    controls: ['input-validation', 'ledger-integrity'],
    requires: [],
    async run(c) {
      const cases: [string, Record<string, unknown>][] = [
        ['amount without decimals', { amount: '12' }],
        ['amount with one decimal', { amount: '12.5' }],
        ['negative amount', { amount: '-1.00' }],
        ['zero amount', { amount: '0.00' }],
        ['amount as a JSON number', { amount: 12 }],
        ['amount in exponent form', { amount: '1e3' }],
        ['lowercase currency', { currency: 'ghs' }],
        ['reference starting with a hyphen', { reference: '-bad' }],
        ['unknown field', { surprise: true }],
      ];
      const out: Assertion[] = [];
      const refs: string[] = [];
      for (const [label, over] of cases) {
        const ref = c.ref();
        refs.push(ref);
        const r = await c.api.call('POST', '/v1/payouts', {
          body: { ...c.payout(ref), ...over, ...(over['reference'] ? {} : { reference: ref }) },
          key: c.idem(),
        });
        out.push(
          ok(
            `${label} → 400`,
            r.status === 400 || r.status === 422,
            `HTTP ${r.status}/${errCode(r) ?? '-'}`,
          ),
        );
      }
      const noKey = await c.api.call('POST', '/v1/payouts', { body: c.payout(c.ref()) });
      out.push(
        ok(
          'missing Idempotency-Key → 400 invalid_input',
          noKey.status === 400 && errCode(noKey) === 'invalid_input',
          `HTTP ${noKey.status}/${errCode(noKey) ?? '-'}`,
        ),
      );
      const longKey = await c.api.call('POST', '/v1/payouts', {
        body: c.payout(c.ref()),
        key: 'k'.repeat(256),
      });
      out.push(
        ok('256-character Idempotency-Key → 400', longKey.status === 400, `HTTP ${longKey.status}`),
      );
      const known = await c.refsOf('payout');
      out.push(
        ok(
          'none of the rejected requests created a payment',
          refs.every((r) => !known.has(r)),
        ),
      );
      return out;
    },
  },
  {
    id: 'auth.invalid-token-rejected',
    title: 'Missing, garbage or tampered tokens are refused and create nothing',
    controls: ['authentication', 'access-control'],
    requires: [],
    async run(c) {
      const ref = c.ref();
      const noAuth = await c.api.call('GET', '/v1/wallet', { token: null });
      const garbage = await c.api.call('GET', '/v1/wallet', { token: 'not-a-real-token' });
      const real = await c.api.getToken();
      const tampered = await c.api.call('GET', '/v1/wallet', { token: `${real.slice(0, -4)}AAAA` });
      const write = await c.api.call('POST', '/v1/payouts', {
        body: c.payout(ref),
        key: c.idem(),
        token: 'not-a-real-token',
      });
      return [
        ok(
          'no Authorization header → 401 unauthenticated',
          noAuth.status === 401 && errCode(noAuth) === 'unauthenticated',
          `HTTP ${noAuth.status}/${errCode(noAuth) ?? '-'}`,
        ),
        ok('garbage token → 401', garbage.status === 401, `HTTP ${garbage.status}`),
        ok('tampered token → 401', tampered.status === 401, `HTTP ${tampered.status}`),
        ok(
          'a payout with a bad token → 401 and nothing is created',
          write.status === 401 && (await c.countByRef('payout', ref)) === 0,
        ),
      ];
    },
  },
  {
    id: 'payout.fixture-delivered',
    title:
      'A successful payout is delivered, the reserve is released and the wallet is debited once',
    controls: ['ledger-integrity', 'reconciliation'],
    requires: [],
    async run(c) {
      const before = await c.wallet();
      const ref = c.ref();
      const create = await c.api.call('POST', '/v1/payouts', {
        body: c.payout(ref, { destination: { type: 'msisdn', value: FIXTURE.ok } }),
        key: c.idem(),
      });
      const done = await pollStatus(c, `/v1/payouts/${ref}`, PAYOUT_FINAL);
      const settled = await c.waitFor(async () => {
        const w = await c.wallet();
        return w.reserved === before.reserved ? w : null;
      }, c.settleTimeoutMs);
      const payer = toPesewas(done?.['payerAmount']);
      return [
        ok('payout accepted', create.status === 202, `HTTP ${create.status}`),
        ok('reaches delivered', done?.['status'] === 'delivered', word(done?.['status'])),
        ok('completedAt is set once final', typeof done?.['completedAt'] === 'string'),
        ok('the reserve is released', settled !== null),
        ok(
          'wallet debited exactly payerAmount',
          settled !== null && payer !== null
            ? before.available - settled.available === payer
            : settled !== null && settled.available < before.available,
          `debited ${settled ? before.available - settled.available : '?'} vs payerAmount ${payer ?? 'n/a'}`,
        ),
      ];
    },
  },
  {
    id: 'payout.failure-refunds-wallet',
    title: 'A failed payout is refunded in full — no money is lost or kept',
    controls: ['ledger-integrity', 'reconciliation'],
    requires: [],
    async run(c) {
      const before = await c.wallet();
      const ref = c.ref();
      const create = await c.api.call('POST', '/v1/payouts', {
        body: c.payout(ref, { destination: { type: 'msisdn', value: FIXTURE.payoutFails } }),
        key: c.idem(),
      });
      const done = await pollStatus(c, `/v1/payouts/${ref}`, PAYOUT_FINAL);
      const after = await c.waitFor(async () => {
        const w = await c.wallet();
        return w.available === before.available && w.reserved === before.reserved ? w : null;
      }, c.settleTimeoutMs);
      return [
        ok('payout accepted', create.status === 202),
        ok(
          'ends refunded (failed → refunded)',
          done?.['status'] === 'refunded',
          word(done?.['status']),
        ),
        ok(
          'a failureReason explains the failure',
          typeof done?.['failureReason'] === 'string' && done['failureReason'].length > 0,
        ),
        ok(
          'the wallet is back to exactly where it started',
          after !== null,
          after ? 'restored' : 'balance did not return to the starting value',
        ),
      ];
    },
  },
  {
    id: 'collection.fixture-outcomes',
    title: 'Collections settle or fail as documented and credit the wallet correctly',
    controls: ['ledger-integrity', 'reconciliation'],
    requires: [],
    async run(c) {
      const before = await c.wallet();
      const goodRef = c.ref();
      const badRef = c.ref();
      await c.api.call('POST', '/v1/collections', {
        body: c.collection(goodRef, { payer: { type: 'msisdn', value: FIXTURE.ok } }),
        key: c.idem(),
      });
      await c.api.call('POST', '/v1/collections', {
        body: c.collection(badRef, {
          payer: { type: 'msisdn', value: FIXTURE.collectionWrongPin },
        }),
        key: c.idem(),
      });
      const good = await pollStatus(c, `/v1/collections/${goodRef}`, COLLECTION_FINAL);
      const bad = await pollStatus(c, `/v1/collections/${badRef}`, COLLECTION_FINAL);
      const recipient = toPesewas(good?.['recipientAmount']);
      const after = await c.waitFor(async () => {
        const w = await c.wallet();
        return w.available !== before.available ? w : null;
      }, c.settleTimeoutMs);
      return [
        ok('233000000001 settles', good?.['status'] === 'settled', word(good?.['status'])),
        ok('233000000004 fails (wrong PIN)', bad?.['status'] === 'failed', word(bad?.['status'])),
        ok(
          'the failed collection carries a failureReason',
          typeof bad?.['failureReason'] === 'string',
        ),
        ok(
          'the wallet is credited exactly recipientAmount, and only for the settled one',
          after !== null && recipient !== null
            ? after.available - before.available === recipient
            : after !== null,
          `credited ${after ? after.available - before.available : '?'} vs ${recipient ?? 'n/a'}`,
        ),
      ];
    },
  },
  {
    id: 'batch.items-and-retry',
    title: 'A payout batch pays each item once, even when retried',
    controls: ['idempotency', 'ledger-integrity'],
    requires: [],
    async run(c) {
      const batchRef = c.ref();
      const items = [c.ref(), c.ref(), c.ref()].map((r) => c.payout(r));
      const refs = items.map((i) => i['reference'] as string);
      const body = { reference: batchRef, items };
      const key = c.idem();
      const first = await c.api.call('POST', '/v1/payout-batches', { body, key });
      const retry = await c.api.call('POST', '/v1/payout-batches', { body, key });
      const viaNewKey = await c.api.call('POST', '/v1/payout-batches', { body, key: c.idem() });
      const counts = await Promise.all(refs.map((r) => c.countByRef('payout', r)));
      const dupRef = c.ref();
      const malformed = await c.api.call('POST', '/v1/payout-batches', {
        body: { reference: c.ref(), items: [c.payout(dupRef), c.payout(dupRef)] },
        key: c.idem(),
      });
      const rs = rec(first.body)['items'];
      return [
        ok(
          'the batch is received (200) with one result per item, in order',
          first.status === 200 &&
            Array.isArray(rs) &&
            rs.length === 3 &&
            refs.every((r, i) => rec((rs as unknown[])[i])['reference'] === r),
          `HTTP ${first.status}`,
        ),
        ok(
          'every item is accepted individually (202)',
          Array.isArray(rs) && (rs as unknown[]).every((x) => rec(x)['status'] === 202),
        ),
        ok('a same-key retry does not error', retry.status < 500, `HTTP ${retry.status}`),
        ok(
          'a new-key resend does not pay anything twice',
          viaNewKey.status < 500,
          `HTTP ${viaNewKey.status}`,
        ),
        ok(
          'each item was paid exactly once',
          counts.every((n) => n === 1),
          counts.join(','),
        ),
        ok(
          'a batch with duplicate item references is refused whole (400)',
          malformed.status === 400,
          `HTTP ${malformed.status}`,
        ),
        ok('and none of its items was created', (await c.countByRef('payout', dupRef)) === 0),
      ];
    },
  },
  {
    id: 'status.list-matches-detail',
    title: 'The transactions list and the detail endpoint agree',
    controls: ['reconciliation', 'data-integrity'],
    requires: [],
    async run(c) {
      const ref = c.ref();
      await c.api.call('POST', '/v1/payouts', {
        body: c.payout(ref, { destination: { type: 'msisdn', value: FIXTURE.ok } }),
        key: c.idem(),
      });
      const detail = await pollStatus(c, `/v1/payouts/${ref}`, PAYOUT_FINAL);
      let listed: Record<string, unknown> | null = null;
      let cursor: string | undefined;
      for (let page = 0; page < 5 && !listed; page++) {
        const r = await c.api.call(
          'GET',
          `/v1/transactions?kind=payout&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        const items = rec(r.body)['items'];
        listed =
          (Array.isArray(items)
            ? (items as unknown[]).map(rec).find((i) => i['reference'] === ref)
            : undefined) ?? null;
        cursor = str(rec(r.body)['nextCursor']);
        if (!cursor) break;
      }
      return [
        ok('the payout reaches a final status', detail !== null),
        ok('it appears in GET /v1/transactions', listed !== null),
        ok(
          'list and detail agree on status',
          listed !== null && detail !== null && listed['status'] === detail['status'],
          `${String(listed?.['status'])} vs ${String(detail?.['status'])}`,
        ),
        ok(
          'list and detail agree on amount',
          listed !== null && detail !== null && listed['amount'] === detail['amount'],
        ),
      ];
    },
  },
  {
    id: 'sim.ambiguous-timeout-retry',
    title: 'A request that ran but timed out (504) is NOT applied again when retried',
    controls: ['idempotency', 'ledger-integrity', 'resilience'],
    requires: ['simulator'],
    async run(c) {
      const sim = c.sim!;
      const ref = c.ref();
      const key = c.idem();
      const body = c.payout(ref);
      await sim.config({ ambiguousTimeoutRate: 1 });
      const lost = await c.api.call('POST', '/v1/payouts', { body, key });
      await sim.config({ ambiguousTimeoutRate: 0 });
      const retry = await c.api.call('POST', '/v1/payouts', { body, key });
      const state = await sim.state();
      return [
        ok(
          'the client sees a 504 even though the request ran',
          lost.status === 504,
          `HTTP ${lost.status}`,
        ),
        ok(
          'the same-key retry replays the real result',
          retry.status === 202 && rec(retry.body)['reference'] === ref,
          `HTTP ${retry.status}`,
        ),
        ok('exactly one payment exists', (await c.countByRef('payout', ref)) === 1),
        ok(
          'no duplicate effects in the ledger',
          state.duplicateEffects === 0,
          `duplicateEffects=${state.duplicateEffects}`,
        ),
      ];
    },
  },
  {
    id: 'sim.concurrent-overspend',
    title: 'Concurrent payouts can never spend more than the wallet holds',
    controls: ['ledger-integrity', 'race-conditions'],
    requires: ['simulator'],
    async run(c) {
      const sim = c.sim!;
      await sim.setBalance(c.clientId, '1000.00');
      const rs = await Promise.all(
        Array.from({ length: 10 }, () =>
          c.api.call('POST', '/v1/payouts', {
            body: c.payout(c.ref(), { amount: '400.00' }),
            key: c.idem(),
          }),
        ),
      );
      const accepted = rs.filter((r) => r.status === 202).length;
      const state = await sim.state();
      const w = await c.wallet();
      return [
        ok(
          'no more payouts are accepted than the balance allows (≤2 of 10)',
          accepted <= 2,
          `${accepted} accepted`,
        ),
        ok(
          'the wallet never goes negative',
          w.available >= 0 && state.negativeBalances.length === 0,
          `available ${w.available}`,
        ),
        ok(
          'wallet and ledger agree (no lost update)',
          state.ledgerDriftPesewas === 0,
          `drift ${state.ledgerDriftPesewas} pesewas`,
        ),
      ];
    },
  },
  {
    id: 'webhook.signature-duplicates-order',
    title: 'Webhooks are authentic, de-duplicable, and safe when delivered twice or out of order',
    controls: ['webhook-authenticity', 'idempotency', 'ordering'],
    requires: ['simulator'],
    async run(c) {
      const sim = c.sim!;
      const { rx, url } = await c.receiver(c.webhookSecret);
      try {
        await sim.config({
          webhooks: {
            url,
            secret: c.webhookSecret,
            duplicateRate: 1,
            outOfOrder: true,
            attempts: 3,
            baseDelayMs: 20,
          },
        });
        const ref = c.ref();
        await c.api.call('POST', '/v1/collections', {
          body: c.collection(ref, { payer: { type: 'msisdn', value: FIXTURE.ok } }),
          key: c.idem(),
        });
        const detail = await pollStatus(c, `/v1/collections/${ref}`, COLLECTION_FINAL);
        await c.waitFor(() => Promise.resolve(rx.deliveries.length >= 4 ? true : null), 5000);
        const all = rx.deliveries;
        const events = rx.uniqueEvents();
        // A correct receiver keeps the highest-ranked status, not the last one that arrived.
        const best = events
          .filter((e) => rec(e.data)['reference'] === ref)
          .map((e) => String(rec(e.data)['status']))
          .sort((a, b) => (RANK[b] ?? 0) - (RANK[a] ?? 0))[0];
        const sample = all[0];
        const tamperedRejected = sample
          ? !verifyWebhook({
              secret: c.webhookSecret,
              id: sample.id,
              timestamp: sample.timestamp,
              signature: sample.signature,
              rawBody: `${sample.rawBody} `,
            }).ok
          : false;
        const staleRejected = sample
          ? !verifyWebhook({
              secret: c.webhookSecret,
              id: sample.id,
              timestamp: sample.timestamp,
              signature: sample.signature,
              rawBody: sample.rawBody,
              nowSeconds: Number(sample.timestamp) + WEBHOOK_TOLERANCE_SECONDS + 1,
            }).ok
          : false;
        return [
          ok('events were delivered', all.length >= 2, `${all.length} deliveries`),
          ok(
            'every delivery has a valid signature over the RAW body',
            all.length > 0 && all.every((d) => d.verdict.ok),
            all
              .filter((d) => !d.verdict.ok)
              .map((d) => (d.verdict.ok ? '' : d.verdict.reason))
              .join(', '),
          ),
          ok(
            'envelope id equals the Webhook-Id header',
            all.every((d) => d.envelope?.id === d.id),
          ),
          ok(
            'duplicates collapse to distinct events by Webhook-Id',
            events.length > 0 && events.length < all.length,
            `${events.length} unique of ${all.length}`,
          ),
          ok(
            'the best-ranked status equals the API state, regardless of arrival order',
            detail !== null && best === detail['status'],
            `${String(best)} vs ${String(detail?.['status'])}`,
          ),
          ok('a tampered body fails verification', tamperedRejected),
          ok('a timestamp older than 5 minutes fails verification', staleRejected),
        ];
      } finally {
        await sim.config({ webhooks: { duplicateRate: 0, outOfOrder: false } });
        await rx.stop();
      }
    },
  },
  {
    id: 'webhook.live-delivery',
    title: 'The real sandbox delivers authentic, well-formed webhooks that agree with the API',
    controls: ['webhook-authenticity', 'ordering'],
    requires: [],
    liveOnly: true,
    async run(c) {
      if (!c.liveWebhook) {
        return {
          skip: 'no webhook receiver with a signing secret is set up for this target (create one on the Run page and register its address in the iSmart test console)',
        };
      }
      const probe = c.liveWebhook;
      const ref = c.ref();
      await c.api.call('POST', '/v1/collections', {
        body: c.collection(ref, { payer: { type: 'msisdn', value: FIXTURE.ok } }),
        key: c.idem(),
      });
      const detail = await pollStatus(c, `/v1/collections/${ref}`, COLLECTION_FINAL);
      // Give the sender time to retry: its schedule is "6 attempts over about a day", so the first attempt is what we can wait for.
      const arrived = await c.waitFor(async () => {
        const d = await probe.deliveriesFor(ref);
        return d.length > 0 ? d : null;
      }, c.webhookWaitMs);
      if (!arrived) {
        return {
          skip: `no webhook for ${ref} reached the receiver "${probe.label}" within ${Math.round(c.webhookWaitMs / 1000)} s — is its address registered in the iSmart test console and publicly reachable?`,
        };
      }
      await c.waitFor(() => Promise.resolve(null), 3000); // let a trailing event land
      const all = await probe.deliveriesFor(ref);
      const ids = new Set(all.map((d) => d.eventId));
      const best = all
        .map((d) => d.eventStatus ?? '')
        .filter(Boolean)
        .sort((a, b) => (RANK[b] ?? 0) - (RANK[a] ?? 0))[0];
      return [
        ok('a webhook arrived for the payment', all.length > 0, `${all.length} deliveries`),
        ok(
          'every delivery carries a valid signature over the RAW body',
          all.every((d) => d.signatureOk),
          all
            .filter((d) => !d.signatureOk)
            .map((d) => d.reason ?? 'invalid')
            .join(', '),
        ),
        ok(
          'envelope id equals the Webhook-Id header',
          all.every((d) => d.envelopeId === d.eventId),
        ),
        ok(
          'the event type belongs to collections',
          all.every((d) => (d.eventType ?? '').startsWith('collection')),
          [...new Set(all.map((d) => d.eventType))].join(', '),
        ),
        ok(
          'we acknowledged every authentic delivery with 200',
          all.filter((d) => d.signatureOk).every((d) => d.respondedWith === 200),
        ),
        ok(
          'the best-ranked webhook status equals the API state',
          detail !== null && (best === undefined || best === detail['status']),
          `${String(best)} vs ${String(detail?.['status'])}`,
        ),
        {
          name: 'repeat deliveries reuse one event id (de-duplicable)',
          pass: ids.size <= all.length,
          detail: `${ids.size} distinct of ${all.length}`,
          advisory: true,
        },
      ];
    },
  },
  {
    id: 'webhook.retry-keeps-id',
    title: 'Failed webhook deliveries are retried with the same id and a fresh timestamp',
    controls: ['webhook-authenticity', 'resilience'],
    requires: ['simulator'],
    async run(c) {
      const sim = c.sim!;
      const { rx, url } = await c.receiver(c.webhookSecret, (_id, attempt) =>
        attempt <= 2 ? 500 : null,
      );
      try {
        await sim.config({
          webhooks: {
            url,
            secret: c.webhookSecret,
            duplicateRate: 0,
            outOfOrder: false,
            attempts: 4,
            baseDelayMs: 30,
          },
        });
        const ref = c.ref();
        await c.api.call('POST', '/v1/collections', {
          body: c.collection(ref, { payer: { type: 'msisdn', value: FIXTURE.ok } }),
          key: c.idem(),
        });
        await c.waitFor(
          () =>
            Promise.resolve(
              rx.deliveries.some((d) => d.attempt >= 3 && d.respondedWith === 200) ? true : null,
            ),
          8000,
        );
        const firstId = rx.deliveries[0]?.id;
        const same = rx.deliveries.filter((d) => d.id === firstId);
        const state = await sim.state();
        return [
          ok(
            'the same event is retried until it succeeds (≥3 attempts)',
            same.length >= 3,
            `${same.length} attempts`,
          ),
          ok(
            'every retry keeps the same Webhook-Id',
            same.every((d) => d.id === firstId),
          ),
          ok(
            'every attempt is validly signed',
            same.every((d) => d.verdict.ok),
          ),
          ok('the final attempt is acknowledged with 2xx', same.at(-1)?.respondedWith === 200),
          ok(
            'the sender recorded the retries',
            (state.counters['webhooksRetried'] ?? 0) >= 2,
            `retried ${state.counters['webhooksRetried'] ?? 0}`,
          ),
        ];
      } finally {
        await sim.config({ webhooks: { duplicateRate: 0, outOfOrder: false } });
        await rx.stop();
      }
    },
  },
  {
    id: 'sim.ledger-reconciliation',
    title: 'At the end of the suite the ledger reconciles exactly',
    controls: ['reconciliation', 'ledger-integrity'],
    requires: ['simulator'],
    async run(c) {
      // Let in-flight settlements and refunds land before reconciling.
      await new Promise((r) => setTimeout(r, 300));
      const s = await c.sim!.state();
      return [
        ok(
          'no payment was applied more than once',
          s.duplicateEffects === 0,
          `duplicateEffects=${s.duplicateEffects}`,
        ),
        ok(
          'no wallet balance is negative',
          s.negativeBalances.length === 0,
          s.negativeBalances.join(','),
        ),
        ok(
          'every wallet equals opening balance + ledger entries',
          s.ledgerDriftPesewas === 0,
          `drift ${s.ledgerDriftPesewas} pesewas`,
        ),
      ];
    },
  },
];

export const CHECK_IDS = CHECKS.map((c) => c.id);
