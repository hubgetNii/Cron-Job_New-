import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  AMOUNT_RE,
  CollectionRequestSchema,
  ERROR_HTTP,
  IDEMPOTENCY_KEY_MAX,
  PROVIDERS,
  PayoutBatchRequestSchema,
  PayoutRequestSchema,
  SettleNowRequestSchema,
  TELECEL_FIXTURES,
  TokenFormSchema,
  TransferRequestSchema,
  UNDOCUMENTED,
  UtilityPurchaseRequestSchema,
  applyFee,
  normalizeFixtureNumber,
  signWebhook,
  type WebhookEnvelope,
} from '../contract/ismartpay.js';

/**
 * iSmartPay simulator core. A deterministic in-memory stand-in for the
 * documented developer API (see ../contract/ismartpay.ts for provenance), with
 * fault knobs and a ledger so the correctness suite has something to reconcile
 * against. Behaviour the docs do not specify is a simulator convention
 * (`UNDOCUMENTED` in the contract) — never a statement about iSmartPay.
 */

/* ── Config ─────────────────────────────────────────────────────────────── */

const money = z.string().regex(AMOUNT_RE);

export const SimConfigSchema = z.object({
  seed: z.number().int().default(42),
  openingBalance: money.default('100000.00'),
  /** Time from accepted → final status. Intermediate statuses land at half. */
  resolveDelayMs: z.number().int().min(0).default(50),
  tokenTtlSeconds: z.number().int().min(1).default(300),
  feeRate: z.number().min(0).max(0.5).default(0.01),
  feeBearer: z.enum(['initiator', 'non_initiator']).default('initiator'),
  /** Outcome for numbers that are NOT documented sandbox fixtures. */
  otherNumbers: z.enum(['succeed', 'fail']).default('succeed'),
  /** Payouts at/above this amount stop in `in_review` ("common on large payouts"). */
  payoutReviewThreshold: money.nullable().default(null),
  checkoutEnabled: z.boolean().default(true),
  limits: z
    .object({
      perTransaction: money.default('50000.00'),
      daily: money.default('1000000.00'),
    })
    .default({}),
  latency: z
    .object({
      baseMs: z.number().min(0).default(0),
      jitterMs: z.number().min(0).default(0),
      tailProbability: z.number().min(0).max(1).default(0),
      tailMs: z.number().min(0).default(0),
    })
    .default({}),
  /** Probability of an injected 5xx before the request touches any state. */
  errorRate: z.number().min(0).max(1).default(0),
  /** Probability the request hangs for `timeoutMs` then 504s, before touching state. */
  timeoutRate: z.number().min(0).max(1).default(0),
  /**
   * Probability a POST is APPLIED but the client receives a 504 — the
   * "outcome unknown" case the docs warn about. Retrying with the same key must
   * replay the real result, never apply it twice.
   */
  ambiguousTimeoutRate: z.number().min(0).max(1).default(0),
  timeoutMs: z.number().int().min(0).default(30_000),
  rateLimit: z
    .object({ enabled: z.boolean().default(true), rps: z.number().positive().default(1000) })
    .default({}),
  /** `correct` honours Idempotency-Key and reference rules; `broken` ignores both. */
  idempotency: z.enum(['correct', 'broken']).default('correct'),
  /** When true, debits read-then-write across an await → concurrent overspend. */
  raceBug: z.boolean().default(false),
  raceWindowMs: z.number().int().min(0).default(5),
  webhooks: z
    .object({
      url: z.string().url().optional(),
      secret: z.string().min(8).default('sim-webhook-secret'),
      duplicateRate: z.number().min(0).max(1).default(0),
      outOfOrder: z.boolean().default(false),
      /** Documented: 6 attempts over ~a day with growing gaps. Gaps are scaled for tests. */
      attempts: z.number().int().min(1).max(10).default(6),
      baseDelayMs: z.number().int().min(1).default(1000),
    })
    .default({}),
  /** Deliberately weak behaviours for the security suite (Phase 26). */
  weak: z
    .object({
      bola: z.boolean().default(false),
      acceptAnyToken: z.boolean().default(false),
      verboseErrors: z.boolean().default(false),
    })
    .default({}),
});
export type SimConfig = z.infer<typeof SimConfigSchema>;
export const SimConfigPatchSchema = SimConfigSchema.deepPartial();

/* ── Types & helpers ────────────────────────────────────────────────────── */

export class SimError extends Error {
  readonly status: number;
  constructor(
    readonly code: string,
    message: string,
    status?: number,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.status = status ?? ERROR_HTTP[code] ?? 500;
  }
  get body(): { error: { code: string; message: string } } {
    return { error: { code: this.code, message: this.message } };
  }
}

export interface Reply {
  status: number;
  body: unknown;
}

type Kind = 'collection' | 'payout' | 'utility_purchase' | 'transfer';

interface Tx {
  id: string;
  reference: string;
  kind: Kind;
  credential: string;
  amount: number;
  fee: number;
  feeBearer: 'initiator' | 'non_initiator';
  status: string;
  provider: string | null;
  party: string | null;
  note?: string;
  failureReason?: string;
  settlementStatus?: 'not_eligible' | 'eligible' | 'claimed' | 'settled';
  createdAt: string;
  completedAt?: string;
  bodyHash: string;
  extra?: Record<string, unknown>;
}

interface Wallet {
  id: string;
  balance: number;
  reserved: number;
  opening: number;
  createdAt: string;
}

interface LedgerEntry {
  seq: number;
  wallet: string;
  delta: number;
  ref: string;
  kind: string;
}

export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** "120.00" → 12000 pesewas, strictly. */
export function parseAmount(s: unknown): number | null {
  if (typeof s !== 'string' || !AMOUNT_RE.test(s) || s.length > 14) return null;
  const [a, b] = s.split('.') as [string, string];
  const n = Number(a) * 100 + Number(b);
  return n > 0 ? n : null;
}
export const fmt = (pesewas: number): string => (pesewas / 100).toFixed(2);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );
const hashOf = (v: unknown): string => createHash('sha256').update(canon(v)).digest('hex');

