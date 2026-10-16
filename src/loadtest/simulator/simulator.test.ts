import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createSimulatorApp } from './app.js';
import { parseAmount } from './simulator.js';
import {
  BatchResponseSchema,
  ErrorBodySchema,
  MoneyMovementSchema,
  TransferResponseSchema,
  WalletResponseSchema,
  verifyWebhook,
} from '../contract/ismartpay.js';

const { app, sim } = createSimulatorApp();
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function token(client = 'cli_test_1'): Promise<string> {
  const res = await request(app).post('/v1/oauth/token').type('form').send({
    grant_type: 'client_credentials',
    client_id: client,
    client_secret: 'sec',
    resource: 'ismartpay',
  });
  return (res.body as { access_token: string }).access_token;
}

const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
const send = (t: string, path: string, key: string | undefined, body: unknown) => {
  const r = request(app).post(path).set(bearer(t));
  return (key === undefined ? r : r.set('Idempotency-Key', key)).send(body as object);
};

const collection = (reference: string, over: Record<string, unknown> = {}) => ({
  reference,
  amount: '100.00',
  currency: 'GHS',
  provider: 'telecel',
  payer: { type: 'msisdn', value: '233000000001' },
  ...over,
});
const payout = (reference: string, over: Record<string, unknown> = {}) => ({
  reference,
  amount: '10.00',
  currency: 'GHS',
  provider: 'telecel',
  destination: { type: 'msisdn', value: '233000000001' },
  ...over,
});

interface State {
  wallets: { id: string; balance: string; reserved: string; driftPesewas: number }[];
  duplicateEffects: number;
  ledgerDriftPesewas: number;
  negativeBalances: string[];
  transactions: { total: number };
  counters: Record<string, number>;
}
const state = (): State => sim.state() as unknown as State;
const code = (res: { body: unknown }): string =>
  (res.body as { error: { code: string } }).error.code;

beforeEach(() => {
  sim.reset({ resolveDelayMs: 10, openingBalance: '1000.00' });
});

describe('auth (docs: authentication)', () => {
  it('issues a 5-minute bearer token from a form body only', async () => {
    const ok = await request(app).post('/v1/oauth/token').type('form').send({
      grant_type: 'client_credentials',
      client_id: 'a',
      client_secret: 'b',
      resource: 'ismartpay',
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ token_type: 'Bearer', expires_in: 300 });

    const json = await request(app).post('/v1/oauth/token').send({
      grant_type: 'client_credentials',
      client_id: 'a',
      client_secret: 'b',
      resource: 'ismartpay',
    });
    expect(json.status).toBe(400);
    expect(code(json)).toBe('invalid_input');

    const noResource = await request(app)
      .post('/v1/oauth/token')
      .type('form')
      .send({ grant_type: 'client_credentials', client_id: 'a', client_secret: 'b' });
    expect(noResource.status).toBe(400);
  });

  it('rejects live keys against the test API and unauthenticated calls', async () => {
    const live = await request(app).post('/v1/oauth/token').type('form').send({
      grant_type: 'client_credentials',
      client_id: 'live_x',
      client_secret: 'b',
      resource: 'ismartpay',
    });
    expect([live.status, code(live)]).toEqual([403, 'environment_mismatch']);
    const none = await request(app).get('/v1/wallet');
    expect([none.status, code(none)]).toEqual([401, 'unauthenticated']);
  });

  it('expires tokens, so a long run must refresh BEFORE expiry', async () => {
    sim.patchConfig({ tokenTtlSeconds: 1 });
    const t = await token();
    expect((await request(app).get('/v1/wallet').set(bearer(t))).status).toBe(200);
    await wait(1100);
    const res = await request(app).get('/v1/wallet').set(bearer(t));
    expect([res.status, code(res)]).toEqual([401, 'unauthenticated']);
    expect(state().counters['tokenExpiries']).toBe(1);
  });

  it('puts Request-Id on every response and always uses the documented error body', async () => {
    const t = await token();
    const ok = await request(app).get('/v1/wallet').set(bearer(t));
    const bad = await request(app).get('/v1/collections/nope').set(bearer(t));
    expect(ok.headers['request-id']).toMatch(/^req_/);
    expect(bad.headers['request-id']).toMatch(/^req_/);
    expect(ErrorBodySchema.safeParse(bad.body).success).toBe(true);
    expect([bad.status, code(bad)]).toEqual([404, 'not_found']);
  });
});

