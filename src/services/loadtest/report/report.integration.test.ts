import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDbHealth, closePool, query } from '../../../lib/db.js';
import { PlanConfigSchema } from '../../../domain/load-plan.js';
import { expectedRequests } from '../../../domain/load-slo.js';
import { createSimulatorApp } from '../../../loadtest/simulator/app.js';
import { CHECKS } from '../../../loadtest/correctness/checks.js';
import { SECURITY_CHECKS } from '../../../loadtest/correctness/security.js';
import { runSuite, type SuiteReport } from '../../../loadtest/correctness/suite.js';
import { renderCsv, renderHtml, renderPdf, renderXlsx } from './exporters.js';
import {
  buildLoadRunReport,
  buildReadinessReport,
  buildSuiteReport,
  listReports,
} from './report.service.js';

const dbUp = (await checkDbHealth()).ok;
const { app: simApp, sim } = createSimulatorApp();

let server: Server;
let sandboxId: string;
let mockId: string;
let correctness: SuiteReport;
let security: SuiteReport;
let liveCorrectness: SuiteReport;

const summary = (over: Record<string, unknown> = {}) => ({
  totalRequests: 900,
  failedRequests: 0,
  errorRate: 0,
  statusCounts: { '202': 900 },
  errorClasses: {
    server5xx: 0,
    rateLimited429: 0,
    client4xx: 0,
    networkOrTimeout: 0,
    unexpectedOther: 0,
  },
  latencyMs: { avg: 300, p50: 250, p90: 500, p95: 640, p99: 900, max: 1500 },
  achievedAvgRps: 9,
  peakRps: 11,
  maxSustainedRps: 11,
  droppedIterations: 0,
  generatorSaturated: false,
  authRequests: 2,
  activeSeconds: 100,
  ...over,
});

const cfg = (over: Record<string, unknown> = {}) =>
  PlanConfigSchema.parse({
    profile: 'LOAD',
    method: 'POST',
    path: '/v1/payouts',
    moneyMoving: true,
    targetRps: 10,
    durationSeconds: 100,
    maxVus: 50,
    packId: 'payouts-momo-telecel',
    ...over,
  });

