import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECKS } from './checks.js';
import { SECURITY_CHECKS } from './security.js';
import { runSuite, summarize, type CheckResult } from './suite.js';

/**
 * A stand-in for a live iSmartPay sandbox whose test key can only touch
 * collections — the exact situation of the first live run. Everything else is
 * refused with the real "does not have the X permission" message.
 */
const claims = Buffer.from(
  JSON.stringify({ scopes: ['collections.read', 'collections.write'] }),
).toString('base64url');
const JWT = `h.${claims}.s`;

let server: Server;
let base: string;
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0]!;
    hits.push(`${req.method} ${url}`);
    req.resume();
    req.on('end', () => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      };
      if (url === '/v1/oauth/token') return send(200, { access_token: JWT, expires_in: 300 });
      if (url.startsWith('/v1/collections'))
        return send(202, { reference: 'x', status: 'accepted' });
      const perm = url.startsWith('/v1/payout') ? 'disbursements.write' : 'transactions.read';
      send(403, {
        error: {
          code: 'forbidden',
          message: `the credential does not have the ${perm} permission`,
        },
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const options = () => ({
  client: { baseUrl: base, tokenUrl: `${base}/v1/oauth/token`, clientId: 'c', clientSecret: 's' },
  salt: 'perm',
  settleTimeoutMs: 2_000,
});

describe('a test key that lacks permissions', () => {
  it('blocks the affected checks instead of failing them, and says which permission is missing', async () => {
    hits.length = 0;
    const report = await runSuite({
      ...options(),
      only: ['idem.sequential-replay', 'payout.fixture-delivered', 'status.list-matches-detail'],
    });
    for (const r of report.results) {
      expect(r.status, r.id).toBe('SKIPPED');
      expect(r.blockedBy, r.id).toBeTruthy();
      expect(r.note).toMatch(/BLOCKED/);
    }
    expect(report.summary.failed).toBe(0);
    expect(report.summary.verdict).toBe('INCONCLUSIVE');
    expect(report.summary.blocked).toBe(3);
    expect(report.summary.missingPermissions).toContain('disbursements.write');
    expect(report.keyScopes).toEqual(['collections.read', 'collections.write']);
  });

  it('does not hammer an endpoint it already knows is refused', async () => {
    hits.length = 0;
    await runSuite({
      ...options(),
      only: ['idem.concurrent-twins', 'idem.key-reuse-different-body'],
    });
    const payoutPosts = hits.filter((h) => h === 'POST /v1/payouts').length;
    // the concurrent check fires up to 10 in parallel before any answer; after that, none.
    expect(payoutPosts).toBeLessThanOrEqual(11);
  });

  it('works for the security suite too', async () => {
    const report = await runSuite({
      ...options(),
      pool: SECURITY_CHECKS,
      only: ['authz.permission-enforced'],
    });
    expect(['SKIPPED', 'PASS', 'FAIL']).toContain(report.results[0]!.status);
  });
});

describe('summarize', () => {
  const r = (status: CheckResult['status'], blockedBy?: string): CheckResult => ({
    id: `c-${Math.random()}`,
    title: 't',
    controls: [],
    status,
    assertions: [],
    warnings: 0,
    durationMs: 0,
    evidence: [],
    ...(blockedBy ? { blockedBy } : {}),
  });

  it('a genuine failure still fails the suite even when other checks were blocked', () => {
    expect(summarize([r('PASS'), r('FAIL'), r('SKIPPED', 'x.write')]).verdict).toBe('FAIL');
  });
  it('blocked checks make an otherwise-clean suite inconclusive, never a pass', () => {
    expect(summarize([r('PASS'), r('SKIPPED', 'x.write')]).verdict).toBe('INCONCLUSIVE');
  });
  it('ordinary skips (simulator-only) do not change a pass', () => {
    expect(summarize([r('PASS'), r('SKIPPED')]).verdict).toBe('PASS');
  });
  it('lists each missing permission once', () => {
    const s = summarize([r('SKIPPED', 'b'), r('SKIPPED', 'a'), r('SKIPPED', 'a')]);
    expect(s.missingPermissions).toEqual(['a', 'b']);
    expect(s.blocked).toBe(3);
  });
  it('knows the correctness checks exist', () => {
    expect(CHECKS.length).toBe(16);
  });
});