describe('collections (docs: reference/collections)', () => {
  it('returns 202 with the documented object and walks accepted → dispatched → settled', async () => {
    const t = await token();
    const res = await send(t, '/v1/collections', 'k1', collection('order-1'));
    expect(res.status).toBe(202);
    expect(MoneyMovementSchema.safeParse(res.body).success).toBe(true);
    expect(res.body).toMatchObject({
      reference: 'order-1',
      status: 'accepted',
      feeBearer: 'initiator',
      amount: '100.00',
    });
    expect(res.body.payerAmount).toBe('101.00'); // initiator pays amount + fee
    expect(res.body.recipientAmount).toBe('100.00');

    await wait(40);
    const done = await request(app).get('/v1/collections/order-1').set(bearer(t));
    expect(done.body).toMatchObject({ status: 'settled', settlementStatus: 'eligible' });
    expect(done.body.completedAt).toBeTruthy();
    expect(state().wallets[0]!.balance).toBe('1100.00');
    expect(state().ledgerDriftPesewas).toBe(0);
  });

  it('honours the documented Telecel fixtures (long and short form)', async () => {
    const t = await token();
    await send(
      t,
      '/v1/collections',
      'a',
      collection('c-ok', { payer: { type: 'msisdn', value: '000000000001' } }),
    );
    await send(
      t,
      '/v1/collections',
      'b',
      collection('c-pin', { payer: { type: 'msisdn', value: '233000000004' } }),
    );
    await wait(40);
    const ok = await request(app).get('/v1/collections/c-ok').set(bearer(t));
    const pin = await request(app).get('/v1/collections/c-pin').set(bearer(t));
    expect(ok.body.status).toBe('settled');
    expect(pin.body).toMatchObject({ status: 'failed', failureReason: 'wrong_pin' });
  });

  it('validates the request like the real API (400 invalid_input)', async () => {
    const t = await token();
    const cases: Record<string, unknown>[] = [
      collection('x', { amount: '12.5' }),
      collection('x', { amount: 12 }),
      collection('-bad'),
      collection('x', { currency: 'ghs' }),
      collection('x', { provider: 'visa' }),
      collection('x', { payer: { type: 'phone', value: '1' } }),
      collection('x', { unknownField: true }),
      { reference: 'x' },
    ];
    for (const [i, body] of cases.entries()) {
      const res = await send(t, '/v1/collections', `v${i}`, body);
      expect([res.status, code(res)], JSON.stringify(body)).toEqual([400, 'invalid_input']);
    }
  });

  it('requires an Idempotency-Key of 1–255 characters on every POST', async () => {
    const t = await token();
    expect(code(await send(t, '/v1/collections', undefined, collection('a')))).toBe(
      'invalid_input',
    );
    expect(code(await send(t, '/v1/collections', 'k'.repeat(256), collection('a')))).toBe(
      'invalid_input',
    );
    expect((await send(t, '/v1/collections', 'k'.repeat(255), collection('a'))).status).toBe(202);
  });
});

