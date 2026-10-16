import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSimulatorApp } from '../simulator/app.js';
import { SECURITY_CHECKS, SECURITY_CHECK_IDS } from './security.js';
import { applicableChecks, runSuite, type SuiteOptions, type SuiteReport } from './suite.js';

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
      clientId: 'cli_sec',
      clientSecret: 'secret_sec',
    },
    simBaseUrl: base,
    pool: SECURITY_CHECKS,
    salt: `s${++n}`,
    ...over,
  });

const statusOf = (r: SuiteReport, id: string): string =>
  r.results.find((x) => x.id === id)?.status ?? 'MISSING';
const detail = (r: SuiteReport): string[] =>
  r.results
    .filter((x) => x.status === 'FAIL' || x.status === 'ERROR')
    .map(
      (x) =>
        `${x.id}: ${
          x.assertions
            .filter((a) => !a.pass && !a.advisory)
            .map((a) => `${a.name} [${a.detail ?? ''}]`)
            .join('; ') || x.note
        }`,
    );

/** Plant ONE defect, run ONE check, expect it to go red — and the same check green when the defect is absent. */
async function mutate(
  weak: Record<string, boolean>,
  id: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  sim.patchConfig({ ...extra, weak });
  const bad = await run({ only: [id] });
  expect(statusOf(bad, id), `${id} should FAIL with ${JSON.stringify(weak)}`).toBe('FAIL');
  sim.reset({ resolveDelayMs: 20, openingBalance: '100000.00' });
  const good = await run({ only: [id] });
  expect(
    statusOf(good, id),
    `${id} should PASS on a correct server: ${detail(good).join(' | ')}`,
  ).toBe('PASS');
}

describe('security suite — a hardened implementation', () => {
  it('passes every check, with every OWASP category covered', async () => {
    const report = await run();
    expect(detail(report)).toEqual([]);
    expect(report.summary.verdict).toBe('PASS');
    expect(report.summary.skipped).toBe(0);
    expect(report.summary.total).toBe(SECURITY_CHECKS.length);
    const categories = new Set(report.results.map((r) => r.owasp?.slice(0, 5)));
    for (const c of [
      'API1:',
      'API2:',
      'API3:',
      'API4:',
      'API5:',
      'API6:',
      'API7:',
      'API8:',
      'API9:',
      'API10',
    ]) {
      expect(categories.has(c), `missing ${c}`).toBe(true);
    }
  }, 180_000);

  it('reports advisory findings as warnings without failing the verdict', async () => {
    const report = await run({ only: ['misconfig.headers-tls-cors'] });
    const r = report.results[0]!;
    expect(r.status).toBe('PASS');
    expect(r.warnings).toBeGreaterThan(0); // e.g. no Cache-Control: no-store on the simulator
    expect(r.assertions.some((a) => a.advisory && !a.pass)).toBe(true);
    expect(report.summary.warnings).toBe(r.warnings);
  });

  it('skips (never fakes) a check whose prerequisite is missing on a live target', async () => {
    // No simulator → no derived second account, and no configured one.
    const live = applicableChecks(
      false,
      ['bola.cross-account-access', 'authz.permission-enforced'],
      SECURITY_CHECKS,
    );
    expect(live.map((c) => c.id)).toEqual(['bola.cross-account-access']); // sim-only check filtered out up front
    const report = await run({
      simBaseUrl: undefined,
      only: ['bola.cross-account-access'],
      settleTimeoutMs: 100,
    });
    expect(report.results[0]).toMatchObject({ status: 'SKIPPED' });
    expect(report.results[0]!.note).toContain('SECOND account');
  });

  it('every check names an OWASP category and at least one control tag', () => {
    expect(new Set(SECURITY_CHECK_IDS).size).toBe(SECURITY_CHECKS.length);
    for (const c of SECURITY_CHECKS) {
      expect(c.owasp, c.id).toMatch(/^API\d{1,2}:2023/);
      expect(c.controls.length, c.id).toBeGreaterThan(0);
    }
  });
});

describe('security suite — it catches each planted defect (mutation tests)', () => {
  it(
    'API1 BOLA: another account can read my payments',
    () => mutate({ bola: true }, 'bola.cross-account-access'),
    90_000,
  );
  it(
    'API2: the token endpoint hands tokens to anyone',
    () => mutate({ openTokenEndpoint: true }, 'auth.bogus-client-rejected'),
    90_000,
  );
  it(
    'API2: tokens never expire',
    () => mutate({ tokensNeverExpire: true }, 'auth.token-expiry-enforced'),
    90_000,
  );
  it(
    'API3: mass assignment lets a client set status and fee',
    () => mutate({ massAssignment: true }, 'bopla.mass-assignment-rejected'),
    90_000,
  );
  it(
    'API3: internal fields leak into responses',
    () => mutate({ leakFields: true }, 'bopla.response-allowlist'),
    90_000,
  );
  it(
    'API4: there is no rate limiting',
    () => mutate({ noRateLimit: true }, 'resource.rate-limit-behaviour'),
    90_000,
  );
  it(
    'API4: the page-size cap is not enforced',
    () => mutate({ ignorePageCaps: true }, 'resource.pagination-caps'),
    90_000,
  );
  it(
    'API5: permissions are not enforced',
    () => mutate({ ignorePermissions: true }, 'authz.permission-enforced'),
    90_000,
  );
  it(
    'API6: payment limits are not enforced',
    () => mutate({ ignoreLimits: true }, 'flows.limits-bound-automation'),
    90_000,
  );
  it(
    'API7: redirect URLs may target internal addresses',
    () => mutate({ acceptAnyUrl: true }, 'ssrf.url-fields'),
    90_000,
  );
  it(
    'API8: reflected CORS origin',
    () => mutate({ reflectCors: true }, 'misconfig.headers-tls-cors'),
    90_000,
  );
  it(
    'API8: server banner leaked',
    () => mutate({ leakBanner: true }, 'misconfig.headers-tls-cors'),
    90_000,
  );
  it(
    'API8: stack traces in error bodies',
    () => mutate({ verboseErrors: true }, 'misconfig.error-hygiene'),
    90_000,
  );
  it(
    'API8: debug endpoints are reachable',
    () => mutate({ exposeDebug: true }, 'misconfig.methods-and-debug-paths'),
    90_000,
  );
  it(
    'API9: a legacy unauthenticated version is still served',
    () => mutate({ legacyVersions: true }, 'inventory.undocumented-paths'),
    90_000,
  );
  it(
    'API10: the response contract drifts (numbers instead of decimal strings)',
    () => mutate({ numberAmounts: true }, 'consumption.schema-conformance'),
    90_000,
  );
  it(
    'robustness: a quote in input crashes the handler',
    () => mutate({ crashOnQuote: true }, 'input.hostile-strings-inert'),
    90_000,
  );
});