async function addPlan(apiId: string, name: string, config = cfg()): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO load_test_plans (api_id, name, profile, config) VALUES ($1,$2,$3,$4) RETURNING id`,
    [apiId, name, config.profile, JSON.stringify(config)],
  );
  return rows[0]!.id;
}

async function addRun(o: {
  apiId: string;
  planId: string;
  config?: ReturnType<typeof cfg>;
  status?: string;
  cls?: string;
  summary?: unknown;
  reason?: string;
  ageDays?: number;
}): Promise<string> {
  const config = o.config ?? cfg();
  const fin = new Date(Date.now() - (o.ageDays ?? 0) * 86_400_000);
  const start = new Date(fin.getTime() - 100_000);
  const { rows } = await query<{ id: string }>(
    `INSERT INTO load_test_runs (plan_id, api_id, status, plan_snapshot, effective_class, summary, finished_reason, k6_version, worker_id, queued_at, started_at, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'k6 v2.3.0',$8,$9,$10,$11) RETURNING id`,
    [
      o.planId,
      o.apiId,
      o.status ?? 'COMPLETED',
      JSON.stringify({
        config,
        target: {
          name: 'T',
          url: 'https://stg.example',
          isMoneyMoving: false,
          environment: 'sandbox',
        },
        peakRps: 10,
      }),
      o.cls ?? 'SANDBOX',
      JSON.stringify(o.summary ?? summary()),
      o.reason ?? 'completed',
      'w1',
      new Date(start.getTime() - 5000),
      start,
      fin,
    ],
  );
  await query(
    `INSERT INTO load_test_metrics (run_id, bucket_start, requests, failures, rps, avg_ms, p50_ms, p95_ms, p99_ms, max_ms, status_counts)
               SELECT $1, $2::timestamptz + (g || ' seconds')::interval, 50, 0, 10, 300, 250, 640, 900, 1500, '{"202":50}'::jsonb FROM generate_series(0, 95, 5) g`,
    [rows[0]!.id, start],
  );
  return rows[0]!.id;
}

async function addSuite(
  apiId: string,
  suite: 'correctness' | 'security',
  report: SuiteReport,
  o: { cls?: string; verdict?: 'PASS' | 'FAIL'; clean?: boolean; ageDays?: number } = {},
): Promise<string> {
  const sum = {
    ...report.summary,
    ...(o.verdict ? { verdict: o.verdict } : {}),
    ...(o.clean ? { warnings: 0, skipped: 0 } : {}),
  };
  const fin = new Date(Date.now() - (o.ageDays ?? 0) * 86_400_000);
  const { rows } = await query<{ id: string }>(
    `INSERT INTO load_test_correctness_runs (api_id, status, suite, mode, effective_class, results, summary, queued_at, started_at, finished_at)
     VALUES ($1,'COMPLETED',$2,'simulator',$3,$4,$5,$6,$6,$6) RETURNING id`,
    [apiId, suite, o.cls ?? 'SANDBOX', JSON.stringify(report.results), JSON.stringify(sum), fin],
  );
  return rows[0]!.id;
}

async function resetData(): Promise<void> {
  await query(`DELETE FROM load_test_plans`);
  await query(`DELETE FROM load_test_correctness_runs`);
}

describe.skipIf(!dbUp)('report builder (DB + real suite results)', () => {
  beforeAll(async () => {
    server = createServer(simApp);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    sim.reset({ resolveDelayMs: 20, openingBalance: '100000.00' });
    const client = {
      baseUrl: base,
      tokenUrl: `${base}/v1/oauth/token`,
      clientId: 'cli_rep',
      clientSecret: 'secret_rep',
    };
    correctness = await (async () => {
      const r = await runSuite({ client, simBaseUrl: base, salt: 'rc1' });
      return { ...({} as SuiteReport), ...r };
    })();
    security = await (async () => {
      sim.reset({ resolveDelayMs: 20, openingBalance: '100000.00' });
      return await runSuite({
        client,
        simBaseUrl: base,
        pool: SECURITY_CHECKS,
        salt: 'rs1',
      });
    })();
    sim.reset({ resolveDelayMs: 20, openingBalance: '100000.00' });
    // "Live" mode: no control plane, so simulator-only checks are SKIPPED and become coverage gaps.
    liveCorrectness = await runSuite({
      client,
      salt: 'rl1',
      settleTimeoutMs: 5000,
    });

    await resetData();
    await query(`DELETE FROM monitored_apis WHERE name LIKE 'lt-rep-%'`);
    const mk = async (name: string, url: string): Promise<string> =>
      (
        await query<{ id: string }>(
          `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron, environment) VALUES ($1,'internal','LOW',$2,'*/5 * * * *','sandbox') RETURNING id`,
          [name, url],
        )
      ).rows[0]!.id;
    sandboxId = await mk('lt-rep-sandbox', 'https://stgdeveloper-api.ismartghana.com');
    mockId = await mk('lt-rep-mock', base);
  }, 240_000);

  afterAll(async () => {
    await resetData();
    await query(`DELETE FROM monitored_apis WHERE name LIKE 'lt-rep-%'`);
    await new Promise((r) => server.close(r));
    await closePool();
  });

  // run in a fixed order: each test starts from a clean slate
  const fresh = resetData;

  it('PASS: a plain-language GO report with the full section set', async () => {
    await fresh();
    const planId = await addPlan(sandboxId, 'Payout load <img src=x onerror=alert(1)>');
    const id = await addRun({ apiId: sandboxId, planId });
    const r = await buildLoadRunReport(id);

    expect(r.executive).toMatchObject({ verdict: 'PASS', decision: 'GO' });
    expect(r.executive.headline).toContain('handled 900 requests');
    expect(r.executive.headline).toContain('iSmartPay sandbox');
    expect(r.executive.keyNumbers.map((k) => k.label)).toContain('Typical-worst speed (P95)');
    expect(r.tested.shape).toMatch(
      /^A steady load at the expected busy-time rate: ramped up to 10\/s over 10s/,
    );
    expect(r.tested.scenario).toContain('Mobile-money payout (Telecel)');
    expect(r.results.slo.length).toBeGreaterThanOrEqual(8);
    expect(r.results.series.length).toBeGreaterThan(10);
    expect(r.logs.timeline.map((e) => e.event)).toEqual(
      expect.arrayContaining(['queued', 'started', 'completed']),
    );
    expect(r.logs.reproduce[0]).toContain(planId);
    expect(r.moneySafety).toBeNull(); // no suite run yet → shown as unverified, not hidden
    expect(r.readiness.status).toBe('INCOMPLETE');
    expect(r.trend.filter((t) => t.current)).toHaveLength(1);
    expect(Object.keys(r.glossary)).toContain('P95');
  });

  it('FAIL / INCONCLUSIVE / guardrail verdicts map to the right decision', async () => {
    await fresh();
    const planId = await addPlan(sandboxId, 'p');
    const slow = await addRun({
      apiId: sandboxId,
      planId,
      summary: summary({
        latencyMs: { avg: 3000, p50: 3000, p90: 6000, p95: 9000, p99: 14000, max: 20000 },
        errorClasses: {
          server5xx: 80,
          rateLimited429: 0,
          client4xx: 0,
          networkOrTimeout: 10,
          unexpectedOther: 0,
        },
      }),
    });
    const killed = await addRun({
      apiId: sandboxId,
      planId,
      status: 'ABORTED',
      reason: 'kill switch engaged: drill',
    });
    const guard = await addRun({
      apiId: sandboxId,
      planId,
      status: 'ABORTED',
      reason: 'guardrail: server failure rate 61.0% over 120 requests in 30s exceeded 25%',
    });

    const a = await buildLoadRunReport(slow);
    expect([a.executive.verdict, a.executive.decision]).toEqual(['FAIL', 'NO_GO']);
    expect(a.findings[0]).toMatchObject({ severity: 'CRITICAL', source: 'performance' });
    expect(a.executive.topRisks.length).toBeGreaterThan(0);

    const b = await buildLoadRunReport(killed);
    expect([b.executive.verdict, b.executive.decision]).toEqual(['INCONCLUSIVE', 'RE_RUN']);
    expect(b.executive.headline).toContain('inconclusive');

    const c = await buildLoadRunReport(guard);
    expect(c.executive.verdict).toBe('FAIL');
    expect(c.executive.headline).toContain('began failing under load');
  });

  it('exports: escaped HTML, valid XLSX, safe CSV, real PDF', async () => {
    await fresh();
    const planId = await addPlan(sandboxId, 'Payout load <img src=x onerror=alert(1)>');
    const runId = await addRun({ apiId: sandboxId, planId, cls: 'MOCK' });
    await addSuite(sandboxId, 'correctness', correctness, { cls: 'MOCK' });
    const r = await buildLoadRunReport(runId);

    const html = renderHtml(r);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('<img src=x'); // the hostile plan name is inert text
    expect(html).toContain('Simulator evidence');
    expect(html).toContain('<svg');
    expect(html).toContain('Summary for everyone');
    expect(html).toContain('Money safety (latest correctness run)');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await renderXlsx(r)) as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(
      expect.arrayContaining(['Summary', 'Objectives', 'Time series', 'Trend', 'Event log']),
    );

    expect(renderCsv(r).split('\n')[0]).toBe('objective,target,actual,status,meaning');
    expect(renderCsv(r, 'Time series').split('\n').length).toBeGreaterThan(10);
    expect((await renderPdf(r)).subarray(0, 4).toString()).toBe('%PDF');
  }, 60_000);

  it('suite report: every check, evidence, and an honest list of what could not be checked', async () => {
    await fresh();
    const full = await buildSuiteReport(
      await addSuite(sandboxId, 'correctness', correctness, { cls: 'MOCK' }),
    );
    expect(full.executive.verdict).toBe('PASS');
    expect(full.checks).toHaveLength(CHECKS.length);
    expect(full.coverageGaps).toEqual([]);
    expect(full.evidence.length).toBeGreaterThan(50);
    expect(full.checks.every((c) => c.whyItMatters.length > 10)).toBe(true);

    const live = await buildSuiteReport(await addSuite(sandboxId, 'correctness', liveCorrectness));
    expect(live.coverageGaps.length).toBeGreaterThan(0);
    expect(live.coverageGaps.map((g) => g.id)).toContain('sim.concurrent-overspend');
    const html = renderHtml(live);
    expect(html).toContain('What could not be checked here');

    const sec = await buildSuiteReport(
      await addSuite(sandboxId, 'security', security, { cls: 'MOCK' }),
    );
    expect(sec.checks.every((c) => c.owasp?.startsWith('API'))).toBe(true);
    expect(sec.findings.some((f) => f.advisory)).toBe(true); // hardening suggestions surface as warnings
    expect(sec.executive.verdict).toBe('PASS');
  });

  it('a failed suite names the defect in business terms', async () => {
    await fresh();
    const bad = JSON.parse(JSON.stringify(correctness)) as SuiteReport;
    const first = bad.results[0]!;
    first.status = 'FAIL';
    first.assertions = [
      { name: 'exactly one payment exists for the reference', pass: false, detail: '2' },
    ];
    const r = await buildSuiteReport(
      await addSuite(sandboxId, 'correctness', bad, { verdict: 'FAIL' }),
    );
    expect(r.executive.verdict).toBe('FAIL');
    expect(r.findings[0]).toMatchObject({ severity: 'CRITICAL' });
    expect(r.findings[0]!.impact).toContain('charged or paid out twice');
    expect(r.executive.summary).toContain('Fix these before relying');
  });

  it('readiness: gates decide — simulator evidence never makes it READY', async () => {
    const seed = async (
      apiId: string,
      cls: 'SANDBOX' | 'MOCK',
      mutate?: (c: SuiteReport) => SuiteReport,
    ) => {
      await fresh();
      const planId = await addPlan(apiId, 'p');
      const spike = cfg({ profile: 'SPIKE', durationSeconds: 60 });
      const bp = cfg({ profile: 'BREAKPOINT', durationSeconds: 60 });
      await addRun({ apiId, planId, cls });
      await addRun({
        apiId,
        planId: await addPlan(apiId, 's', spike),
        config: spike,
        cls,
        summary: summary({
          totalRequests: expectedRequests(spike),
          peakRps: 100,
          maxSustainedRps: 100,
        }),
      });
      await addRun({
        apiId,
        planId: await addPlan(apiId, 'b', bp),
        config: bp,
        cls,
        reason: 'limit reached: x',
      });
      await addSuite(apiId, 'correctness', mutate ? mutate(correctness) : correctness, {
        cls,
        clean: true,
      });
      await addSuite(apiId, 'security', security, { cls, clean: true });
    };

    await seed(sandboxId, 'SANDBOX');
    const ready = await buildReadinessReport(sandboxId);
    expect(ready.readiness.status).toBe('READY');
    expect(ready.headline).toContain('is ready');

    await seed(mockId, 'MOCK');
    const sim = await buildReadinessReport(mockId);
    expect(sim.readiness.status).toBe('INCOMPLETE');
    expect(sim.readiness.basis).toBe('simulator');
    expect(sim.readiness.nextSteps.join(' ')).toContain('sandbox');

    await fresh();
    const planId = await addPlan(sandboxId, 'p');
    await addRun({ apiId: sandboxId, planId });
    await addSuite(sandboxId, 'correctness', correctness, { verdict: 'FAIL', clean: true });
    await addSuite(sandboxId, 'security', security, { clean: true });
    const notReady = await buildReadinessReport(sandboxId);
    expect(notReady.readiness.status).toBe('NOT_READY');
    expect(notReady.headline).toContain('NOT ready');
    expect(renderHtml(notReady)).toContain('Not ready');
  }, 60_000);

  it('index lists every run kind newest-first with a verdict and honest environment label', async () => {
    await fresh();
    const planId = await addPlan(sandboxId, 'p');
    await addRun({ apiId: sandboxId, planId, ageDays: 3 });
    await addSuite(sandboxId, 'security', security, { cls: 'MOCK', ageDays: 1 });
    const items = await listReports({ apiId: sandboxId });
    expect(items.map((i) => i.kind).sort()).toEqual(['load', 'security']);
    expect(items[0]!.kind).toBe('security'); // newest first
    expect(items.find((i) => i.kind === 'security')).toMatchObject({
      verdict: 'PASS',
      isReal: false,
    });
    expect(items.find((i) => i.kind === 'load')).toMatchObject({
      verdict: 'PASS',
      isReal: true,
      environmentLabel: 'iSmartPay sandbox',
    });
  });

  it('unknown ids are 404, not empty reports', async () => {
    const none = '00000000-0000-4000-8000-000000000000';
    await expect(buildLoadRunReport(none)).rejects.toMatchObject({ statusCode: 404 });
    await expect(buildSuiteReport(none)).rejects.toMatchObject({ statusCode: 404 });
    await expect(buildReadinessReport(none)).rejects.toMatchObject({ statusCode: 404 });
  });
});