describe('idempotency and references (docs: idempotency-and-references)', () => {
  it('same key + same body replays; same key + different body is idempotency_key_reused', async () => {
    const t = await token();
    const a = await send(t, '/v1/payouts', 'k', payout('p1'));
    const b = await send(t, '/v1/payouts', 'k', payout('p1'));
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(b.body.reference).toBe('p1');
    const c = await send(t, '/v1/payouts', 'k', payout('p1', { amount: '11.00' }));
    expect([c.status, code(c)]).toEqual([409, 'idempotency_key_reused']);
    expect(state().transactions.total).toBe(1);
    expect(state().duplicateEffects).toBe(0);
  });

  it('same reference + new key + same body returns the ORIGINAL payment; different body is duplicate_reference', async () => {
    const t = await token();
    await send(t, '/v1/payouts', 'k1', payout('p2'));
    const same = await send(t, '/v1/payouts', 'k2', payout('p2'));
    expect([same.status, same.body.reference]).toEqual([202, 'p2']);
    const diff = await send(t, '/v1/payouts', 'k3', payout('p2', { amount: '99.00' }));
    expect([diff.status, code(diff)]).toEqual([409, 'duplicate_reference']);
    expect(state().transactions.total).toBe(1);
    expect(state().wallets[0]!.balance).toBe('989.90'); // debited once: 1000 − (10.00 + 0.10)
  });

  it('applies concurrent twins exactly once', async () => {
    const t = await token();
    const twins = await Promise.all(
      [1, 2, 3, 4].map(() => send(t, '/v1/payouts', 'same', payout('p3'))),
    );
    for (const r of twins) expect([202, 409]).toContain(r.status);
    expect(
      twins.filter((r) => r.status === 409).every((r) => code(r) === 'request_in_flight'),
    ).toBe(true);
    expect(state().transactions.total).toBe(1);
    expect(state().duplicateEffects).toBe(0);
  });

  it('broken mode double-applies — detectable via duplicateEffects', async () => {
    sim.patchConfig({ idempotency: 'broken' });
    const t = await token();
    await Promise.all([1, 2, 3].map(() => send(t, '/v1/payouts', 'dup', payout('p4'))));
    expect(state().duplicateEffects).toBe(2);
    expect(state().transactions.total).toBe(3);
  });
});

describe('payouts (docs: reference/payouts, payment-statuses)', () => {
  it('walks accepted → dispatching → delivered and releases the reserve', async () => {
    const t = await token();
    const res = await send(t, '/v1/payouts', 'k', payout('p1'));
    expect(res.body.status).toBe('accepted');
    expect(state().wallets[0]!.reserved).toBe('10.10');
    await wait(40);
    const done = await request(app).get('/v1/payouts/p1').set(bearer(t));
    expect(done.body.status).toBe('delivered');
    expect(state().wallets[0]).toMatchObject({ balance: '989.90', reserved: '0.00' });
  });

  it('fixture …003: payout fails, then the funds are refunded', async () => {
    const t = await token();
    await send(
      t,
      '/v1/payouts',
      'k',
      payout('p1', { destination: { type: 'msisdn', value: '233000000003' } }),
    );
    await wait(60);
    const done = await request(app).get('/v1/payouts/p1').set(bearer(t));
    expect(done.body.status).toBe('refunded');
    expect(done.body.failureReason).toBeTruthy();
    expect(state().wallets[0]).toMatchObject({ balance: '1000.00', reserved: '0.00' });
    expect(state().ledgerDriftPesewas).toBe(0);
  });

  it('stops large payouts in in_review, which must never be retried or cancelled', async () => {
    sim.patchConfig({ payoutReviewThreshold: '500.00' });
    const t = await token();
    await send(t, '/v1/payouts', 'k', payout('big', { amount: '500.00' }));
    await wait(40);
    expect((await request(app).get('/v1/payouts/big').set(bearer(t))).body.status).toBe(
      'in_review',
    );
  });

  it('enforces limits and wallet balance', async () => {
    const t = await token();
    sim.patchConfig({ limits: { perTransaction: '50.00', daily: '60.00' } });
    expect(code(await send(t, '/v1/payouts', 'a', payout('l1', { amount: '50.01' })))).toBe(
      'transaction_limit_exceeded',
    );
    expect((await send(t, '/v1/payouts', 'b', payout('l2', { amount: '50.00' }))).status).toBe(202);
    const day = await send(t, '/v1/payouts', 'c', payout('l3', { amount: '20.00' }));
    expect([day.status, code(day)]).toEqual([403, 'daily_limit_exceeded']);
    sim.patchConfig({ limits: { perTransaction: '5000.00', daily: '100000.00' } });
    const broke = await send(t, '/v1/payouts', 'd', payout('l4', { amount: '5000.00' }));
    expect(broke.status).toBe(422);
    expect(state().negativeBalances).toEqual([]);
  });
});

