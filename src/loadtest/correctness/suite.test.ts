import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSimulatorApp } from '../simulator/app.js';
import { CHECKS, CHECK_IDS } from './checks.js';
import { applicableChecks, runSuite, type SuiteReport, type SuiteOptions } from './suite.js';

const { app, sim } = createSimulatorApp();
let server: Server;
let base: string;
let n = 0;

beforeAll(async () => {
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  sim.reset({ resolveDelayMs: 20, openingBalance: '100000.00' });
});

const run = (over: Partial<SuiteOptions> = {}): Promise<SuiteReport> =>
  runSuite({
    client: {
      baseUrl: base,
      tokenUrl: `${base}/v1/oauth/token`,
      clientId: 'cli_suite',
      clientSecret: 'secret_suite',
    },
    simBaseUrl: base,
    salt: `t${++n}`,
    ...over,
  });

const status = (r: SuiteReport, id: string): string =>
  r.results.find((x) => x.id === id)?.status ?? 'MISSING';
const failing = (r: SuiteReport): string[] =>
  r.results
    .filter((x) => x.status === 'FAIL' || x.status === 'ERROR')
    .map(
      (x) =>
        `${x.id}: ${
          x.assertions
            .filter((a) => !a.pass)
            .map((a) => `${a.name} [${a.detail ?? ''}]`)
            .join('; ') || x.note
        }`,
    );

describe('correctness suite — a correct implementation', () => {
  it('passes every check against the contract-accurate simulator', async () => {
    const report = await run();
    expect(failing(report)).toEqual([]);
    expect(report.summary.verdict).toBe('PASS');
    expect(report.summary.total).toBe(CHECKS.filter((c) => !c.liveOnly).length);
    expect(report.summary.skipped).toBe(0);
    expect(report.mode).toBe('simulator');
    expect(report.results.every((r) => r.controls.length > 0)).toBe(true);
  }, 120_000);

  it('records evidence per check without leaking bodies or secrets', async () => {
    const report = await run({ only: ['idem.sequential-replay'] });
    const ev = report.results[0]!.evidence;
    expect(ev.length).toBeGreaterThan(2);
    expect(ev.every((e) => typeof e.status === 'number' && e.method && e.path)).toBe(true);
    expect(ev.some((e) => e.idempotencyKey?.startsWith('IDEM-TST-'))).toBe(true);
    const text = JSON.stringify(report);
    expect(text).not.toContain('secret_suite');
    expect(text).not.toMatch(/sim_[0-9a-f]{20}/); // no bearer tokens
  });

  it('skips simulator-only checks against a live target instead of failing them', () => {
    const live = applicableChecks(false).map((c) => c.id);
    expect(live).not.toContain('sim.concurrent-overspend');
    expect(live).not.toContain('webhook.signature-duplicates-order');
    expect(live).toContain('payout.failure-refunds-wallet');
    expect(CHECK_IDS.length).toBe(new Set(CHECK_IDS).size);
  });

  it('stops between checks when asked (kill switch / abort)', async () => {
    let calls = 0;
    const report = await run({
      only: ['idem.sequential-replay', 'idem.concurrent-twins', 'auth.invalid-token-rejected'],
      shouldStop: () => Promise.resolve(++calls > 1 ? 'kill switch engaged' : null),
    });
    expect(report.results.map((r) => r.status)).toEqual(['PASS', 'SKIPPED', 'SKIPPED']);
    expect(report.results[1]!.note).toContain('kill switch');
  }, 60_000);
});

describe('correctness suite — it catches real defects (mutation tests)', () => {
  it('detects broken idempotency', async () => {
    sim.patchConfig({ idempotency: 'broken' });
    const r = await run({
      only: [
        'idem.sequential-replay',
        'idem.concurrent-twins',
        'reference.duplicate-rules',
        'sim.ledger-reconciliation',
      ],
    });
    expect(status(r, 'idem.sequential-replay')).toBe('FAIL');
    expect(status(r, 'idem.concurrent-twins')).toBe('FAIL');
    expect(status(r, 'reference.duplicate-rules')).toBe('FAIL');
    expect(status(r, 'sim.ledger-reconciliation')).toBe('FAIL'); // duplicate effects show up in the ledger
    expect(r.summary.verdict).toBe('FAIL');
  }, 60_000);

  it('detects a concurrent-overspend race (lost update)', async () => {
    sim.patchConfig({ raceBug: true, raceWindowMs: 15 });
    const r = await run({ only: ['sim.concurrent-overspend', 'sim.ledger-reconciliation'] });
    expect(status(r, 'sim.concurrent-overspend')).toBe('FAIL');
    expect(status(r, 'sim.ledger-reconciliation')).toBe('FAIL');
  }, 60_000);

  it('detects a server that accepts any bearer token', async () => {
    sim.patchConfig({ weak: { acceptAnyToken: true } });
    const r = await run({ only: ['auth.invalid-token-rejected'] });
    expect(status(r, 'auth.invalid-token-rejected')).toBe('FAIL');
  }, 60_000);

  it('detects a receiver that cannot authenticate webhooks (wrong secret)', async () => {
    const r = await run({
      only: ['webhook.signature-duplicates-order'],
      receiverSecretOverride: 'a-different-secret',
    });
    expect(status(r, 'webhook.signature-duplicates-order')).toBe('FAIL');
    expect(
      r.results[0]!.assertions.find((a) =>
        a.name.startsWith('every delivery has a valid signature'),
      )?.pass,
    ).toBe(false);
  }, 60_000);

  it('detects a payout failure that does not refund the wallet', async () => {
    // Make the simulator keep funds reserved after a failure by stalling payouts in review.
    sim.patchConfig({ payoutReviewThreshold: '1.00' });
    const r = await run({ only: ['payout.fixture-delivered'], settleTimeoutMs: 600 });
    expect(status(r, 'payout.fixture-delivered')).toBe('FAIL');
  }, 60_000);

  it('reports a thrown error as ERROR, not a pass', async () => {
    const r = await run({
      client: {
        baseUrl: base,
        tokenUrl: `${base}/v1/oauth/token`,
        clientId: 'live_oops',
        clientSecret: 'x',
      },
      only: ['idem.sequential-replay'],
    });
    expect(status(r, 'idem.sequential-replay')).toBe('ERROR');
    expect(r.results[0]!.note).toContain('Token request failed');
    expect(r.summary.verdict).toBe('FAIL');
  });
});