const PRODUCTS = [
  {
    id: 'airtime-mtn',
    category: 'airtime',
    network: 'mtn',
    name: 'MTN Airtime',
    kind: 'flexi',
    min: '1.00',
    max: '500.00',
    currency: 'GHS',
    delivery: 'verified',
  },
  {
    id: 'airtime-telecel',
    category: 'airtime',
    network: 'telecel',
    name: 'Telecel Airtime',
    kind: 'flexi',
    min: '1.00',
    max: '500.00',
    currency: 'GHS',
    delivery: 'unverified',
  },
  {
    id: 'tv-dstv',
    category: 'utility',
    network: 'dstv',
    name: 'DStv',
    kind: 'flexi',
    min: '1.00',
    max: '1000.00',
    currency: 'GHS',
    delivery: 'verified',
    account: { label: 'Smartcard number', hint: 'digits', pattern: '^[0-9]{1,32}$' },
  },
] as const;
const KNOWN_HANDLES = new Set(['demo-merchant', 'acme-store']);

/* ── Simulator ──────────────────────────────────────────────────────────── */

export class Simulator {
  config: SimConfig;
  private rand: () => number;
  private epoch = 0;
  private seq = 0;
  private wallets = new Map<string, Wallet>();
  private txs = new Map<string, Tx>(); // `${kind}:${cred}:${reference}`
  private ledger: LedgerEntry[] = [];
  private events: { cred: string; env: WebhookEnvelope }[] = [];
  private tokens = new Map<string, { cred: string; exp: number }>();
  private buckets = new Map<string, { tokens: number; at: number }>();
  private idem = new Map<string, { hash: string; reply?: Reply }>();
  private effects = new Map<string, number>(); // `${kind}:${cred}:${reference}` → effect count
  private checkouts = new Map<string, Record<string, unknown>>();
  private batches = new Map<string, { hash: string; reply: Reply }>();
  private settlementRuns: Record<string, unknown>[] = [];
  private policy: Record<string, unknown> | null = null;
  private dailyIn = new Map<string, number>();
  private dailyOut = new Map<string, number>();
  readonly counters = {
    requests: 0,
    rateLimited: 0,
    injectedErrors: 0,
    injectedTimeouts: 0,
    ambiguousTimeouts: 0,
    tokensIssued: 0,
    tokenExpiries: 0,
    webhooksSent: 0,
    webhooksFailed: 0,
    webhooksRetried: 0,
    utilityDeliveries: 0,
  };

  constructor(config: Partial<SimConfig> = {}) {
    this.config = SimConfigSchema.parse(config);
    this.rand = mulberry32(this.config.seed);
  }

  /** Resets ALL state and returns to defaults (+ the supplied patch). */
  reset(patch: unknown = {}): void {
    this.config = SimConfigSchema.parse(patch);
    this.rand = mulberry32(this.config.seed);
    this.epoch++;
    this.seq = 0;
    this.wallets.clear();
    this.txs.clear();
    this.tokens.clear();
    this.buckets.clear();
    this.idem.clear();
    this.effects.clear();
    this.checkouts.clear();
    this.batches.clear();
    this.dailyIn.clear();
    this.dailyOut.clear();
    this.ledger = [];
    this.events = [];
    this.settlementRuns = [];
    this.policy = null;
    for (const k of Object.keys(this.counters) as (keyof typeof this.counters)[])
      this.counters[k] = 0;
  }