describe('payout batches (docs: payout-batches)', () => {
  const batch = (reference: string, items: unknown[]) => ({ reference, items });

  it('returns 200 with per-item results; a refused item does not stop the others', async () => {
    const t = await token();
    sim.patchConfig({ limits: { perTransaction: '50.00' } });
    const res = await send(
      t,
      '/v1/payout-batches',
      'b1',
      batch('batch-1', [payout('i1'), payout('i2', { amount: '60.00' }), payout('i3')]),
    );
    expect(res.status).toBe(200);
    expect(BatchResponseSchema.safeParse(res.body).success).toBe(true);
    const items = res.body.items as {
      reference: string;
      status: number;
      payout?: unknown;
      error?: { code: string };
    }[];
    expect(items.map((i) => i.reference)).toEqual(['i1', 'i2', 'i3']);
    expect(items.map((i) => i.status)).toEqual([202, 403, 202]);
    expect(items[1]!.error?.code).toBe('transaction_limit_exceeded');
  });

  it('refuses a malformed batch whole: >100 items, empty, duplicate item references', async () => {
    const t = await token();
    const many = Array.from({ length: 101 }, (_, i) => payout(`m${i}`));
    expect([(await send(t, '/v1/payout-batches', 'b', batch('x', many))).status]).toEqual([400]);
    expect((await send(t, '/v1/payout-batches', 'b2', batch('x', []))).status).toBe(400);
    expect(
      (await send(t, '/v1/payout-batches', 'b3', batch('x', [payout('d'), payout('d')]))).status,
    ).toBe(400);
    expect(state().transactions.total).toBe(0);
  });

  it('a retried batch sends nothing twice', async () => {
    const t = await token();
    const body = batch('batch-r', [payout('r1'), payout('r2')]);
    await send(t, '/v1/payout-batches', 'k1', body);
    await send(t, '/v1/payout-batches', 'k2', body); // new key, same batch reference + body
    expect(state().transactions.total).toBe(2);
    expect(state().duplicateEffects).toBe(0);
  });
});

describe('utility purchases (docs: utility-purchases)', () => {
  const purchase = (reference: string, over: Record<string, unknown> = {}) => ({
    reference,
    productId: 'airtime-mtn',
    amount: '5.00',
    currency: 'GHS',
    beneficiary: { msisdn: '233244123456' },
    funding: { type: 'wallet' },
    ...over,
  });

  it('delivers airtime from the wallet and counts the REAL side effect', async () => {
    const t = await token();
    const res = await send(t, '/v1/utility-purchases', 'k', purchase('u1'));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: 'accepted',
      gross: '5.10',
      product: { id: 'airtime-mtn' },
    });
    await wait(40);
    expect((await request(app).get('/v1/utility-purchases/u1').set(bearer(t))).body.status).toBe(
      'delivered',
    );
    expect(state().counters['utilityDeliveries']).toBe(1);
  });

  it('applies the documented rules for accountNumber, products and ranges', async () => {
    const t = await token();
    const tv = purchase('u2', { productId: 'tv-dstv', beneficiary: { msisdn: '233244123456' } });
    expect(code(await send(t, '/v1/utility-purchases', 'a', tv))).toBe('invalid_input'); // utility needs account
    const air = purchase('u3', { beneficiary: { msisdn: '233244123456', accountNumber: '0141' } });
    expect(code(await send(t, '/v1/utility-purchases', 'b', air))).toBe('invalid_input'); // airtime refuses it
    const unknown = await send(
      t,
      '/v1/utility-purchases',
      'c',
      purchase('u4', { productId: 'nope' }),
    );
    expect([unknown.status, code(unknown)]).toEqual([404, 'product_not_found']);
    const range = await send(t, '/v1/utility-purchases', 'd', purchase('u5', { amount: '999.00' }));
    expect([range.status, code(range)]).toEqual([422, 'amount_out_of_range']);
    const noPayer = purchase('u6', { funding: { type: 'collection' } });
    expect(code(await send(t, '/v1/utility-purchases', 'e', noPayer))).toBe('invalid_input');
    expect(
      (await request(app).get('/v1/utility-products').set(bearer(t))).body.items.length,
    ).toBeGreaterThan(0);
  });
});

