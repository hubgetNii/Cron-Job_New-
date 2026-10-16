import { connect } from 'node:tls';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  BatchResponseSchema,
  ErrorBodySchema,
  MoneyMovementSchema,
  WalletResponseSchema,
} from '../contract/ismartpay.js';
import { luhnValid } from '../../domain/load-test-data.js';
import type { ApiResponse } from './client.js';
import { errCode, ok, rec, type Assertion, type Check, type CheckContext } from './checks.js';

/**
 * Security / abuse-resilience checks (Phase 26), aligned to the OWASP API
 * Security Top 10 (2023). They verify that DEFENCES HOLD under hostile-but-
 * ordinary input — they are not exploit tooling: low volume, no brute force,
 * nothing destructive, and only against targets the safety gate has cleared.
 *
 * Assertion levels: a REQUIRED assertion that fails fails the check. An
 * `advisory` assertion that fails is a WARNING (e.g. a missing hardening header,
 * or behaviour the vendor's docs leave unspecified) — reported, never hidden,
 * but not a verdict-changing defect.
 */

const adv = (name: string, pass: boolean, detail?: string): Assertion => ({
  ...ok(name, pass, detail),
  advisory: true,
});
const contentType = (r: ApiResponse): string => r.headers?.get('content-type') ?? '';
const isJson = (r: ApiResponse): boolean => contentType(r).includes('application/json');
const header = (r: ApiResponse, n: string): string | null => r.headers?.get(n) ?? null;
const is4xx = (s: number): boolean => s >= 400 && s < 500;

/** Patterns that must never appear in an API response body. */
const LEAK_PATTERNS: [string, RegExp][] = [
  ['stack trace', /\bat\s+[\w$.<>]+\s*\(.*:\d+:\d+\)|\bat\s+\/.*:\d+:\d+/],
  ['source path', /node_modules|\/srv\/|\/usr\/(local|lib)|\/home\/|\.(js|ts|py|rb|java):\d+/],
  [
    'sql text',
    /\b(select|insert\s+into|update|delete\s+from)\b.{0,80}\b(from|set|values|where)\b/i,
  ],
  ['connection string', /\b(postgres(ql)?|mysql|mongodb|redis|amqp):\/\/[^\s"']*@/i],
  [
    'infrastructure error',
    /\bECONN(RESET|REFUSED)|ENOTFOUND|pool exhausted|deadlock detected|ORA-\d+/i,
  ],
  [
    'secret material',
    /password\s*[=:]\s*\S+|api[_-]?key\s*[=:]\s*\S+|BEGIN (RSA |EC )?PRIVATE KEY/i,
  ],
];

function leaks(body: unknown): string[] {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return LEAK_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** Field names that signal internals leaking into a response. */
const SENSITIVE_KEY =
  /(password|secret|token|api[_-]?key|internal|ledger|shard|raw|stack|trace|cvv|pin\b|pan\b|private)/i;
const DOCUMENTED_KEYS = new Set([
  ...Object.keys(MoneyMovementSchema.shape),
  'parent',
  'compensation',
  'settlementStatus',
  'reconciliation',
  'name',
  'balances',
  'reserved',
  'items',
  'currency',
  'perTransaction',
  'daily',
  'monthly',
]);

function walkKeys(
  v: unknown,
  path: string,
  out: { sensitive: string[]; undocumented: string[] },
  depth = 0,
): void {
  if (depth > 6 || v === null || typeof v !== 'object') return;
  if (Array.isArray(v)) return void v.forEach((x) => walkKeys(x, path, out, depth + 1));
  for (const [k, x] of Object.entries(v)) {
    if (SENSITIVE_KEY.test(k)) out.sensitive.push(`${path}${k}`);
    if (depth === 0 && !DOCUMENTED_KEYS.has(k)) out.undocumented.push(k);
    if (typeof x === 'string') {
      const digits = x.replace(/[\s-]/g, '');
      if (/^\d{13,19}$/.test(digits) && luhnValid(digits))
        out.sensitive.push(`${path}${k} (card-number-like value)`);
    }
    walkKeys(x, `${path}${k}.`, out, depth + 1);
  }
}

async function bogusToken(
  c: CheckContext,
  clientId: string,
  secret: string,
): Promise<{ status: number; body: unknown; text: string }> {
  const res = await fetch(c.api.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: secret,
      resource: 'ismartpay',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  c.api.exchanges.push({
    at: new Date().toISOString(),
    method: 'POST',
    path: '/v1/oauth/token',
    status: res.status,
    ms: 0,
    requestId: res.headers.get('request-id'),
    idempotencyKey: null,
    ...(errCode({ status: res.status, body, headers: null, requestId: null })
      ? { errorCode: errCode({ status: res.status, body, headers: null, requestId: null })! }
      : {}),
  });
  return { status: res.status, body, text };
}

function tlsProbe(
  host: string,
  port: number,
): Promise<{ protocol: string | null; daysLeft: number }> {
  return new Promise((resolve, reject) => {
    const socket = connect(
      { host, port, servername: host, rejectUnauthorized: true, timeout: 8000 },
      () => {
        const cert = socket.getPeerCertificate();
        const out = {
          protocol: socket.getProtocol(),
          daysLeft: Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000),
        };
        socket.end();
        resolve(out);
      },
    );
    socket.on('error', reject);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('TLS probe timed out'));
    });
  });
}

