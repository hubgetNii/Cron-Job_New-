import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDbHealth, closePool, query } from '../../lib/db.js';
import { resetEnvCache } from '../../config/index.js';

const dbUp = (await checkDbHealth()).ok;
const k6Up = ((): boolean => {
  try {
    execFileSync('k6', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

process.env['LOAD_TEST_ENABLED'] = 'true';
process.env['LOAD_TEST_GUARDRAIL_WINDOW_SECONDS'] = '5';
process.env['LOAD_TEST_GUARDRAIL_MIN_SAMPLES'] = '10';
resetEnvCache();

const { createSimulatorApp } = await import('../../loadtest/simulator/app.js');
const { encryptCredentials } = await import('../../lib/crypto/credential-cipher.js');
const { upsertTargetConfig, setKillSwitch } =
  await import('../../repositories/load-test-safety.repo.js');
const runs = await import('../../repositories/load-test-runs.repo.js');
const svc = await import('./run.service.js');
const { createValidatedDataSet } = await import('./data-set.service.js');
const { harvestReferences } = await import('./harvest.service.js');
const { packById, planFromPack } = await import('../../loadtest/packs/packs.js');

const actor = { userId: null, label: 'test:loadtest' };
const { app: simApp, sim } = createSimulatorApp();
let server: Server;
let origin: string;
let targetId: string;
let badTokenTarget: string;

interface SimState {
  transactions: { total: number; byKind: Record<string, Record<string, number>> };
  duplicateEffects: number;
  counters: Record<string, number>;
}
const simState = (): SimState => sim.state() as unknown as SimState;
const kindTotal = (kind: string): number =>
  Object.values(simState().transactions.byKind[kind] ?? {}).reduce((a, b) => a + b, 0);

const getPlan = (over: Record<string, unknown> = {}) => ({
  profile: 'LOAD',
  method: 'GET',
  path: '/v1/wallet',
  targetRps: 30,
  durationSeconds: 20,
  maxVus: 50,
  ...over,
});

async function claim(planId: string) {
  const queued = await svc.queueRun(planId, actor);
  const claimed = await runs.claimNextRun('test-worker');
  expect(claimed?.id).toBe(queued.id);
  return claimed!;
}

async function queueAndClaim(config: Record<string, unknown>, apiId = targetId) {
  const plan = await svc.createPlan({ apiId, name: 'it-plan', config }, actor);
  return claim(plan.id);
}

async function packRun(packId: string, params: Record<string, unknown> = {}, datasetName?: string) {
  const pack = packById(packId)!;
  const ex = pack.exampleDataSets.find(
    (d) => d.name === (datasetName ?? pack.exampleDataSets[0]?.name),
  );
  const ds = await createValidatedDataSet(
    { name: `it-${packId}`, environment: 'sandbox', records: ex!.records },
    actor,
  );
  const config = planFromPack(pack, {
    profile: 'SMOKE',
    targetRps: 2,
    durationSeconds: 10,
    maxVus: 10,
    ...params,
    dataSetId: ds.id,
  });
  return queueAndClaim(config);
}

const finished = async (id: string) => (await runs.getRun(id))!;

describe.skipIf(!dbUp || !k6Up)('load-test runner (real k6 + contract-accurate simulator)', () => {
  beforeAll(async () => {
    server = createServer(simApp);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await query(`DELETE FROM load_test_plans`);
    await query(`DELETE FROM load_test_data_sets WHERE name LIKE 'it-%'`);
    await query(`DELETE FROM monitored_apis WHERE name LIKE 'lt-int-%'`);
    const mk = async (name: string, tokenUrl: string): Promise<string> => {
      const creds = encryptCredentials({
        tokenUrl,
        tokenUsername: 'cli_it',
        tokenPassword: 'secret_it',
        tokenMode: 'form',
      });
      const { rows } = await query<{ id: string }>(
        `INSERT INTO monitored_apis
           (name, endpoint_class, severity_default, url, frequency_cron, environment, authentication_type, encrypted_credentials)
         VALUES ($1, 'internal', 'LOW', $2, '*/5 * * * *', 'sandbox', 'OAUTH2', $3) RETURNING id`,
        [name, origin, JSON.stringify(creds)],
      );
      await upsertTargetConfig(rows[0]!.id, 'MOCK', false, null);
      return rows[0]!.id;
    };
    targetId = await mk('lt-int-sim', `${origin}/v1/oauth/token`);
    badTokenTarget = await mk('lt-int-badtoken', 'http://token-thief.example/v1/oauth/token');
  });

  beforeEach(async () => {
    sim.reset({ resolveDelayMs: 5, openingBalance: '100000000.00' });
    await setKillSwitch(false, null, null);
    await query(`DELETE FROM load_test_runs`);
  });

  afterAll(async () => {
    await setKillSwitch(false, null, null);
    await query(`DELETE FROM load_test_plans`);
    await query(`DELETE FROM load_test_data_sets WHERE name LIKE 'it-%'`);
    await query(`DELETE FROM monitored_apis WHERE name LIKE 'lt-int-%'`);
    await new Promise((r) => server.close(r));
    await closePool();
    delete process.env['LOAD_TEST_ENABLED'];
    delete process.env['LT_SECRET_LT_TEST_SIM_MSISDN'];
    resetEnvCache();
  });

  it('completes a LOAD run with a form-encoded token handshake, a plan path and monitor isolation', async () => {
    const run = await queueAndClaim(getPlan());
    await svc.executeRun(run, { workerId: 'test-worker' });

    const done = await finished(run.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.finishedReason).toBe('completed');
    expect(done.k6Version).toMatch(/k6/i);
    const s = done.summary!;
    expect(s.totalRequests).toBeGreaterThan(300);
    expect(s.totalRequests).toBeLessThan(700);
    expect(s.errorRate).toBe(0);
    expect(s.authRequests).toBeGreaterThanOrEqual(1);
    expect(s.generatorSaturated).toBe(false);
    expect(s.statusCounts['200']).toBe(s.totalRequests);
    expect(simState().counters['tokensIssued']).toBeGreaterThanOrEqual(1);

    const metrics = await runs.listMetrics(run.id);
    expect(metrics.length).toBeGreaterThanOrEqual(3);
    expect(metrics.reduce((n, m) => n + m.requests, 0)).toBe(s.totalRequests);
    const w = await query(`SELECT 1 FROM maintenance_windows WHERE id = $1`, [
      done.maintenanceWindowId,
    ]);
    expect(done.maintenanceWindowId).toBeTruthy();
    expect(w.rowCount).toBe(0); // removed when the run ended
  }, 120_000);

  it('refreshes the 5-minute token BEFORE it expires — no 401s even when the token lives 5 s', async () => {
    sim.patchConfig({ tokenTtlSeconds: 5 });
    const run = await queueAndClaim(getPlan());
    await svc.executeRun(run, { workerId: 'test-worker' });
    const done = await finished(run.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.summary!.errorRate).toBe(0);
    expect(done.summary!.statusCounts['401']).toBeUndefined();
    expect(simState().counters['tokensIssued']).toBeGreaterThanOrEqual(3);
    expect(simState().counters['tokenExpiries']).toBe(0);
  }, 120_000);

  it('collections pack: data-set fields flow into every request; references are unique per run', async () => {
    const first = await packRun('collections-momo-telecel');
    await svc.executeRun(first, { workerId: 'test-worker' });
    const a = await finished(first.id);
    expect(a.status).toBe('COMPLETED');
    expect(a.summary!.statusCounts['202']).toBe(a.summary!.totalRequests);
    expect(kindTotal('collection')).toBe(a.summary!.totalRequests);

    // Same plan shape again: references derive from the NEW run id, so no 409s.
    const second = await packRun('collections-momo-telecel');
    await svc.executeRun(second, { workerId: 'test-worker' });
    const b = await finished(second.id);
    expect(b.summary!.errorRate).toBe(0);
    expect(kindTotal('collection')).toBe(a.summary!.totalRequests + b.summary!.totalRequests);
    expect(simState().duplicateEffects).toBe(0);
  }, 150_000);

  it('harvested references feed the status-poll pack: every lookup finds the earlier collection', async () => {
    const create = await packRun('collections-momo-telecel');
    await svc.executeRun(create, { workerId: 'test-worker' });
    const made = await finished(create.id);
    expect(made.status).toBe('COMPLETED');

    const ds = await harvestReferences(create.id, 20, actor);
    expect(ds.recordCount).toBeGreaterThan(0);
    const poll = packById('collection-status-poll')!;
    const plan = await svc.createPlan(
      {
        apiId: targetId,
        name: 'poll-harvested',
        config: planFromPack(poll, {
          profile: 'SMOKE',
          targetRps: 2,
          durationSeconds: 10,
          maxVus: 10,
          dataSetId: ds.id,
        }),
      },
      actor,
    );
    const claimed = await claim(plan.id);
    await svc.executeRun(claimed, { workerId: 'test-worker' });
    const polled = await finished(claimed.id);
    expect(polled.status).toBe('COMPLETED');
    expect(polled.summary!.statusCounts['200']).toBe(polled.summary!.totalRequests);
  }, 150_000);

  it('payout-batch pack: $repeat expands to unique items and the fan-out is real', async () => {
    const run = await packRun('payout-batch-telecel', { batchSize: 5 });
    expect(run.snapshot.config.fanout).toBe(5);
    await svc.executeRun(run, { workerId: 'test-worker' });
    const done = await finished(run.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.summary!.statusCounts['200']).toBe(done.summary!.totalRequests);
    expect(kindTotal('payout')).toBe(done.summary!.totalRequests * 5);
    expect(simState().duplicateEffects).toBe(0);
  }, 120_000);

  it('stops on a 401/403 flood: a refused-payment run is invalid, not a finding', async () => {
    sim.patchConfig({ limits: { perTransaction: '0.50' } }); // every 1.00 collection → 403
    const run = await packRun('collections-momo-telecel', {
      profile: 'LOAD',
      targetRps: 20,
      durationSeconds: 40,
    });
    const t0 = Date.now();
    await svc.executeRun(run, { workerId: 'test-worker' });
    const done = await finished(run.id);
    expect(done.status).toBe('ABORTED');
    expect(done.finishedReason).toMatch(/^guardrail: .*401\/403/);
    expect(Date.now() - t0).toBeLessThan(35_000);
  }, 120_000);

  it('trips the server-failure guardrail, aborting a normal profile', async () => {
    sim.patchConfig({ errorRate: 1 });
    const run = await queueAndClaim(getPlan({ durationSeconds: 40 }));
    const t0 = Date.now();
    await svc.executeRun(run, { workerId: 'test-worker' });
    const done = await finished(run.id);
    expect(done.status).toBe('ABORTED');
    expect(done.finishedReason).toMatch(/^guardrail: server failure rate/);
    expect(Date.now() - t0).toBeLessThan(35_000);
    expect(done.summary!.errorClasses.server5xx).toBeGreaterThan(0);
  }, 120_000);

  it('treats a server-failure trip as a valid finding for BREAKPOINT profiles', async () => {
    sim.patchConfig({ errorRate: 1 });
    const run = await queueAndClaim(getPlan({ profile: 'BREAKPOINT', durationSeconds: 40 }));
    await svc.executeRun(run, { workerId: 'test-worker' });
    const done = await finished(run.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.finishedReason).toMatch(/^limit reached/);
  }, 120_000);

  it('stops promptly on an abort request and on the kill switch', async () => {
    const a = await queueAndClaim(getPlan({ durationSeconds: 60 }));
    const execA = svc.executeRun(a, { workerId: 'test-worker' });
    await new Promise((r) => setTimeout(r, 5000));
    await svc.abortRun(a.id, 'operator pressed stop', actor);
    await execA;
    const doneA = await finished(a.id);
    expect([doneA.status, doneA.finishedReason]).toEqual([
      'ABORTED',
      expect.stringContaining('operator pressed stop'),
    ]);
    expect(doneA.summary!.totalRequests).toBeGreaterThan(0);

    const b = await queueAndClaim(getPlan({ durationSeconds: 60 }));
    const execB = svc.executeRun(b, { workerId: 'test-worker' });
    await new Promise((r) => setTimeout(r, 4000));
    await setKillSwitch(true, 'drill', null);
    await execB;
    const doneB = await finished(b.id);
    expect(doneB.status).toBe('ABORTED');
    expect(doneB.finishedReason).toContain('kill switch engaged');
  }, 150_000);

  it('never sends credentials to a token host outside the allow-list', async () => {
    const run = await queueAndClaim(getPlan({ durationSeconds: 20 }), badTokenTarget);
    await svc.executeRun(run, { workerId: 'test-worker' });
    const done = await finished(run.id);
    expect(done.status).toBe('FAILED');
    expect(done.error).toContain('Refusing to send credentials');
    expect(done.summary?.totalRequests ?? 0).toBe(0);
  }, 60_000);

  it('resolves {{secret:NAME}} from the worker env only — and fails clearly when it is missing', async () => {
    const ds = await createValidatedDataSet(
      {
        name: 'it-utility-secret',
        environment: 'sandbox',
        records: [
          {
            test_data: true,
            test_case_id: 'UTIL-IT',
            environment: 'sandbox',
            productId: 'airtime-mtn',
            amount: '1.00',
            beneficiaryMsisdn: '{{secret:LT_TEST_SIM_MSISDN}}',
          },
        ],
      },
      actor,
    );
    const config = planFromPack(packById('utility-purchase-airtime')!, {
      dataSetId: ds.id,
      profile: 'SMOKE',
      targetRps: 1,
      durationSeconds: 10,
      maxVus: 5,
    });

    delete process.env['LT_SECRET_LT_TEST_SIM_MSISDN'];
    const missing = await queueAndClaim(config);
    await svc.executeRun(missing, { workerId: 'test-worker' });
    const bad = await finished(missing.id);
    expect(bad.status).toBe('FAILED');
    expect(bad.error).toContain('LT_SECRET_LT_TEST_SIM_MSISDN');
    expect(JSON.stringify(await runs.getPlan(missing.planId))).not.toContain('233244');

    process.env['LT_SECRET_LT_TEST_SIM_MSISDN'] = '233244123456';
    const ok = await queueAndClaim(config);
    await svc.executeRun(ok, { workerId: 'test-worker' });
    const good = await finished(ok.id);
    expect(good.status).toBe('COMPLETED');
    expect(simState().counters['utilityDeliveries']).toBeGreaterThan(0);
  }, 120_000);
});

describe('resolveSecrets', () => {
  it('replaces whole-value references deeply and never partially', () => {
    const out = svc.resolveSecrets(
      { a: '{{secret:ONE}}', n: { b: ['{{secret:TWO}}', 'plain', '{{secret:ONE}}-suffix'] } },
      { LT_SECRET_ONE: '1', LT_SECRET_TWO: '2' },
    );
    expect(out).toEqual({ a: '1', n: { b: ['2', 'plain', '{{secret:ONE}}-suffix'] } });
  });

  it('throws naming the missing variable, never the value', () => {
    expect(() => svc.resolveSecrets({ a: '{{secret:NOPE}}' }, {})).toThrow(/LT_SECRET_NOPE/);
  });
});

describe.skipIf(!dbUp)('queueing, data sets and recovery (no k6 needed)', () => {
  let id: string;
  beforeAll(async () => {
    await query(`DELETE FROM load_test_plans`);
    await query(`DELETE FROM load_test_data_sets WHERE name LIKE 'it-%'`);
    await query(`DELETE FROM monitored_apis WHERE name LIKE 'lt-q-%'`);
    const { rows } = await query<{ id: string }>(
      `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron, environment)
       VALUES ('lt-q-nocfg', 'internal', 'LOW', 'https://stgdeveloper-api.ismartghana.com', '*/5 * * * *', 'sandbox')
       RETURNING id`,
    );
    id = rows[0]!.id;
  });
  afterAll(async () => {
    await query(`DELETE FROM load_test_plans`);
    await query(`DELETE FROM load_test_data_sets WHERE name LIKE 'it-%'`);
    await query(`DELETE FROM monitored_apis WHERE name LIKE 'lt-q-%'`);
  });

  const reasons = (e: unknown): string[] =>
    ((e as { details?: { violations?: { code: string }[] } }).details?.violations ?? []).map(
      (v) => v.code,
    );

  it('refuses to queue an unclassified target and reports why', async () => {
    const plan = await svc.createPlan(
      { apiId: id, name: 'p', config: getPlan({ profile: 'SMOKE', durationSeconds: 10 }) },
      actor,
    );
    const err = await svc.queueRun(plan.id, actor).catch((e: unknown) => e);
    expect(reasons(err)).toContain('NO_CONFIG');
  });

  it('judges the PEAK of a spike and the FAN-OUT of a batch, not the nominal request rate', async () => {
    await upsertTargetConfig(id, 'SANDBOX', false, null);
    const spike = await svc.createPlan(
      {
        apiId: id,
        name: 'spike',
        config: getPlan({
          profile: 'SPIKE',
          targetRps: 3,
          spikeMultiplier: 50,
          durationSeconds: 60,
        }),
      },
      actor,
    );
    expect(spike.peakRps).toBe(150);
    expect(reasons(await svc.queueRun(spike.id, actor).catch((e: unknown) => e))).toContain(
      'CEILING_RPS',
    );

    // 1 request/s looks harmless — but each request carries 100 payouts.
    const ds = await createValidatedDataSet(
      {
        name: 'it-batch',
        environment: 'sandbox',
        records: packById('payout-batch-telecel')!.exampleDataSets[0]!.records,
      },
      actor,
    );
    const cfg = planFromPack(packById('payout-batch-telecel')!, {
      batchSize: 100,
      targetRps: 1,
      profile: 'LOAD',
      durationSeconds: 30,
      dataSetId: ds.id,
    });
    const batch = await svc.createPlan({ apiId: id, name: 'batch', config: cfg }, actor);
    expect(batch.effectiveRps).toBe(100);
    expect(reasons(await svc.queueRun(batch.id, actor).catch((e: unknown) => e))).toContain(
      'CEILING_RPS',
    );
  });

  it('rejects plans whose {{data.*}} fields the data set does not carry', async () => {
    const noDs = planFromPack(packById('collections-momo-telecel')!, {});
    await expect(
      svc.createPlan({ apiId: id, name: 'x', config: noDs }, actor),
    ).rejects.toMatchObject({ statusCode: 422 });

    const ds = await createValidatedDataSet(
      {
        name: 'it-thin',
        environment: 'sandbox',
        records: [{ test_data: true, test_case_id: 'T', environment: 'sandbox', amount: '1.00' }],
      },
      actor,
    );
    const thin = planFromPack(packById('collections-momo-telecel')!, { dataSetId: ds.id });
    await expect(svc.createPlan({ apiId: id, name: 'x', config: thin }, actor)).rejects.toThrow(
      /payerMsisdn/,
    );
  });

  it('refuses to store a data set that breaks the test-data rules', async () => {
    const bad = createValidatedDataSet(
      {
        name: 'it-bad',
        environment: 'sandbox',
        records: [
          {
            test_data: true,
            test_case_id: 'T',
            environment: 'sandbox',
            pan: '5555555555554444',
            cvv: '123',
          },
        ],
      },
      actor,
    );
    await expect(bad).rejects.toMatchObject({ statusCode: 422 });
    const { rows } = await query(`SELECT 1 FROM load_test_data_sets WHERE name = 'it-bad'`);
    expect(rows).toHaveLength(0);
  });

  it('fails runs whose worker stopped heartbeating', async () => {
    const plan = await svc.createPlan(
      { apiId: id, name: 'stale', config: getPlan({ profile: 'SMOKE', durationSeconds: 10 }) },
      actor,
    );
    const { rows } = await query<{ id: string }>(
      `INSERT INTO load_test_runs (plan_id, api_id, plan_snapshot, status, heartbeat_at)
       VALUES ($1, $2, '{}', 'RUNNING', now() - interval '5 minutes') RETURNING id`,
      [plan.id, id],
    );
    expect(await runs.recoverStaleRuns(60)).toContain(rows[0]!.id);
    expect((await runs.getRun(rows[0]!.id))?.status).toBe('FAILED');
  });
});
