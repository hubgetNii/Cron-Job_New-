import { setTimeout as sleep } from 'node:timers/promises';
import { ApiClient, type ClientOptions, type Exchange } from './client.js';
import { WebhookReceiver } from './receiver.js';
import {
  CHECKS,
  toPesewas,
  type Assertion,
  type Check,
  type CheckContext,
  type SimControl,
  type SimState,
} from './checks.js';

export type CheckStatus = 'PASS' | 'FAIL' | 'ERROR' | 'SKIPPED';

export interface CheckResult {
  id: string;
  title: string;
  controls: string[];
  status: CheckStatus;
  /** OWASP API Security category, when the check belongs to the security suite. */
  owasp?: string;
  assertions: Assertion[];
  /** Advisory assertions that failed: reported, but they do not fail the check. */
  warnings: number;
  durationMs: number;
  /** Per-call evidence for THIS check: ids and statuses only — no bodies, no secrets. */
  evidence: Exchange[];
  note?: string;
}

export interface SuiteSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  warnings: number;
  assertions: { total: number; failed: number };
  verdict: 'PASS' | 'FAIL';
}

export interface SuiteReport {
  mode: 'simulator' | 'live';
  startedAt: string;
  finishedAt: string;
  results: CheckResult[];
  summary: SuiteSummary;
}

export interface SuiteOptions {
  client: ClientOptions;
  /** Present only when the target is the simulator (class MOCK). */
  simBaseUrl?: string | undefined;
  /** The checks to choose from (default: the correctness suite). */
  pool?: Check[];
  /** A credential for a different account, when one is configured (live) — the simulator derives its own. */
  secondClient?: ClientOptions | undefined;
  clientSecret?: string;
  /** Run only these checks (default: every applicable one). */
  only?: string[] | undefined;
  /** Run-unique token so references never collide with an earlier run. */
  salt: string;
  /** Receiver/simulator webhook secret (simulator default shown). */
  webhookSecret?: string;
  /** Called between checks; return a reason to stop the suite early. */
  shouldStop?: () => Promise<string | null>;
  settleTimeoutMs?: number;
  /** Test hook: use a different secret in the receiver than the sender. */
  receiverSecretOverride?: string;
}

function simControl(base: string, record: (e: Exchange) => void): SimControl {
  const json = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await fetch(`${base}/__sim${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    record({
      at: new Date().toISOString(),
      method,
      path: `/__sim${path}`,
      status: res.status,
      ms: 0,
      requestId: null,
      idempotencyKey: null,
    });
    if (!res.ok) throw new Error(`simulator control ${method} ${path} failed: HTTP ${res.status}`);
    return ((await res.json()) as { data?: unknown }).data;
  };
  return {
    config: async (patch) => void (await json('PUT', '/config', patch)),
    reset: async (patch) => void (await json('POST', '/reset', patch)),
    setBalance: async (id, amount) =>
      void (await json('PUT', `/wallets/${encodeURIComponent(id)}`, { balance: amount })),
    state: async () => (await json('GET', '/state')) as SimState,
  };
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

function makeContext(
  api: ApiClient,
  sim: SimControl | null,
  opts: SuiteOptions,
  second: ApiClient | null,
): CheckContext {
  let n = 0;
  const receivers: WebhookReceiver[] = [];
  const secret = opts.webhookSecret ?? 'sim-webhook-secret';
  const settle = opts.settleTimeoutMs ?? (sim ? 5_000 : 120_000);

  const refsOf = async (kind: 'payout' | 'collection'): Promise<Set<string>> => {
    const out = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = await api.call(
        'GET',
        `/v1/transactions?kind=${kind}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      const items = rec(r.body)['items'];
      if (Array.isArray(items))
        for (const i of items)
          if (typeof rec(i)['reference'] === 'string') out.add(rec(i)['reference'] as string);
      const next = rec(r.body)['nextCursor'];
      if (typeof next !== 'string' || next === '') break;
      cursor = next;
    }
    return out;
  };

  const ctx: CheckContext = {
    api,
    clientId: opts.client.clientId,
    clientSecret: opts.client.clientSecret,
    second,
    clientFor: (id) => (sim ? new ApiClient({ ...opts.client, clientId: id }) : null),
    sim,
    webhookSecret: secret,
    settleTimeoutMs: settle,
    ref: () => `LTC-${opts.salt}-${++n}`,
    idem: () => `IDEM-TST-${opts.salt}-${++n}`,
    payout: (ref, over = {}) => ({
      reference: ref,
      amount: '1.00',
      currency: 'GHS',
      provider: 'telecel',
      destination: { type: 'msisdn', value: '233000000001' },
      ...over,
    }),
    collection: (ref, over = {}) => ({
      reference: ref,
      amount: '1.00',
      currency: 'GHS',
      provider: 'telecel',
      payer: { type: 'msisdn', value: '233000000001' },
      ...over,
    }),
    refsOf,
    countByRef: async (kind, ref) => {
      // The reference lookup is the authoritative per-payment read; the list confirms there are no twins.
      const direct = await api.call(
        'GET',
        `/v1/${kind === 'payout' ? 'payouts' : 'collections'}/${ref}`,
      );
      if (direct.status === 404) return 0;
      const all = await refsOf(kind);
      return all.has(ref) ? 1 : direct.status === 200 ? 1 : 0;
    },
    wallet: async () => {
      const r = await api.call('GET', '/v1/wallet');
      const item = rec((rec(r.body)['items'] as unknown[] | undefined)?.[0]);
      return {
        available: toPesewas(rec(item['balances'])['GHS']) ?? 0,
        reserved: toPesewas(rec(item['reserved'])['GHS']) ?? 0,
      };
    },
    waitFor: async <T>(
      fn: () => Promise<T | null | false | undefined>,
      timeoutMs = settle,
    ): Promise<T | null> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() >= deadline) return null;
        await sleep(sim ? 50 : 1000);
      }
    },
    receiver: async (rxSecret, failWith) => {
      const rx = new WebhookReceiver(opts.receiverSecretOverride ?? rxSecret ?? secret, failWith);
      receivers.push(rx);
      return { rx, url: await rx.start() };
    },
  };
  // Stop any receiver a check forgot to close (belt and braces).
  (ctx as CheckContext & { dispose?: () => Promise<void> }).dispose = async () => {
    await Promise.all(receivers.map((r) => r.stop().catch(() => undefined)));
  };
  return ctx;
}