export const SECURITY_CHECKS: Check[] = [
  {
    id: 'bola.cross-account-access',
    owasp: 'API1:2023 Broken Object Level Authorization',
    title: 'One account cannot read another account’s payments, and cannot tell they exist',
    controls: ['access-control', 'data-isolation'],
    requires: [],
    async run(c) {
      const b = c.second;
      if (!b)
        return {
          skip: 'needs a credential for a SECOND account (tokenUsernameB / tokenPasswordB on the target); the simulator derives one automatically',
        };
      const ref = c.ref();
      const created = await c.api.call('POST', '/v1/payouts', {
        body: c.payout(ref),
        key: c.idem(),
      });
      const own = await c.api.call('GET', `/v1/payouts/${ref}`);
      const other = await b.call('GET', `/v1/payouts/${ref}`);
      const ghost = await b.call('GET', `/v1/payouts/${c.ref()}`);
      const otherList = await b.call('GET', '/v1/transactions?kind=payout&limit=100');
      const listed = (rec(otherList.body)['items'] as unknown[] | undefined) ?? [];
      return [
        ok(
          'account A can create and read its own payout',
          created.status === 202 && own.status === 200,
        ),
        ok(
          'account B reading A’s payout gets no data (404/403, never 200)',
          other.status === 404 || other.status === 403,
          `HTTP ${other.status}`,
        ),
        ok(
          'the refusal reveals nothing about the payment',
          !JSON.stringify(other.body).includes(ref) || other.status >= 400,
        ),
        ok(
          'account B’s transaction list does not contain A’s payment',
          !listed.some((i) => rec(i)['reference'] === ref),
        ),
        ok(
          '"exists but not yours" is indistinguishable from "does not exist" (no existence oracle)',
          other.status === ghost.status && errCode(other) === errCode(ghost),
          `${other.status}/${errCode(other) ?? '-'} vs ${ghost.status}/${errCode(ghost) ?? '-'}`,
        ),
      ];
    },
  },
  {
    id: 'auth.bogus-client-rejected',
    owasp: 'API2:2023 Broken Authentication',
    title: 'Unknown clients and wrong secrets never receive a token, and cannot be told apart',
    controls: ['authentication', 'account-enumeration'],
    requires: [],
    async run(c) {
      const strict = c.sim !== null;
      if (c.sim)
        await c.sim.config({ auth: { strict: true, clients: { [c.clientId]: c.clientSecret } } });
      try {
        const out: Assertion[] = [];
        const bogus = await Promise.all(
          ['ghost-client-1', 'ghost-client-2', 'x', 'admin', 'root'].map((id) =>
            bogusToken(c, id, 'not-a-real-secret'),
          ),
        );
        out.push(
          ok(
            '5 unknown client ids all fail (400/401/403)',
            bogus.every((r) => [400, 401, 403].includes(r.status)),
            bogus.map((r) => r.status).join(','),
          ),
        );
        out.push(
          ok(
            'none of them returned an access token',
            bogus.every((r) => !r.text.includes('access_token')),
          ),
        );
        out.push(
          ok(
            'the failures leak nothing about the server',
            bogus.every((r) => leaks(r.body).length === 0),
          ),
        );
        if (strict) {
          const unknown = await bogusToken(c, 'ghost-client-9', 'wrong');
          const wrongSecret = await bogusToken(c, c.clientId, 'definitely-wrong');
          out.push(
            ok(
              'a REAL client id with a wrong secret is also refused',
              wrongSecret.status === 401,
              `HTTP ${wrongSecret.status}`,
            ),
          );
          out.push(
            ok(
              '"unknown client" and "wrong secret" return identical responses (no enumeration)',
              unknown.status === wrongSecret.status &&
                errCode({ status: 0, body: unknown.body, headers: null, requestId: null }) ===
                  errCode({ status: 0, body: wrongSecret.body, headers: null, requestId: null }),
            ),
          );
        } else {
          out.push(
            adv(
              'wrong-secret attempts against the REAL client id were deliberately not made against a live identity service (risk of locking the key)',
              true,
            ),
          );
        }
        return out;
      } finally {
        if (c.sim) await c.sim.config({ auth: { strict: false, clients: {} } });
      }
    },
  },
  {
    id: 'auth.token-expiry-enforced',
    owasp: 'API2:2023 Broken Authentication',
    title: 'An expired token is refused — sessions do not live forever',
    controls: ['authentication', 'session-management'],
    requires: ['simulator'],
    async run(c) {
      await c.sim!.config({ tokenTtlSeconds: 1 });
      try {
        const token = await c.api.getToken(true);
        const fresh = await c.api.call('GET', '/v1/wallet', { token });
        await sleep(1300);
        const stale = await c.api.call('GET', '/v1/wallet', { token });
        const write = await c.api.call('POST', '/v1/payouts', {
          body: c.payout(c.ref()),
          key: c.idem(),
          token,
        });
        return [
          ok('a fresh token works', fresh.status === 200),
          ok(
            'the same token is refused after it expires (401 unauthenticated)',
            stale.status === 401 && errCode(stale) === 'unauthenticated',
            `HTTP ${stale.status}`,
          ),
          ok('an expired token cannot create payments either', write.status === 401),
        ];
      } finally {
        await c.sim!.config({ tokenTtlSeconds: 300 });
        await c.api.getToken(true);
      }
    },
  },
  {
    id: 'bopla.mass-assignment-rejected',
    owasp: 'API3:2023 Broken Object Property Level Authorization',
    title: 'A client cannot set server-owned fields (status, fee, amounts) on create',
    controls: ['input-validation', 'ledger-integrity'],
    requires: [],
    async run(c) {
      const ref = c.ref();
      const r = await c.api.call('POST', '/v1/payouts', {
        body: {
          ...c.payout(ref),
          status: 'delivered',
          fee: '0.00',
          payerAmount: '0.00',
          completedAt: '2020-01-01T00:00:00Z',
          isAdmin: true,
          internalId: 'x',
        },
        key: c.idem(),
      });
      const body = rec(r.body);
      const stored = r.status === 202 || r.status === 200;
      return [
        ok(
          'unknown / server-owned fields are refused with 400',
          r.status === 400 || r.status === 422 || (stored && body['status'] === 'accepted'),
          `HTTP ${r.status}`,
        ),
        ok(
          'if the request was accepted, the client-supplied status was NOT applied',
          !stored || body['status'] === 'accepted',
          String(body['status']),
        ),
        ok('the client-supplied fee of 0.00 was NOT applied', !stored || body['fee'] !== '0.00'),
        ok(
          'a refused request created nothing',
          stored || (await c.countByRef('payout', ref)) === 0,
        ),
      ];
    },
  },
  {
    id: 'bopla.response-allowlist',
    owasp: 'API3:2023 Broken Object Property Level Authorization',
    title: 'Responses expose only documented fields — no internals, secrets or card-like values',
    controls: ['data-minimisation', 'pci-data-protection'],
    requires: [],
    async run(c) {
      const ref = c.ref();
      const created = await c.api.call('POST', '/v1/payouts', {
        body: c.payout(ref),
        key: c.idem(),
      });
      const got = await c.api.call('GET', `/v1/payouts/${ref}`);
      const wallet = await c.api.call('GET', '/v1/wallet');
      const limits = await c.api.call('GET', '/v1/limits');
      const found = { sensitive: [] as string[], undocumented: [] as string[] };
      for (const [name, r] of [
        ['create', created],
        ['get', got],
      ] as const)
        walkKeys(r.body, `${name}.`, found);
      for (const [name, r] of [
        ['wallet', wallet],
        ['limits', limits],
      ] as const) {
        for (const item of (rec(r.body)['items'] as unknown[] | undefined) ?? [])
          walkKeys(item, `${name}.`, { sensitive: found.sensitive, undocumented: [] });
      }
      const allText = JSON.stringify([created.body, got.body, wallet.body, limits.body]);
      return [
        ok(
          'no response field is named like a secret, token, ledger or internal id',
          found.sensitive.length === 0,
          found.sensitive.join(', '),
        ),
        ok(
          'no response value looks like a card number',
          !/\b\d{13,19}\b/.test(allText) ||
            ![...allText.matchAll(/\b\d{13,19}\b/g)].some((m) => luhnValid(m[0])),
        ),
        ok(
          'no response contains infrastructure or credential material',
          leaks([created.body, got.body, wallet.body, limits.body]).length === 0,
          leaks([created.body, got.body]).join(', '),
        ),
        adv(
          'every top-level field of a payment is documented',
          found.undocumented.length === 0,
          found.undocumented.join(', '),
        ),
      ];
    },
  },
  {
    id: 'resource.rate-limit-behaviour',
    owasp: 'API4:2023 Unrestricted Resource Consumption',
    title: 'Bursts are throttled with 429 + Retry-After, never turn into 5xx, and recover',
    controls: ['availability', 'abuse-resilience'],
    requires: [],
    async run(c) {
      const simulated = c.sim !== null;
      if (c.sim) await c.sim.config({ rateLimit: { enabled: true, rps: 5 } });
      try {
        await c.api.getToken();
        const burst = await Promise.all(
          Array.from({ length: simulated ? 40 : 20 }, () =>
            c.api.call('GET', '/v1/payment-methods'),
          ),
        );
        const limited = burst.filter((r) => r.status === 429);
        const retryAfter = limited.map((r) => Number(header(r, 'retry-after')));
        const out: Assertion[] = [
          ok(
            'the burst never produces a 5xx',
            burst.every((r) => r.status < 500),
            burst
              .filter((r) => r.status >= 500)
              .map((r) => r.status)
              .join(','),
          ),
          ok(
            'every 429 carries a numeric Retry-After ≥ 1',
            retryAfter.every((n) => Number.isFinite(n) && n >= 1),
            retryAfter.join(','),
          ),
          ok(
            'every 429 uses the documented error body (rate_limited)',
            limited.every((r) => errCode(r) === 'rate_limited'),
          ),
          (simulated ? ok : adv)(
            'the limiter engaged under the burst (at least one 429)',
            limited.length > 0,
            `${limited.length}/${burst.length} limited`,
          ),
        ];
        if (limited.length > 0) {
          await sleep((Math.max(...retryAfter) + 0.3) * 1000);
          const after = await c.api.call('GET', '/v1/payment-methods');
          out.push(
            ok(
              'after waiting Retry-After the service recovers (200)',
              after.status === 200,
              `HTTP ${after.status}`,
            ),
          );
        }
        return out;
      } finally {
        if (c.sim) await c.sim.config({ rateLimit: { enabled: true, rps: 1000 } });
      }
    },
  },
  {
    id: 'resource.payload-limits',
    owasp: 'API4:2023 Unrestricted Resource Consumption',
    title: 'Oversized, deeply nested and extreme-length inputs are refused cleanly',
    controls: ['availability', 'input-validation'],
    requires: [],
    async run(c) {
      const t = (n: number): string => 'x'.repeat(n);
      const nested = `${'['.repeat(3000)}${']'.repeat(3000)}`;
      const timed = async (
        name: string,
        p: Promise<ApiResponse>,
      ): Promise<{ name: string; r: ApiResponse; ms: number }> => {
        const t0 = Date.now();
        return { name, r: await p, ms: Date.now() - t0 };
      };
      const cases = await Promise.all([
        timed(
          '600 KB body',
          c.api.call('POST', '/v1/payouts', {
            rawBody: JSON.stringify({ ...c.payout(c.ref()), pad: t(600_000) }),
            key: c.idem(),
          }),
        ),
        timed(
          '3000-deep nesting',
          c.api.call('POST', '/v1/payouts', { rawBody: nested, key: c.idem() }),
        ),
        timed(
          '10 000-char note',
          c.api.call('POST', '/v1/payouts', {
            body: c.payout(c.ref(), { note: t(10_000) }),
            key: c.idem(),
          }),
        ),
        timed(
          '100 000-char reference',
          c.api.call('POST', '/v1/payouts', { body: c.payout(t(100_000)), key: c.idem() }),
        ),
        timed(
          '1 000-char idempotency key',
          c.api.call('POST', '/v1/payouts', { body: c.payout(c.ref()), key: t(1000) }),
        ),
      ]);
      const after = await c.api.call('GET', '/v1/wallet');
      return [
        ...cases.map((x) =>
          ok(
            `${x.name} → refused with 4xx (not 5xx, not accepted)`,
            is4xx(x.r.status),
            `HTTP ${x.r.status}`,
          ),
        ),
        ok(
          'none of them hung (each answered within 15 s)',
          cases.every((x) => x.ms < 15_000),
          cases.map((x) => `${x.ms}ms`).join(','),
        ),
        ok('the service is still healthy afterwards', after.status === 200),
      ];
    },
  },
  {
    id: 'resource.pagination-caps',
    owasp: 'API4:2023 Unrestricted Resource Consumption',
    title: 'List endpoints cap their page size and reject nonsense limits',
    controls: ['availability', 'input-validation'],
    requires: [],
    async run(c) {
      for (let i = 0; i < 3; i++)
        await c.api.call('POST', '/v1/payouts', { body: c.payout(c.ref()), key: c.idem() });
      const huge = await c.api.call('GET', '/v1/transactions?limit=100000');
      const bad = await Promise.all(
        ['-1', '0', 'abc', '1e9'].map((v) => c.api.call('GET', `/v1/transactions?limit=${v}`)),
      );
      const items = (rec(huge.body)['items'] as unknown[] | undefined) ?? [];
      return [
        ok(
          'limit=100000 is refused or clamped (never more than 100 rows)',
          is4xx(huge.status) || (huge.status === 200 && items.length <= 100),
          `HTTP ${huge.status}, ${items.length} rows`,
        ),
        ok(
          'limit=-1, 0, abc and 1e9 are all refused with 4xx',
          bad.every((r) => is4xx(r.status)),
          bad.map((r) => r.status).join(','),
        ),
      ];
    },
  },
  {
    id: 'authz.permission-enforced',
    owasp: 'API5:2023 Broken Function Level Authorization',
    title: 'A read-only credential cannot perform money-moving functions',
    controls: ['access-control', 'least-privilege'],
    requires: ['simulator'],
    async run(c) {
      await c.sim!.config({ permissions: { cli_readonly: ['transactions.read'] } });
      const ro = c.clientFor('cli_readonly')!;
      const ref = c.ref();
      const read = await ro.call('GET', '/v1/wallet');
      const pay = await ro.call('POST', '/v1/payouts', { body: c.payout(ref), key: c.idem() });
      const col = await ro.call('POST', '/v1/collections', {
        body: c.collection(c.ref()),
        key: c.idem(),
      });
      const xfer = await ro.call('POST', '/v1/transfers', {
        body: { reference: c.ref(), handle: 'demo-merchant', amount: '1.00', currency: 'GHS' },
        key: c.idem(),
      });
      return [
        ok('the read-only credential can read (permission granted)', read.status === 200),
        ok(
          'payout → 403 forbidden',
          pay.status === 403 && errCode(pay) === 'forbidden',
          `HTTP ${pay.status}`,
        ),
        ok('collection → 403 forbidden', col.status === 403, `HTTP ${col.status}`),
        ok('transfer → 403 forbidden', xfer.status === 403, `HTTP ${xfer.status}`),
        ok(
          'and the refused payout created nothing',
          (await ro.call('GET', `/v1/payouts/${ref}`)).status === 404,
        ),
      ];
    },
  },
  {
    id: 'flows.limits-bound-automation',
    owasp: 'API6:2023 Unrestricted Access to Sensitive Business Flows',
    title: 'Automated repetition of a money flow is bounded by limits',
    controls: ['fraud-velocity', 'abuse-resilience'],
    requires: [],
    async run(c) {
      if (!c.sim) {
        const l = await c.api.call('GET', '/v1/limits');
        const item = rec(((rec(l.body)['items'] as unknown[] | undefined) ?? [])[0]);
        return [
          ok('limits can be read', l.status === 200),
          adv(
            'a per-transaction and daily limit are configured',
            typeof item['perTransaction'] === 'string' &&
              typeof rec(item['daily'])['limit'] === 'string',
            'an empty limit list means no payment can be made',
          ),
          adv(
            'live velocity testing is not performed (it would spend real sandbox allowance); run it on the simulator',
            true,
          ),
        ];
      }
      await c.sim.config({ limits: { perTransaction: '50.00', daily: '60.00' } });
      try {
        const before = await c.wallet();
        const rs: ApiResponse[] = [];
        for (let i = 0; i < 15; i++)
          rs.push(
            await c.api.call('POST', '/v1/payouts', {
              body: c.payout(c.ref(), { amount: '10.00' }),
              key: c.idem(),
            }),
          );
        const accepted = rs.filter((r) => r.status === 202).length;
        const refused = rs.filter((r) => r.status === 403);
        const after = await c.wallet();
        return [
          ok(
            'no more than the daily limit is accepted (≤6 of 15 payouts of 10.00)',
            accepted <= 6,
            `${accepted} accepted`,
          ),
          ok(
            'the rest are refused with daily_limit_exceeded',
            refused.length > 0 && refused.every((r) => errCode(r) === 'daily_limit_exceeded'),
          ),
          ok(
            'the wallet was debited only for accepted payouts',
            before.available - after.available <= accepted * 1010 + 1,
            `debited ${before.available - after.available}`,
          ),
          ok(
            'a single payment above the per-transaction limit is refused',
            (
              await c.api.call('POST', '/v1/payouts', {
                body: c.payout(c.ref(), { amount: '50.01' }),
                key: c.idem(),
              })
            ).status === 403,
          ),
        ];
      } finally {
        await c.sim.config({ limits: { perTransaction: '50000.00', daily: '1000000.00' } });
      }
    },
  },
  {
    id: 'ssrf.url-fields',
    owasp: 'API7:2023 Server Side Request Forgery',
    title: 'URL-bearing fields refuse internal addresses and non-web schemes',
    controls: ['ssrf', 'input-validation'],
    requires: [],
    async run(c) {
      const hostile = [
        'http://169.254.169.254/latest/meta-data/',
        'http://localhost:8080/admin',
        'http://10.0.0.5/',
        'http://[::1]/',
        'file:///etc/passwd',
        'gopher://127.0.0.1:25/',
      ];
      const rs: { u: string; r: ApiResponse }[] = [];
      for (const u of hostile) {
        rs.push({
          u,
          r: await c.api.call('POST', '/v1/checkouts', {
            body: { reference: c.ref(), amount: '1.00', currency: 'GHS', successUrl: u },
            key: c.idem(),
          }),
        });
      }
      const first = rs[0]!.r;
      if (first.status === 409 || first.status === 403 || first.status === 503) {
        return {
          skip: `hosted checkout is not usable here (HTTP ${first.status}/${errCode(first) ?? '-'}); needs checkout enabled and verification tier 2`,
        };
      }
      const simulated = c.sim !== null;
      const legit = await c.api.call('POST', '/v1/checkouts', {
        body: {
          reference: c.ref(),
          amount: '1.00',
          currency: 'GHS',
          successUrl: 'https://merchant.example/thanks',
        },
        key: c.idem(),
      });
      return [
        ok(
          'no hostile URL causes a 5xx',
          rs.every((x) => x.r.status < 500),
          rs.map((x) => x.r.status).join(','),
        ),
        (simulated ? ok : adv)(
          'internal / non-web URLs are refused (400)',
          rs.every((x) => x.r.status === 400 || x.r.status === 422),
          rs
            .filter((x) => x.r.status < 400)
            .map((x) => x.u)
            .join(', '),
        ),
        ok(
          'a normal https URL is still accepted',
          legit.status === 201 || legit.status === 200,
          `HTTP ${legit.status}`,
        ),
      ];
    },
  },
  {
    id: 'misconfig.headers-tls-cors',
    owasp: 'API8:2023 Security Misconfiguration',
    title: 'Transport and response headers are hardened: no banners, no reflected CORS, modern TLS',
    controls: ['secure-configuration', 'transport-security'],
    requires: [],
    async run(c) {
      const r = await c.api.call('GET', '/v1/wallet');
      const cors = await c.api.call('GET', '/v1/wallet', {
        headers: { origin: 'https://evil.example' },
      });
      const acao = header(cors, 'access-control-allow-origin');
      const acac = header(cors, 'access-control-allow-credentials');
      const server = header(r, 'server');
      const out: Assertion[] = [
        ok('responses are JSON', isJson(r), contentType(r)),
        ok(
          'no X-Powered-By banner',
          header(r, 'x-powered-by') === null,
          header(r, 'x-powered-by') ?? '',
        ),
        ok(
          'the Server header carries no product/version',
          !server || !/\d+\.\d+|express|nginx\/|apache\/|iis/i.test(server),
          server ?? '',
        ),
        ok(
          'an arbitrary Origin is never reflected back',
          acao !== 'https://evil.example',
          acao ?? 'none',
        ),
        ok(
          'credentialed CORS is never combined with a wildcard or reflected origin',
          !(acac === 'true' && (acao === '*' || acao === 'https://evil.example')),
        ),
        adv(
          'authenticated responses are not cacheable (Cache-Control: no-store)',
          /no-store|private/i.test(header(r, 'cache-control') ?? ''),
          header(r, 'cache-control') ?? 'absent',
        ),
        adv('X-Content-Type-Options: nosniff', header(r, 'x-content-type-options') === 'nosniff'),
      ];
      const u = new URL(c.api.baseUrl);
      if (u.protocol === 'https:') {
        out.push(
          adv('Strict-Transport-Security is set', header(r, 'strict-transport-security') !== null),
        );
        try {
          const t = await tlsProbe(u.hostname, Number(u.port || 443));
          out.push(
            ok(
              'TLS 1.2 or newer is negotiated',
              t.protocol === 'TLSv1.2' || t.protocol === 'TLSv1.3',
              t.protocol ?? 'unknown',
            ),
          );
          out.push(
            adv(
              'the certificate is valid for more than 14 more days',
              t.daysLeft > 14,
              `${t.daysLeft} days`,
            ),
          );
        } catch (e) {
          out.push(
            ok(
              'TLS handshake with a valid certificate succeeds',
              false,
              e instanceof Error ? e.message : String(e),
            ),
          );
        }
      } else {
        out.push(
          adv('target is plain http (simulator/local): TLS and HSTS checks do not apply', true),
        );
      }
      return out;
    },
  },
  {
    id: 'misconfig.error-hygiene',
    owasp: 'API8:2023 Security Misconfiguration',
    title: 'Error responses are generic: no stack traces, paths, SQL or infrastructure details',
    controls: ['secure-configuration', 'information-disclosure'],
    requires: [],
    async run(c) {
      const probes: [string, Promise<ApiResponse>][] = [
        [
          'malformed JSON',
          c.api.call('POST', '/v1/payouts', { rawBody: '{"reference": ', key: c.idem() }),
        ],
        ['wrong shape', c.api.call('POST', '/v1/payouts', { rawBody: '[1,2,3]', key: c.idem() })],
        ['unknown route', c.api.call('GET', '/v1/definitely-not-a-route')],
        ['unknown reference', c.api.call('GET', "/v1/payouts/'%20OR%20'1'='1")],
        ['bad query', c.api.call('GET', '/v1/transactions?limit=%00')],
        ['no auth', c.api.call('GET', '/v1/wallet', { token: null })],
        ['bad token', c.api.call('GET', '/v1/wallet', { token: 'x' })],
      ];
      const results = await Promise.all(probes.map(async ([n, p]) => [n, await p] as const));
      const withBody = results.filter(([, r]) => r.status >= 400);
      return [
        ok(
          'every probe is refused with 4xx (none crashes the API)',
          results.every(([, r]) => r.status < 500),
          results.map(([n, r]) => `${n}:${r.status}`).join(' '),
        ),
        ok(
          'no error body contains a stack trace, source path, SQL or connection string',
          withBody.every(([, r]) => leaks(r.body).length === 0),
          withBody
            .filter(([, r]) => leaks(r.body).length > 0)
            .map(([n, r]) => `${n}: ${leaks(r.body).join('/')}`)
            .join('; '),
        ),
        ok(
          'error bodies use the documented {error:{code,message}} shape',
          withBody.every(([, r]) => ErrorBodySchema.safeParse(r.body).success),
          withBody
            .filter(([, r]) => !ErrorBodySchema.safeParse(r.body).success)
            .map(([n]) => n)
            .join(', '),
        ),
        ok(
          'error responses are JSON, not an HTML/stack page',
          withBody.every(([, r]) => isJson(r)),
        ),
        adv(
          'every response carries a Request-Id for support',
          results.every(([, r]) => r.requestId !== null),
        ),
      ];
    },
  },
  {
    id: 'misconfig.methods-and-debug-paths',
    owasp: 'API8:2023 Security Misconfiguration',
    title: 'Unexpected HTTP methods and common debug/admin paths are not exposed',
    controls: ['secure-configuration', 'attack-surface'],
    requires: [],
    async run(c) {
      const methods = await Promise.all(
        [
          ['PATCH', '/v1/wallet'],
          ['DELETE', '/v1/wallet'],
          ['PUT', '/v1/payouts'],
          ['DELETE', '/v1/payouts/x'],
        ].map(
          async ([m, p]) =>
            [
              `${m} ${p}`,
              await c.api.call(m!, p!, {
                key: m === 'GET' ? undefined : c.idem(),
                body: m === 'DELETE' ? undefined : {},
              }),
            ] as const,
        ),
      );
      const must = ['/debug/vars', '/actuator/env', '/.env', '/.git/config', '/server-status'];
      const should = ['/metrics', '/swagger.json', '/openapi.json', '/admin', '/graphql'];
      const probe = async (path: string): Promise<[string, ApiResponse]> => [
        path,
        await c.api.call('GET', path, { token: null }),
      ];
      const hard = await Promise.all(must.map(probe));
      const soft = await Promise.all(should.map(probe));
      const exposed = (xs: [string, ApiResponse][]): string[] =>
        xs.filter(([, r]) => r.status === 200).map(([p]) => p);
      return [
        ok(
          'write methods on read-only resources are refused (4xx, never 2xx/5xx)',
          methods.every(([, r]) => is4xx(r.status)),
          methods.map(([n, r]) => `${n}:${r.status}`).join(' '),
        ),
        ok(
          'debug / secret-bearing paths return nothing',
          exposed(hard).length === 0,
          exposed(hard).join(', '),
        ),
        ok(
          'no probed path leaks credentials or infrastructure',
          [...hard, ...soft].every(([, r]) => leaks(r.body).length === 0),
        ),
        adv(
          'metrics / API-docs / admin / graphql paths are not publicly served',
          exposed(soft).length === 0,
          exposed(soft).join(', '),
        ),
      ];
    },
  },
  {
    id: 'inventory.undocumented-paths',
    owasp: 'API9:2023 Improper Inventory Management',
    title: 'Only documented API versions and paths are served — no legacy or shadow APIs',
    controls: ['api-inventory', 'attack-surface'],
    requires: [],
    async run(c) {
      const paths = [
        '/v0/wallet',
        '/v2/wallet',
        '/api/v1/wallet',
        '/v1/beta/wallet',
        '/v1/internal/ledger',
        '/v1/admin/users',
        '/v1/wallet/../admin',
      ];
      const unauth = await Promise.all(
        paths.map(async (p) => [p, await c.api.call('GET', p, { token: null })] as const),
      );
      const auth = await Promise.all(
        paths.map(async (p) => [p, await c.api.call('GET', p)] as const),
      );
      const open = (xs: readonly (readonly [string, ApiResponse])[]): string[] =>
        xs.filter(([, r]) => r.status === 200).map(([p]) => p);
      return [
        ok(
          'no undocumented path answers 200 WITHOUT authentication',
          open(unauth).length === 0,
          open(unauth).join(', '),
        ),
        ok(
          'no undocumented path answers 200 WITH authentication (shadow API)',
          open(auth).length === 0,
          open(auth).join(', '),
        ),
        ok(
          'none of them crashes the server',
          [...unauth, ...auth].every(([, r]) => r.status < 500),
        ),
      ];
    },
  },
  {
    id: 'consumption.schema-conformance',
    owasp: 'API10:2023 Unsafe Consumption of APIs',
    title: 'Real responses match the documented contract — drift is caught before it breaks us',
    controls: ['contract-integrity', 'data-integrity'],
    requires: [],
    async run(c) {
      const ref = c.ref();
      const create = await c.api.call('POST', '/v1/payouts', {
        body: c.payout(ref),
        key: c.idem(),
      });
      const get = await c.api.call('GET', `/v1/payouts/${ref}`);
      const wallet = await c.api.call('GET', '/v1/wallet');
      const batch = await c.api.call('POST', '/v1/payout-batches', {
        body: { reference: c.ref(), items: [c.payout(c.ref())] },
        key: c.idem(),
      });
      const e401 = await c.api.call('GET', '/v1/wallet', { token: null });
      const e404 = await c.api.call('GET', `/v1/payouts/${c.ref()}`);
      const e400 = await c.api.call('POST', '/v1/payouts', {
        body: c.payout(c.ref(), { amount: 'oops' }),
        key: c.idem(),
      });
      const sm = (
        r: ApiResponse,
        schema: { safeParse: (v: unknown) => { success: boolean } },
      ): boolean => schema.safeParse(r.body).success;
      const amounts = [
        rec(get.body)['amount'],
        rec(get.body)['fee'],
        rec(get.body)['payerAmount'],
      ].filter((x) => x !== undefined);
      return [
        ok(
          'POST /v1/payouts (202) matches the payment schema',
          create.status === 202 && sm(create, MoneyMovementSchema),
        ),
        ok(
          'GET /v1/payouts/{ref} matches the payment schema',
          get.status === 200 && sm(get, MoneyMovementSchema),
        ),
        ok(
          'GET /v1/wallet matches the wallet schema',
          wallet.status === 200 && sm(wallet, WalletResponseSchema),
        ),
        ok(
          'POST /v1/payout-batches matches the batch schema',
          batch.status === 200 && sm(batch, BatchResponseSchema),
        ),
        ok(
          '401 / 404 / 400 all use the documented error body',
          [e401, e404, e400].every((r) => sm(r, ErrorBodySchema)),
          [e401.status, e404.status, e400.status].join(','),
        ),
        ok(
          'amounts are decimal STRINGS in major units, never JSON numbers',
          amounts.length > 0 &&
            amounts.every((a) => typeof a === 'string' && /^\d+\.\d{2}$/.test(a)),
        ),
        ok(
          'the payment status is a string we can treat as in-progress if unknown',
          typeof rec(get.body)['status'] === 'string',
        ),
      ];
    },
  },
  {
    id: 'input.hostile-strings-inert',
    owasp: 'API8:2023 Security Misconfiguration (injection robustness)',
    title: 'Injection-style strings are handled as inert data: no 5xx, no mangling, no execution',
    controls: ['input-validation', 'injection'],
    requires: [],
    async run(c) {
      const notes = [
        "'; DROP TABLE payouts;--",
        '<script>alert(1)</script>',
        '${jndi:ldap://127.0.0.1/x}',
        '{{7*7}}',
        '../../../etc/passwd',
        '%00%0d%0a',
        '𝕳𝖊𝖑𝖑𝖔 ✓',
        '‮evil',
      ];
      const out: Assertion[] = [];
      for (const note of notes) {
        const ref = c.ref();
        const r = await c.api.call('POST', '/v1/payouts', {
          body: c.payout(ref, { note }),
          key: c.idem(),
        });
        const okStatus = [202, 400, 422].includes(r.status);
        let roundTrip = true;
        if (r.status === 202) {
          const back = await c.api.call('GET', `/v1/payouts/${ref}`);
          roundTrip =
            back.status === 200 &&
            (rec(back.body)['note'] === undefined || rec(back.body)['note'] === note);
        }
        out.push(
          ok(
            `note ${JSON.stringify(note).slice(0, 34)} → 202/400/422, stored verbatim or refused`,
            okStatus && roundTrip && isJson(r),
            `HTTP ${r.status}`,
          ),
        );
      }
      const control = await c.api.call('POST', '/v1/payouts', {
        body: c.payout(c.ref(), { note: 'bell\u0007char' }),
        key: c.idem(),
      });
      const sqlRef = await c.api.call('POST', '/v1/payouts', {
        body: c.payout("x' OR '1'='1"),
        key: c.idem(),
      });
      const sqlParty = await c.api.call('POST', '/v1/payouts', {
        body: c.payout(c.ref(), { destination: { type: 'msisdn', value: "233000000001'; --" } }),
        key: c.idem(),
      });
      out.push(
        ok(
          'a control character in note is refused (documented: no control characters)',
          control.status === 400 || control.status === 422,
          `HTTP ${control.status}`,
        ),
      );
      out.push(
        ok(
          'a SQL-looking reference is refused by the reference pattern (400)',
          sqlRef.status === 400 || sqlRef.status === 422,
          `HTTP ${sqlRef.status}`,
        ),
      );
      out.push(
        ok(
          'a SQL-looking destination never causes a 5xx',
          sqlParty.status < 500,
          `HTTP ${sqlParty.status}`,
        ),
      );
      return out;
    },
  },
];

export const SECURITY_CHECK_IDS = SECURITY_CHECKS.map((c) => c.id);