describe('wallet transfers (docs: wallet-transfers)', () => {
  const transfer = (reference: string, over: Record<string, unknown> = {}) => ({
    reference,
    handle: 'demo-merchant',
    amount: '25.00',
    currency: 'GHS',
    ...over,
  });

  it('returns 200 completed, charges no fee, and conserves money', async () => {
    const t = await token();
    const res = await send(t, '/v1/transfers', 'k', transfer('t1'));
    expect(res.status).toBe(200);
    expect(TransferResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.status).toBe('completed');
    expect(state().wallets.find((w) => w.id === 'cli_test_1')!.balance).toBe('975.00');
    expect(state().wallets.find((w) => w.id === 'demo-merchant')!.balance).toBe('1025.00');
    expect(state().ledgerDriftPesewas).toBe(0);
  });

  it('refuses unknown handles, own handle and rvr- references', async () => {
    const t = await token('acme-store');
    expect(
      code(await send(t, '/v1/transfers', 'a', transfer('t2', { handle: 'acme-store' }))),
    ).toBe('own_handle');
    expect(
      (await send(t, '/v1/transfers', 'b', transfer('t3', { handle: 'ghost-co' }))).status,
    ).toBe(404);
    expect((await send(t, '/v1/transfers', 'c', transfer('rvr-1'))).status).toBe(400);
  });
});

describe('account endpoints and lists', () => {
  it('serves wallet, limits, payment-methods, fee quotes and paginated lists in documented shapes', async () => {
    const t = await token();
    const wallet = await request(app).get('/v1/wallet').set(bearer(t));
    expect(WalletResponseSchema.safeParse(wallet.body).success).toBe(true);
    expect(wallet.body.items[0].balances).toEqual({ GHS: '1000.00' });
    expect((await request(app).get('/v1/limits').set(bearer(t))).body.items[0]).toHaveProperty(
      'daily.out.remaining',
    );
    expect(
      (await request(app).get('/v1/payment-methods').set(bearer(t))).body.items[0],
    ).toHaveProperty('rail');
    const quote = await request(app)
      .get('/v1/fee-quotes/collections?provider=mtn&amount=100.00&currency=GHS&partyType=msisdn')
      .set(bearer(t));
    expect(quote.body).toMatchObject({
      fee: '1.00',
      payerAmount: '101.00',
      recipientAmount: '100.00',
    });
    expect(
      (await request(app).get('/v1/fee-quotes/collections?amount=1.00').set(bearer(t))).status,
    ).toBe(400);

    for (let i = 0; i < 5; i++) await send(t, '/v1/payouts', `k${i}`, payout(`pg${i}`));
    const p1 = await request(app).get('/v1/transactions?limit=2').set(bearer(t));
    expect(p1.body.items).toHaveLength(2);
    const p2 = await request(app)
      .get(`/v1/transactions?limit=2&cursor=${p1.body.nextCursor as string}`)
      .set(bearer(t));
    expect(p2.body.items[0].reference).toBe('pg2');
    const e1 = await request(app).get('/v1/events?limit=3').set(bearer(t));
    const e2 = await request(app)
      .get(`/v1/events?limit=3&after=${e1.body.nextAfter as string}`)
      .set(bearer(t));
    expect(e2.body.items[0].id).not.toBe(e1.body.items[0].id);
  });
});