export const applicableChecks = (
  simulator: boolean,
  only?: string[],
  pool: Check[] = CHECKS,
): Check[] =>
  pool
    .filter((c) => (only && only.length > 0 ? only.includes(c.id) : true))
    .filter((c) => simulator || c.requires.length === 0);

/** Runs the suite. Never throws for a failing check — failures are results. */
export async function runSuite(opts: SuiteOptions): Promise<SuiteReport> {
  const startedAt = new Date().toISOString();
  const pool = opts.pool ?? CHECKS;
  const api = new ApiClient(opts.client);
  const sim = opts.simBaseUrl ? simControl(opts.simBaseUrl, (e) => api.exchanges.push(e)) : null;
  // A second account: the simulator accepts any client id; live needs a configured credential.
  const second = sim
    ? new ApiClient({ ...opts.client, clientId: `${opts.client.clientId}_b` }, api.exchanges)
    : opts.secondClient
      ? new ApiClient(opts.secondClient, api.exchanges)
      : null;
  const ctx = makeContext(api, sim, opts, second);
  const chosen = applicableChecks(sim !== null, opts.only, pool);
  const skippedForMode = pool
    .filter((c) => (opts.only?.length ? opts.only.includes(c.id) : true))
    .filter((c) => !chosen.includes(c));
  const results: CheckResult[] = [];

  const base = (
    c: Check,
  ): Pick<CheckResult, 'id' | 'title' | 'controls' | 'owasp' | 'warnings'> => ({
    id: c.id,
    title: c.title,
    controls: c.controls,
    ...(c.owasp ? { owasp: c.owasp } : {}),
    warnings: 0,
  });

  for (const check of chosen) {
    const stop = (await opts.shouldStop?.()) ?? null;
    if (stop) {
      results.push({
        ...base(check),
        status: 'SKIPPED',
        assertions: [],
        durationMs: 0,
        evidence: [],
        note: `suite stopped: ${stop}`,
      });
      continue;
    }
    const from = api.exchanges.length;
    const t0 = Date.now();
    try {
      const out = await check.run(ctx);
      if (!Array.isArray(out)) {
        results.push({
          ...base(check),
          status: 'SKIPPED',
          assertions: [],
          durationMs: Date.now() - t0,
          evidence: api.exchanges.slice(from),
          note: out.skip,
        });
        continue;
      }
      const required = out.filter((a) => !a.advisory);
      results.push({
        ...base(check),
        status: required.every((a) => a.pass) ? 'PASS' : 'FAIL',
        warnings: out.filter((a) => a.advisory && !a.pass).length,
        assertions: out,
        durationMs: Date.now() - t0,
        evidence: api.exchanges.slice(from),
      });
    } catch (err) {
      results.push({
        ...base(check),
        status: 'ERROR',
        assertions: [],
        durationMs: Date.now() - t0,
        evidence: api.exchanges.slice(from),
        note: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      });
    }
  }
  await (ctx as CheckContext & { dispose?: () => Promise<void> }).dispose?.();

  for (const c of skippedForMode) {
    results.push({
      ...base(c),
      status: 'SKIPPED',
      assertions: [],
      durationMs: 0,
      evidence: [],
      note: 'requires the simulator control plane (not available against a live target)',
    });
  }
  return {
    mode: sim ? 'simulator' : 'live',
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
    summary: summarize(results),
  };
}

export function summarize(results: CheckResult[]): SuiteSummary {
  const count = (s: CheckStatus): number => results.filter((r) => r.status === s).length;
  const all = results.flatMap((r) => r.assertions);
  const failed = count('FAIL');
  const errored = count('ERROR');
  return {
    total: results.length,
    passed: count('PASS'),
    failed,
    errored,
    skipped: count('SKIPPED'),
    warnings: results.reduce((n, r) => n + r.warnings, 0),
    assertions: { total: all.length, failed: all.filter((a) => !a.pass).length },
    verdict: failed + errored === 0 && count('PASS') > 0 ? 'PASS' : 'FAIL',
  };
}