  patchConfig(patch: unknown): SimConfig {
    const p = SimConfigPatchSchema.parse(patch) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...this.config };
    for (const [k, v] of Object.entries(p)) {
      const cur = merged[k];
      merged[k] =
        v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object'
          ? { ...cur, ...v }
          : v;
    }
    this.config = SimConfigSchema.parse(merged);
    return this.config;
  }

  /* ── faults ───────────────────────────────────────────────────────────── */

  async applyFaults(): Promise<void> {
    this.counters.requests++;
    const { latency, errorRate, timeoutRate, timeoutMs } = this.config;
    let wait = latency.baseMs + this.rand() * latency.jitterMs;
    if (latency.tailProbability > 0 && this.rand() < latency.tailProbability)
      wait += latency.tailMs;
    if (wait > 0) await sleep(wait);
    if (timeoutRate > 0 && this.rand() < timeoutRate) {
      this.counters.injectedTimeouts++;
      await sleep(timeoutMs);
      throw new SimError('upstream_timeout', 'internal server error');
    }
    if (errorRate > 0 && this.rand() < errorRate) {
      this.counters.injectedErrors++;
      const code = (['internal', 'provider_error', 'environment_unknown'] as const)[
        Math.floor(this.rand() * 3)
      ]!;
      const message = this.config.weak.verboseErrors
        ? 'ECONNRESET at ledger-db.internal:5432 (pool exhausted) at /srv/app/ledger.js:88'
        : 'internal server error'; // docs: a 5xx message is always generic
      throw new SimError(code, message);
    }
  }

  shouldAmbiguousTimeout(): boolean {
    const hit =
      this.config.ambiguousTimeoutRate > 0 && this.rand() < this.config.ambiguousTimeoutRate;
    if (hit) this.counters.ambiguousTimeouts++;
    return hit;
  }

  takeRateToken(key: string): void {
    const { enabled, rps } = this.config.rateLimit;
    if (!enabled) return;
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: rps, at: now };
    b.tokens = Math.min(rps, b.tokens + ((now - b.at) / 1000) * rps);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      this.counters.rateLimited++;
      throw new SimError('rate_limited', 'rate limit exceeded', undefined, {
        'Retry-After': String(Math.max(1, Math.ceil((1 - b.tokens) / rps))),
      });
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
  }

  /* ── auth ─────────────────────────────────────────────────────────────── */

  /** POST /v1/oauth/token — application/x-www-form-urlencoded only. */
  issueToken(form: unknown): { access_token: string; token_type: 'Bearer'; expires_in: number } {
    const parsed = TokenFormSchema.safeParse(form);
    if (!parsed.success) {
      throw new SimError(
        'invalid_input',
        'grant_type=client_credentials, client_id, client_secret and resource=ismartpay are required',
      );
    }
    const { client_id } = parsed.data;
    if (client_id.startsWith('live_'))
      throw new SimError('environment_mismatch', 'key belongs to the live environment');
    const token = `sim_${randomBytes(18).toString('hex')}`;
    const ttl = this.config.tokenTtlSeconds;
    this.tokens.set(token, { cred: client_id, exp: Date.now() + ttl * 1000 });
    this.counters.tokensIssued++;
    this.ensureWallet(client_id);
    return { access_token: token, token_type: 'Bearer', expires_in: ttl };
  }

  authenticate(header: string | undefined): string {
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new SimError('unauthenticated', 'token missing');
    const t = this.tokens.get(token);
    if (t) {
      if (Date.now() >= t.exp) {
        this.counters.tokenExpiries++;
        throw new SimError('unauthenticated', 'token expired');
      }
      return t.cred;
    }
    if (this.config.weak.acceptAnyToken) {
      this.ensureWallet('anonymous');
      return 'anonymous';
    }
    throw new SimError('unauthenticated', 'token invalid');
  }

  /* ── idempotency ──────────────────────────────────────────────────────── */

  /**
   * Same key + same body replays the original reply; a different body is
   * `idempotency_key_reused`; a concurrent twin is `request_in_flight`. 5xx
   * outcomes are never cached (nothing is known to have run).
   */
  async idempotent(
    cred: string,
    key: string | undefined,
    body: unknown,
    run: () => Promise<Reply>,
  ): Promise<Reply> {
    if (!key || key.length > IDEMPOTENCY_KEY_MAX) {
      throw new SimError('invalid_input', 'Idempotency-Key header is required (1–255 characters)');
    }
    if (this.config.idempotency === 'broken') return run();
    const k = `${cred}:${key}`;
    const hash = hashOf(body);
    const hit = this.idem.get(k);
    if (hit) {
      if (hit.hash !== hash)
        throw new SimError('idempotency_key_reused', 'key was used with a different body');
      if (!hit.reply)
        throw new SimError('request_in_flight', 'a request with this key is still running');
      return hit.reply;
    }
    this.idem.set(k, { hash });
    try {
      const reply = await run();
      this.idem.set(k, { hash, reply });
      return reply;
    } catch (e) {
      if (e instanceof SimError && e.status < 500) {
        this.idem.set(k, { hash, reply: { status: e.status, body: e.body } });
      } else {
        this.idem.delete(k);
      }
      throw e;
    }
  }

  /* ── wallets & ledger ─────────────────────────────────────────────────── */

  ensureWallet(id: string): Wallet {
    let w = this.wallets.get(id);
    if (!w) {
      const opening = parseAmount(this.config.openingBalance) ?? 0;
      w = { id, balance: opening, reserved: 0, opening, createdAt: new Date().toISOString() };
      this.wallets.set(id, w);
    }
    return w;
  }

  private post(wallet: string, delta: number, ref: string, kind: string): void {
    this.ledger.push({ seq: ++this.seq, wallet, delta, ref, kind });
  }

  private async debit(
    cred: string,
    amount: number,
    ref: string,
    kind: string,
    reserve: boolean,
  ): Promise<void> {
    const w = this.ensureWallet(cred);
    const insufficient = (): SimError =>
      new SimError(UNDOCUMENTED.insufficientFundsCode, 'insufficient wallet balance', 422);
    if (this.config.raceBug) {
      const seen = w.balance;
      await sleep(this.config.raceWindowMs);
      if (seen < amount) throw insufficient();
      w.balance = seen - amount; // stale write — loses concurrent debits
    } else {
      if (w.balance < amount) throw insufficient();
      w.balance -= amount;
    }
    if (reserve) w.reserved += amount;
    this.post(cred, -amount, ref, kind);
  }

  private credit(cred: string, amount: number, ref: string, kind: string): void {
    this.ensureWallet(cred).balance += amount;
    this.post(cred, amount, ref, kind);
  }

  private checkLimits(cred: string, amount: number, direction: 'in' | 'out'): void {
    const per = parseAmount(this.config.limits.perTransaction) ?? Infinity;
    const daily = parseAmount(this.config.limits.daily) ?? Infinity;
    if (amount > per)
      throw new SimError('transaction_limit_exceeded', 'amount is over the per-payment limit');
    const book = direction === 'in' ? this.dailyIn : this.dailyOut;
    if ((book.get(cred) ?? 0) + amount > daily)
      throw new SimError('daily_limit_exceeded', "today's limit reached");
  }

  private noteVolume(cred: string, amount: number, direction: 'in' | 'out'): void {
    const book = direction === 'in' ? this.dailyIn : this.dailyOut;
    book.set(cred, (book.get(cred) ?? 0) + amount);
  }

  /* ── shared plumbing ──────────────────────────────────────────────────── */

  private parse<T>(schema: z.ZodType<T>, body: unknown): T {
    const r = schema.safeParse(body);
    if (!r.success) {
      const i = r.error.issues[0];
      throw new SimError(
        'invalid_input',
        `${i?.path.join('.') || 'body'}: ${i?.message ?? 'invalid'}`,
      );
    }
    return r.data;
  }

  private provider(p: string): void {
    if (!(PROVIDERS as readonly string[]).includes(p)) {
      throw new SimError('invalid_input', `provider must be one of ${PROVIDERS.join(', ')}`);
    }
  }

  private fee(amount: number): number {
    return Math.max(10, Math.round(amount * this.config.feeRate));
  }

  private amountOf(s: string): number {
    const n = parseAmount(s);
    if (n === null)
      throw new SimError('invalid_input', 'amount must be a positive decimal string like "120.00"');
    return n;
  }

  /** Reference rules: same ref + same body → the original payment; different body → duplicate_reference. */
  private existing(kind: Kind, cred: string, reference: string, hash: string): Tx | null {
    if (this.config.idempotency === 'broken') return null;
    const tx = this.txs.get(`${kind}:${cred}:${reference}`);
    if (!tx) return null;
    if (tx.bodyHash !== hash)
      throw new SimError('duplicate_reference', 'reference already belongs to a different payment');
    return tx;
  }

  private register(tx: Tx): void {
    const base = `${tx.kind}:${tx.credential}:${tx.reference}`;
    this.txs.set(this.config.idempotency === 'broken' ? `${base}#${++this.seq}` : base, tx);
    this.effects.set(base, (this.effects.get(base) ?? 0) + 1);
  }

  private newTx(
    kind: Kind,
    cred: string,
    reference: string,
    amount: number,
    fee: number,
    provider: string | null,
    party: string,
    bodyHash: string,
    note?: string,
  ): Tx {
    return {
      id: `tx_${String(++this.seq).padStart(8, '0')}`,
      reference,
      kind,
      credential: cred,
      amount,
      fee,
      feeBearer: this.config.feeBearer,
      status: kind === 'transfer' ? 'pending' : 'accepted',
      provider,
      party,
      ...(note ? { note } : {}),
      createdAt: new Date().toISOString(),
      bodyHash,
    };
  }

  view(tx: Tx): Record<string, unknown> {
    const pe = applyFee(tx.amount, tx.fee, tx.feeBearer);
    return {
      reference: tx.reference,
      amount: fmt(tx.amount),
      currency: 'GHS',
      status: tx.status,
      ...(tx.provider ? { provider: tx.provider } : {}),
      fee: fmt(tx.fee),
      feeBearer: tx.feeBearer,
      payerAmount: fmt(pe.payerAmount),
      recipientAmount: fmt(pe.recipientAmount),
      ...(tx.note ? { note: tx.note } : {}),
      ...(tx.failureReason ? { failureReason: tx.failureReason } : {}),
      createdAt: tx.createdAt,
      ...(tx.completedAt ? { completedAt: tx.completedAt } : {}),
      channel: 'api',
      ...(tx.settlementStatus ? { settlementStatus: tx.settlementStatus } : {}),
      reconciliation: { status: 'unchecked' },
    };
  }

  private utilityView(tx: Tx): Record<string, unknown> {
    const p = PRODUCTS.find((x) => x.id === tx.extra?.['productId'])!;
    return {
      reference: tx.reference,
      status: tx.status,
      product: { id: p.id, category: p.category, network: p.network, name: p.name },
      beneficiary: tx.extra?.['beneficiary'],
      amount: fmt(tx.amount),
      currency: 'GHS',
      fee: fmt(tx.fee),
      gross: fmt(tx.amount + tx.fee),
      funding: tx.extra?.['funding'],
      ...(tx.failureReason ? { failureReason: tx.failureReason } : {}),
      createdAt: tx.createdAt,
    };
  }

  private transferView(tx: Tx): Record<string, unknown> {
    return {
      reference: tx.reference,
      amount: fmt(tx.amount),
      currency: 'GHS',
      status: tx.status,
      recipientHandle: tx.party,
      createdAt: tx.createdAt,
    };
  }

  viewFor(tx: Tx): Record<string, unknown> {
    return tx.kind === 'utility_purchase'
      ? this.utilityView(tx)
      : tx.kind === 'transfer'
        ? this.transferView(tx)
        : this.view(tx);
  }

  /* ── status machines & events ─────────────────────────────────────────── */

  private later(ms: number, step: () => void): void {
    const epoch = this.epoch;
    setTimeout(() => {
      if (epoch === this.epoch) step();
    }, ms).unref();
  }

  private setStatus(
    tx: Tx,
    status: string,
    type: string,
    finalAt = false,
    failureReason?: string,
  ): void {
    tx.status = status;
    if (failureReason) tx.failureReason = failureReason;
    if (finalAt) tx.completedAt = new Date().toISOString();
    this.emit(tx.credential, type, this.viewFor(tx));
  }

  private fixtureOutcome(
    kind: 'collection' | 'payout',
    provider: string,
    value: string,
  ): 'ok' | 'fail' | 'fail_refund' | 'wrong_pin' {
    if (provider === 'telecel') {
      const fx = (
        TELECEL_FIXTURES as Record<string, { collection: string | null; payout: string | null }>
      )[normalizeFixtureNumber(value)];
      const o = fx?.[kind];
      if (o === 'settled' || o === 'delivered') return 'ok';
      if (o === 'failed_wrong_pin') return 'wrong_pin';
      if (o === 'failed_refunded') return 'fail_refund';
    }
    return this.config.otherNumbers === 'succeed' ? 'ok' : 'fail';
  }

  /* ── money-moving operations ──────────────────────────────────────────── */

  createCollection(cred: string, body: unknown): Reply {
    const r = this.parse(CollectionRequestSchema, body);
    this.provider(r.provider);
    const amount = this.amountOf(r.amount);
    const hash = hashOf(body);
    const dup = this.existing('collection', cred, r.reference, hash);
    if (dup) return { status: 202, body: this.view(dup) };
    this.checkLimits(cred, amount, 'in');
    const fee = this.fee(amount);
    const tx = this.newTx(
      'collection',
      cred,
      r.reference,
      amount,
      fee,
      r.provider,
      r.payer.value,
      hash,
      r.note,
    );
    tx.settlementStatus = 'not_eligible';
    this.register(tx);
    this.noteVolume(cred, amount, 'in');
    this.emit(cred, 'collection.accepted', this.view(tx));
    const outcome = this.fixtureOutcome('collection', r.provider, r.payer.value);
    this.later(Math.floor(this.config.resolveDelayMs / 2), () =>
      this.setStatus(tx, 'dispatched', 'collection.status_changed'),
    );
    this.later(this.config.resolveDelayMs, () => {
      if (outcome === 'ok') {
        this.credit(
          cred,
          applyFee(amount, fee, tx.feeBearer).recipientAmount,
          tx.reference,
          'collection',
        );
        tx.settlementStatus = 'eligible';
        this.setStatus(tx, 'settled', 'collection.status_changed', true);
      } else {
        this.setStatus(
          tx,
          'failed',
          'collection.status_changed',
          true,
          outcome === 'wrong_pin' ? 'wrong_pin' : 'declined',
        );
      }
    });
    return { status: 202, body: this.view(tx) };
  }

  async createPayout(cred: string, body: unknown): Promise<Reply> {
    const r = this.parse(PayoutRequestSchema, body);
    this.provider(r.provider);
    const amount = this.amountOf(r.amount);
    const hash = hashOf(body);
    const dup = this.existing('payout', cred, r.reference, hash);
    if (dup) return { status: 202, body: this.view(dup) };
    this.checkLimits(cred, amount, 'out');
    const fee = this.fee(amount);
    const tx = this.newTx(
      'payout',
      cred,
      r.reference,
      amount,
      fee,
      r.provider,
      r.destination.value,
      hash,
      r.note,
    );
    const payer = applyFee(amount, fee, tx.feeBearer).payerAmount;
    await this.debit(cred, payer, r.reference, 'payout_reserve', true);
    this.register(tx);
    this.noteVolume(cred, amount, 'out');
    this.emit(cred, 'payout.accepted', this.view(tx));

    const review = parseAmount(this.config.payoutReviewThreshold ?? '');
    if (review !== null && amount >= review) {
      this.later(this.config.resolveDelayMs, () =>
        this.setStatus(tx, 'in_review', 'payout.status_changed'),
      );
      return { status: 202, body: this.view(tx) };
    }
    const outcome = this.fixtureOutcome('payout', r.provider, r.destination.value);
    const half = Math.floor(this.config.resolveDelayMs / 2);
    const w = this.ensureWallet(cred);
    this.later(half, () => this.setStatus(tx, 'dispatching', 'payout.status_changed'));
    this.later(this.config.resolveDelayMs, () => {
      if (outcome === 'ok') {
        w.reserved -= payer;
        this.setStatus(tx, 'delivered', 'payout.status_changed', true);
      } else {
        this.setStatus(tx, 'failed', 'payout.status_changed', false, 'declined');
        this.later(Math.max(1, half), () => {
          w.reserved -= payer;
          this.credit(cred, payer, tx.reference, 'payout_refund');
          this.setStatus(tx, 'refunded', 'payout.status_changed', true);
        });
      }
    });
    return { status: 202, body: this.view(tx) };
  }

  async createPayoutBatch(cred: string, body: unknown): Promise<Reply> {
    const r = this.parse(PayoutBatchRequestSchema, body);
    const refs = r.items.map((i) => i.reference);
    if (new Set(refs).size !== refs.length)
      throw new SimError('invalid_input', 'items: duplicate reference in batch');
    const hash = hashOf(body);
    const bk = `${cred}:${r.reference}`;
    const seen = this.batches.get(bk);
    if (seen && this.config.idempotency !== 'broken') {
      if (seen.hash !== hash)
        throw new SimError(
          'duplicate_reference',
          'batch reference already used with a different body',
        );
      return seen.reply;
    }
    const items: Record<string, unknown>[] = [];
    for (const item of r.items) {
      try {
        const rep = await this.createPayout(cred, item);
        items.push({ reference: item.reference, status: 202, payout: rep.body });
      } catch (e) {
        if (!(e instanceof SimError)) throw e;
        items.push({ reference: item.reference, status: e.status, error: e.body.error });
      }
    }
    const reply: Reply = {
      status: 200,
      body: {
        batchId: `BATCH-${String(++this.seq).padStart(8, '0')}`,
        reference: r.reference,
        items,
      },
    };
    this.batches.set(bk, { hash, reply });
    return reply;
  }

  async createUtilityPurchase(cred: string, body: unknown): Promise<Reply> {
    const r = this.parse(UtilityPurchaseRequestSchema, body);
    if (r.currency !== 'GHS') throw new SimError('currency_not_supported', 'only GHS is sold');
    const product = PRODUCTS.find((p) => p.id === r.productId);
    if (!product) throw new SimError('product_not_found', 'no product matches productId');
    const needsAccount = product.category === 'utility';
    if (needsAccount && !r.beneficiary.accountNumber)
      throw new SimError(
        'invalid_input',
        'beneficiary.accountNumber is required for utility products',
      );
    if (!needsAccount && r.beneficiary.accountNumber)
      throw new SimError(
        'invalid_input',
        'beneficiary.accountNumber is refused for airtime and data',
      );
    if (r.funding.type === 'collection' && !r.funding.payer)
      throw new SimError(
        'invalid_input',
        'funding.payer is required when funding.type is collection',
      );
    const amount = this.amountOf(r.amount);
    if (
      amount < (parseAmount(product.min) ?? 0) ||
      amount > (parseAmount(product.max) ?? Infinity)
    ) {
      throw new SimError('amount_out_of_range', 'amount is outside the product range');
    }
    const hash = hashOf(body);
    const dup = this.existing('utility_purchase', cred, r.reference, hash);
    if (dup) return { status: 202, body: this.utilityView(dup) };
    this.checkLimits(cred, amount, 'out');
    const fee = this.fee(amount);
    const tx = this.newTx(
      'utility_purchase',
      cred,
      r.reference,
      amount,
      fee,
      null,
      r.beneficiary.msisdn,
      hash,
    );
    tx.extra = { productId: product.id, beneficiary: r.beneficiary, funding: r.funding };
    const walletFunded = r.funding.type === 'wallet';
    if (walletFunded) await this.debit(cred, amount + fee, r.reference, 'utility_reserve', true);
    this.register(tx);
    this.noteVolume(cred, amount, 'out');
    this.emit(cred, 'utility_purchase.accepted', this.utilityView(tx));
    const w = this.ensureWallet(cred);
    const half = Math.floor(this.config.resolveDelayMs / 2);
    this.later(half, () =>
      this.setStatus(
        tx,
        walletFunded ? 'vending' : 'awaiting_payment',
        'utility_purchase.status_changed',
      ),
    );
    this.later(this.config.resolveDelayMs, () => {
      if (this.config.otherNumbers === 'succeed') {
        if (walletFunded) w.reserved -= amount + fee;
        this.counters.utilityDeliveries++;
        this.setStatus(tx, 'delivered', 'utility_purchase.status_changed', true);
      } else {
        this.setStatus(tx, 'failed', 'utility_purchase.status_changed', false, 'vend_failed');
        if (walletFunded) {
          this.later(Math.max(1, half), () => {
            w.reserved -= amount + fee;
            this.credit(cred, amount + fee, tx.reference, 'utility_refund');
            this.setStatus(tx, 'refunded', 'utility_purchase.status_changed', true);
          });
        }
      }
    });
    return { status: 202, body: this.utilityView(tx) };
  }

  async createTransfer(cred: string, body: unknown): Promise<Reply> {
    const r = this.parse(TransferRequestSchema, body);
    if (r.currency !== 'GHS') throw new SimError('currency_not_supported', 'only GHS is supported');
    const amount = this.amountOf(r.amount);
    if (r.handle === cred) throw new SimError('own_handle', 'you cannot pay your own handle');
    if (!KNOWN_HANDLES.has(r.handle))
      throw new SimError('not_found', 'no business has that handle');
    const hash = hashOf(body);
    const dup = this.existing('transfer', cred, r.reference, hash);
    if (dup) return { status: 200, body: this.transferView(dup) };
    this.checkLimits(cred, amount, 'out');
    const tx = this.newTx('transfer', cred, r.reference, amount, 0, null, r.handle, hash);
    await this.debit(cred, amount, r.reference, 'transfer', false);
    this.credit(r.handle, amount, r.reference, 'transfer_in');
    this.register(tx);
    this.noteVolume(cred, amount, 'out');
    tx.status = 'completed';
    tx.completedAt = new Date().toISOString();
    this.emit(cred, 'transfer.status_changed', this.transferView(tx));
    this.emit(r.handle, 'transfer.received', this.transferView(tx));
    return { status: 200, body: this.transferView(tx) };
  }

  /* ── reads ────────────────────────────────────────────────────────────── */

  getTx(cred: string, kind: Kind, reference: string): Tx {
    const own = this.txs.get(`${kind}:${cred}:${reference}`);
    if (own) return own;
    if (this.config.weak.bola) {
      for (const t of this.txs.values()) if (t.kind === kind && t.reference === reference) return t;
    }
    throw new SimError('not_found', 'nothing found with that reference');
  }

  wallet(cred: string): Record<string, unknown> {
    const w = this.ensureWallet(cred);
    return {
      items: [
        {
          name: 'main',
          balances: { GHS: fmt(w.balance) },
          reserved: { GHS: fmt(w.reserved) },
          createdAt: w.createdAt,
        },
      ],
    };
  }

  limits(cred: string): Record<string, unknown> {
    const day = parseAmount(this.config.limits.daily) ?? 0;
    const leg = (used: number): Record<string, string> => ({
      used: fmt(used),
      remaining: fmt(Math.max(0, day - used)),
    });
    const period = (name: string): Record<string, unknown> => ({
      period: name,
      limit: this.config.limits.daily,
      in: leg(this.dailyIn.get(cred) ?? 0),
      out: leg(this.dailyOut.get(cred) ?? 0),
    });
    return {
      items: [
        {
          currency: 'GHS',
          perTransaction: this.config.limits.perTransaction,
          daily: period('daily'),
          monthly: period('monthly'),
        },
      ],
    };
  }

  paymentMethods(): Record<string, unknown> {
    const rows = PROVIDERS.flatMap((provider) =>
      (['collection', 'disbursement'] as const).map((rail) => ({
        provider,
        currency: 'GHS',
        rail,
        limits: { min: '1.00', max: this.config.limits.perTransaction },
        health: 'healthy',
      })),
    );
    return { items: rows };
  }

  utilityProducts(): Record<string, unknown> {
    return { items: PRODUCTS };
  }

  feeQuote(q: Record<string, unknown>): Record<string, unknown> {
    if (
      typeof q['currency'] !== 'string' ||
      typeof q['provider'] !== 'string' ||
      typeof q['partyType'] !== 'string'
    ) {
      throw new SimError('invalid_input', 'provider, amount, currency and partyType are required');
    }
    const amount = this.amountOf(typeof q['amount'] === 'string' ? q['amount'] : '');
    const fee = this.fee(amount);
    const pe = applyFee(amount, fee, this.config.feeBearer);
    return {
      amount: fmt(amount),
      currency: q['currency'],
      fee: fmt(fee),
      feeBearer: this.config.feeBearer,
      payerAmount: fmt(pe.payerAmount),
      recipientAmount: fmt(pe.recipientAmount),
    };
  }

  utilityFeeQuote(q: Record<string, unknown>): Record<string, unknown> {
    const product = PRODUCTS.find((p) => p.id === q['productId']);
    if (typeof q['productId'] !== 'string' || typeof q['currency'] !== 'string') {
      throw new SimError('invalid_input', 'productId, amount and currency are required');
    }
    if (!product) throw new SimError('product_not_found', 'no product matches productId');
    const amount = this.amountOf(typeof q['amount'] === 'string' ? q['amount'] : '');
    const fee = this.fee(amount);
    return {
      productId: product.id,
      amount: fmt(amount),
      currency: q['currency'],
      fee: fmt(fee),
      gross: fmt(amount + fee),
    };
  }

  /** Test/control: set a wallet's available balance via a ledger entry, so reconciliation stays exact. */
  setBalance(cred: string, amount: string): void {
    const target = parseAmount(amount);
    if (target === null)
      throw new SimError('invalid_input', 'balance must be a positive decimal string');
    const w = this.ensureWallet(cred);
    const delta = target - w.balance;
    w.balance = target;
    this.post(cred, delta, 'control', 'test_adjustment');
  }

  recipient(handle: string, cred: string): Record<string, unknown> {
    if (handle === cred) throw new SimError('own_handle', 'you cannot pay your own handle');
    if (!KNOWN_HANDLES.has(handle)) throw new SimError('not_found', 'no business has that handle');
    return { handle, businessName: 'Simulated Business', handleSince: '2024-01-01T00:00:00Z' };
  }

  transactions(
    cred: string,
    q: {
      kind?: string | undefined;
      status?: string | undefined;
      limit: number;
      cursor?: string | undefined;
    },
  ): Record<string, unknown> {
    const all = [...this.txs.values()]
      .filter((t) => t.credential === cred)
      .filter(
        (t) =>
          !q.kind || (q.kind === 'utility' ? t.kind === 'utility_purchase' : q.kind === t.kind),
      )
      .filter((t) => !q.status || t.status === q.status);
    const start = q.cursor ? Number(Buffer.from(q.cursor, 'base64url').toString()) : 0;
    if (!Number.isInteger(start) || start < 0)
      throw new SimError('invalid_input', 'cursor is invalid');
    const page = all.slice(start, start + q.limit);
    const next =
      start + q.limit < all.length
        ? Buffer.from(String(start + q.limit)).toString('base64url')
        : undefined;
    return {
      items: page.map((t) => ({
        id: t.id,
        kind: t.kind,
        direction: t.kind === 'collection' ? 'in' : 'out',
        ...this.viewFor(t),
      })),
      ...(next ? { nextCursor: next } : {}),
    };
  }

  listEvents(cred: string, after: string | undefined, limit: number): Record<string, unknown> {
    const mine = this.events.filter((e) => e.cred === cred);
    let from = 0;
    if (after) {
      const idx = mine.findIndex((e) => e.env.id === after);
      if (idx < 0) throw new SimError('invalid_input', 'after is not one of your events');
      from = idx + 1;
    }
    const page = mine.slice(from, from + limit);
    return {
      items: page.map((e) => e.env),
      ...(from + limit < mine.length ? { nextAfter: page[page.length - 1]?.env.id } : {}),
    };
  }

  /* ── checkouts ────────────────────────────────────────────────────────── */

  createCheckout(cred: string, body: unknown): Reply {
    if (!this.config.checkoutEnabled)
      throw new SimError('checkout_not_enabled', 'hosted checkout is not enabled');
    const b = this.parse(
      z
        .object({
          reference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
          amount: money,
          currency: z.string().regex(/^[A-Z]{3}$/),
          description: z.string().max(140).optional(),
        })
        .passthrough(),
      body,
    );
    const key = `${cred}:${b.reference}`;
    if (this.checkouts.has(key))
      throw new SimError('checkout_reference_taken', 'reference already used');
    const id = `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`;
    const c = {
      id,
      reference: b.reference,
      amount: b.amount,
      currency: b.currency,
      ...(b.description ? { description: b.description } : {}),
      environment: 'test',
      status: 'open',
      url: `https://checkout.sim.invalid/${id}`,
      expiresAt: null,
      paidAt: null,
      collectionReference: null,
      createdAt: new Date().toISOString(),
      amountType: 'fixed',
      usage: 'single',
      paymentsCount: 0,
      totalCollected: '0.00',
      cred,
    };
    this.checkouts.set(key, c);
    return { status: 201, body: this.pub(c) };
  }

  private pub(c: Record<string, unknown>): Record<string, unknown> {
    const { cred: _cred, ...rest } = c;
    return rest;
  }

  listCheckouts(cred: string): Record<string, unknown> {
    return {
      items: [...this.checkouts.values()].filter((c) => c['cred'] === cred).map((c) => this.pub(c)),
    };
  }

  private findCheckout(cred: string, id: string): Record<string, unknown> {
    const c = [...this.checkouts.values()].find(
      (x) => x['id'] === id && (x['cred'] === cred || this.config.weak.bola),
    );
    if (!c) throw new SimError('not_found', 'no such checkout');
    return c;
  }

  getCheckout(cred: string, id: string): Record<string, unknown> {
    return this.pub(this.findCheckout(cred, id));
  }

  cancelCheckout(cred: string, id: string): Reply {
    const c = this.findCheckout(cred, id);
    if (c['status'] !== 'open') throw new SimError('checkout_not_open', 'checkout is not open');
    c['status'] = 'cancelled';
    return { status: 200, body: this.pub(c) };
  }

  /* ── settlements ──────────────────────────────────────────────────────── */

  getPolicy(): Record<string, unknown> {
    return {
      options: {
        momo: { available: true },
        bank: { available: false },
        split: { available: false },
      },
      policy: this.policy,
    };
  }

  putPolicy(body: unknown): Record<string, unknown> {
    const b = this.parse(
      z
        .object({
          destination: z.enum(['momo', 'bank', 'split']),
          schedule: z.object({ mode: z.enum(['scheduled', 'on_demand_only']) }).passthrough(),
          minimum: z.string().optional(),
          bankSharePercent: z.number().int().min(1).max(99).optional(),
        })
        .passthrough(),
      body,
    );
    if (b.destination !== 'momo')
      throw new SimError('bank_settlement_unavailable', 'bank settlement is unavailable', 422);
    const version = ((this.policy?.['version'] as number | undefined) ?? 0) + 1;
    this.policy = {
      destination: b.destination,
      legs: [{ accountType: 'momo', label: '****0001', sharePercent: 100 }],
      schedule: b.schedule,
      minimum: b.minimum ?? '',
      currency: 'GHS',
      version,
      inSync: true,
    };
    return this.getPolicy();
  }

  deletePolicy(): Record<string, unknown> {
    this.policy = null;
    return this.getPolicy();
  }

  settleNow(cred: string, body: unknown): Reply {
    const r = this.parse(SettleNowRequestSchema, body);
    if (!this.policy) throw new SimError('not_found', 'no settlement policy exists');
    const dup = this.settlementRuns.find(
      (s) => s['reference'] === r.reference && s['cred'] === cred,
    );
    if (dup) return { status: 202, body: this.pub(dup) };
    const due = [...this.txs.values()].filter(
      (t) =>
        t.credential === cred &&
        t.kind === 'collection' &&
        t.status === 'settled' &&
        t.settlementStatus === 'eligible',
    );
    const net = due.reduce((s, t) => s + applyFee(t.amount, t.fee, t.feeBearer).recipientAmount, 0);
    const id = `STL-${String(++this.seq).padStart(8, '0')}`;
    if (net > 0) {
      for (const t of due) t.settlementStatus = 'settled';
      this.ensureWallet(cred).balance -= net;
      this.post(cred, -net, id, 'settlement');
    }
    const now = new Date().toISOString();
    const run = {
      id,
      reference: r.reference,
      status: 'completed',
      outcome: 'settled',
      itemCount: due.length,
      total: fmt(net),
      currency: 'GHS',
      startedAt: now,
      completedAt: now,
      cred,
    };
    this.settlementRuns.push(run);
    this.emit(cred, 'settlement.status_changed', this.pub(run));
    return { status: 202, body: this.pub(run) };
  }

  listRuns(cred: string): Record<string, unknown> {
    return { items: this.settlementRuns.filter((s) => s['cred'] === cred).map((s) => this.pub(s)) };
  }

  getRun(cred: string, id: string): Record<string, unknown> {
    const mine = this.settlementRuns.filter((x) => x['cred'] === cred);
    const pick = id === 'latest' ? mine.at(-1) : mine.find((x) => x['id'] === id);
    if (!pick) throw new SimError('not_found', 'no such settlement run');
    return this.pub(pick);
  }

  retryRun(cred: string, id: string): Reply {
    this.getRun(cred, id);
    throw new SimError(
      'resettlement_not_allowed',
      'only failed_partial or failed_all runs can be retried',
    );
  }

  /* ── webhooks ─────────────────────────────────────────────────────────── */

  private emit(cred: string, type: string, data: Record<string, unknown>): void {
    const env: WebhookEnvelope = {
      id: `evt_${randomBytes(8).toString('hex')}`,
      type,
      createdAt: new Date().toISOString(),
      data,
    };
    this.events.push({ cred, env });
    const { url, duplicateRate, outOfOrder } = this.config.webhooks;
    if (!url) return;
    const copies = duplicateRate > 0 && this.rand() < duplicateRate ? 2 : 1;
    const delay = outOfOrder && type.endsWith('.accepted') ? 80 + this.rand() * 120 : 0;
    const epoch = this.epoch;
    for (let i = 0; i < copies; i++) {
      setTimeout(
        () => {
          if (epoch === this.epoch) void this.deliver(url, env, 1, epoch);
        },
        delay + i * 5,
      ).unref();
    }
  }

  private async deliver(
    url: string,
    env: WebhookEnvelope,
    attempt: number,
    epoch: number,
  ): Promise<void> {
    const raw = JSON.stringify(env);
    const ts = String(Math.floor(Date.now() / 1000)); // fresh each attempt; Webhook-Id never changes
    let ok = false;
    try {
      const res = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          'webhook-id': env.id,
          'webhook-timestamp': ts,
          'webhook-signature': signWebhook(this.config.webhooks.secret, env.id, ts, raw),
        },
        body: raw,
        signal: AbortSignal.timeout(10_000),
      });
      ok = res.status >= 200 && res.status < 300; // redirects are not followed and count as failures
    } catch {
      ok = false;
    }
    if (ok) {
      this.counters.webhooksSent++;
      return;
    }
    if (attempt < this.config.webhooks.attempts && epoch === this.epoch) {
      this.counters.webhooksRetried++;
      setTimeout(
        () => {
          if (epoch === this.epoch) void this.deliver(url, env, attempt + 1, epoch);
        },
        this.config.webhooks.baseDelayMs * 2 ** (attempt - 1),
      ).unref();
    } else {
      this.counters.webhooksFailed++;
    }
  }

  /* ── reconciliation view (Phase 25) ───────────────────────────────────── */

  state(): Record<string, unknown> {
    const wallets = [...this.wallets.values()].map((w) => {
      const sum = this.ledger.filter((l) => l.wallet === w.id).reduce((s, l) => s + l.delta, 0);
      return {
        id: w.id,
        balance: fmt(w.balance),
        reserved: fmt(w.reserved),
        ledgerBalance: fmt(w.opening + sum),
        driftPesewas: w.balance - (w.opening + sum),
      };
    });
    const byKind: Record<string, Record<string, number>> = {};
    for (const t of this.txs.values()) {
      const m = (byKind[t.kind] ??= {});
      m[t.status] = (m[t.status] ?? 0) + 1;
    }
    let duplicateEffects = 0;
    for (const n of this.effects.values()) duplicateEffects += Math.max(0, n - 1);
    return {
      wallets,
      transactions: { total: this.txs.size, byKind },
      duplicateEffects,
      negativeBalances: [...this.wallets.values()].filter((w) => w.balance < 0).map((w) => w.id),
      ledgerDriftPesewas: wallets.reduce((s, w) => s + Math.abs(w.driftPesewas), 0),
      counters: { ...this.counters },
    };
  }
}