describe('fault injection', () => {
  it('rate limits per credential with Retry-After', async () => {
    sim.patchConfig({ rateLimit: { enabled: true, rps: 3 } });
    const t = await token();
    let limited: { status: number; retry: string | undefined } | null = null;
    for (let i = 0; i < 10 && !limited; i++) {
      const r = await request(app).get('/v1/wallet').set(bearer(t));
      if (r.status === 429) limited = { status: 429, retry: r.headers['retry-after'] };
      if (r.status === 429) expect(code(r)).toBe('rate_limited');
    }
    expect(limited).not.toBeNull();
    expect(Number(limited!.retry)).toBeGreaterThanOrEqual(1);
  });

  it('injected 5xx hit before any state changes, so a same-key retry is safe', async () => {
    const t = await token();
    sim.patchConfig({ errorRate: 1 });
    const failed = await send(t, '/v1/payouts', 'r1', payout('p1'));
    expect([500, 502, 503]).toContain(failed.status);
    expect((failed.body as { error: { message: string } }).error.message).toBe(
      'internal server error',
    );
    expect(state().transactions.total).toBe(0);
    sim.patchConfig({ errorRate: 0 });
    expect((await send(t, '/v1/payouts', 'r1', payout('p1'))).status).toBe(202);
    expect(state().duplicateEffects).toBe(0);
  });

  it('ambiguous timeout: applied but answered 504 — the same-key retry replays the real result', async () => {
    const t = await token();
    sim.patchConfig({ ambiguousTimeoutRate: 1 });
    const lost = await send(t, '/v1/payouts', 'amb', payout('p1'));
    expect([lost.status, code(lost)]).toEqual([504, 'upstream_timeout']);
    expect(state().transactions.total).toBe(1); // it DID run
    sim.patchConfig({ ambiguousTimeoutRate: 0 });
    const retry = await send(t, '/v1/payouts', 'amb', payout('p1'));
    expect([retry.status, retry.body.reference]).toEqual([202, 'p1']);
    expect(state().transactions.total).toBe(1);
    expect(state().duplicateEffects).toBe(0);
    expect(state().wallets[0]!.balance).toBe('989.90'); // charged once
  });

  it('injects latency and is deterministic for a seed', async () => {
    const t = await token();
    sim.patchConfig({ latency: { baseMs: 40 } });
    const t0 = Date.now();
    await request(app).get('/v1/wallet').set(bearer(t));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);

    const run = async (): Promise<number[]> => {
      sim.reset({ seed: 7, errorRate: 0.5, resolveDelayMs: 1 });
      const tk = await token();
      const out: number[] = [];
      for (let i = 0; i < 12; i++)
        out.push((await request(app).get('/v1/wallet').set(bearer(tk))).status);
      return out;
    };
    expect(await run()).toEqual(await run());
  });
});

describe('correctness under concurrency', () => {
  const burst = async (n: number) => {
    const t = await token();
    return Promise.all(
      Array.from({ length: n }, (_, i) =>
        send(t, '/v1/payouts', `race-${i}`, payout(`race-${i}`, { amount: '400.00' })),
      ),
    );
  };

  it('correct mode never overspends or drifts from the ledger', async () => {
    const results = await burst(10);
    expect(results.filter((r) => r.status === 202).length).toBe(2); // 1000.00 / 404.00
    expect(state().negativeBalances).toEqual([]);
    expect(state().ledgerDriftPesewas).toBe(0);
  });

  it('raceBug mode overspends / drifts, and the reconciliation view shows it', async () => {
    sim.patchConfig({ raceBug: true, raceWindowMs: 10 });
    const results = await burst(10);
    expect(results.filter((r) => r.status === 202).length).toBeGreaterThan(2);
    expect(state().ledgerDriftPesewas).toBeGreaterThan(0);
  });
});

describe('weak (security-suite) modes', () => {
  it('hides other credentials’ payments; bola mode leaks them', async () => {
    const a = await token('cli_a');
    const b = await token('cli_b');
    await send(a, '/v1/payouts', 'o1', payout('secret-1'));
    expect((await request(app).get('/v1/payouts/secret-1').set(bearer(b))).status).toBe(404);
    sim.patchConfig({ weak: { bola: true } });
    expect((await request(app).get('/v1/payouts/secret-1').set(bearer(b))).status).toBe(200);
  });

  it('acceptAnyToken lets a bogus bearer through; verboseErrors leaks internals', async () => {
    expect((await request(app).get('/v1/wallet').set(bearer('nope'))).status).toBe(401);
    sim.patchConfig({ weak: { acceptAnyToken: true, verboseErrors: true }, errorRate: 1 });
    const leak = await request(app).get('/v1/wallet').set(bearer('nope'));
    expect((leak.body as { error: { message: string } }).error.message).toMatch(/ECONNRESET/);
  });
});

describe('webhooks (docs: webhooks)', () => {
  interface Hit {
    id: string;
    ts: string;
    sig: string;
    body: string;
  }
  async function receiver(
    status: (id: string) => number,
  ): Promise<{ server: Server; url: string; hits: Hit[] }> {
    const hits: Hit[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        hits.push({
          id: String(req.headers['webhook-id']),
          ts: String(req.headers['webhook-timestamp']),
          sig: String(req.headers['webhook-signature']),
          body,
        });
        res.writeHead(status(String(req.headers['webhook-id']))).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, hits };
  }

  it('signs id.timestamp.rawBody with the documented v1,base64 scheme, in the documented envelope', async () => {
    const rx = await receiver(() => 200);
    try {
      sim.patchConfig({ webhooks: { url: rx.url } });
      const t = await token();
      await send(t, '/v1/collections', 'w1', collection('hook-1'));
      await wait(150);
      expect(rx.hits.map((h) => (JSON.parse(h.body) as { type: string }).type)).toEqual(
        expect.arrayContaining(['collection.accepted', 'collection.status_changed']),
      );
      for (const h of rx.hits) {
        const env = JSON.parse(h.body) as {
          id: string;
          type: string;
          createdAt: string;
          data: { reference: string };
        };
        expect(env.id).toBe(h.id);
        expect(env.data.reference).toBe('hook-1');
        expect(h.sig.startsWith('v1,')).toBe(true);
        expect(
          verifyWebhook({
            secret: 'sim-webhook-secret',
            id: h.id,
            timestamp: h.ts,
            signature: h.sig,
            rawBody: h.body,
          }),
        ).toEqual({ ok: true });
        // Tampering with one byte of the RAW body must fail.
        expect(
          verifyWebhook({
            secret: 'sim-webhook-secret',
            id: h.id,
            timestamp: h.ts,
            signature: h.sig,
            rawBody: `${h.body} `,
          }).ok,
        ).toBe(false);
      }
    } finally {
      rx.server.close();
    }
  });

  it('verifier rejects stale timestamps (>5 min) and wrong secrets', () => {
    const base = {
      secret: 's3cret-value',
      id: 'evt_1',
      timestamp: '1000',
      rawBody: '{}',
      nowSeconds: 1000,
    };
    const sig = `v1,${Buffer.from('x').toString('base64')}`;
    expect(verifyWebhook({ ...base, signature: sig }).ok).toBe(false);
    expect(verifyWebhook({ ...base, signature: sig, nowSeconds: 1000 + 301 })).toEqual({
      ok: false,
      reason: 'timestamp outside tolerance',
    });
    expect(verifyWebhook({ ...base, id: undefined, signature: sig })).toEqual({
      ok: false,
      reason: 'missing headers',
    });
  });

  it('retries non-2xx with the SAME Webhook-Id and a fresh timestamp; delivery is at-least-once', async () => {
    const seen = new Map<string, number>();
    const rx = await receiver((id) => {
      const n = (seen.get(id) ?? 0) + 1;
      seen.set(id, n);
      return n <= 2 ? 500 : 200; // each event fails twice, then succeeds
    });
    try {
      sim.patchConfig({ webhooks: { url: rx.url, attempts: 4, baseDelayMs: 20 } });
      const t = await token();
      await send(t, '/v1/payouts', 'w2', payout('hook-2'));
      await wait(500);
      const first = rx.hits[0]!;
      const sameEvent = rx.hits.filter((h) => h.id === first.id);
      expect(sameEvent.length).toBe(3); // 2 failures + 1 success
      expect(state().counters['webhooksRetried']).toBeGreaterThanOrEqual(2);
      expect(state().counters['webhooksSent']).toBeGreaterThanOrEqual(1);
    } finally {
      rx.server.close();
    }
  });

  it('can duplicate deliveries to exercise receiver de-duplication', async () => {
    const rx = await receiver(() => 200);
    try {
      sim.patchConfig({ webhooks: { url: rx.url, duplicateRate: 1 } });
      const t = await token();
      await send(t, '/v1/collections', 'w3', collection('hook-3'));
      await wait(150);
      const ids = rx.hits.map((h) => h.id);
      expect(ids.length).toBe(new Set(ids).size * 2);
    } finally {
      rx.server.close();
    }
  });
});

describe('helpers', () => {
  it('parses strict decimal-string amounts only', () => {
    expect(parseAmount('120.00')).toBe(12000);
    for (const bad of ['120', '120.0', '-1.00', '0.00', 12, '1e3', '1,000.00'])
      expect(parseAmount(bad)).toBeNull();
  });
});
