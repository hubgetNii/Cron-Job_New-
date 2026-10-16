import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDbHealth, closePool, query } from '../../lib/db.js';
import { resetEnvCache } from '../../config/index.js';

const dbUp = (await checkDbHealth()).ok;

process.env['LOAD_TEST_ENABLED'] = 'true';
resetEnvCache();

const { createSimulatorApp } = await import('../../loadtest/simulator/app.js');
const { encryptCredentials } = await import('../../lib/crypto/credential-cipher.js');
const { upsertTargetConfig, setKillSwitch } =
  await import('../../repositories/load-test-safety.repo.js');
const repo = await import('../../repositories/load-test-correctness.repo.js');
const svc = await import('./correctness.service.js');
const { CHECKS } = await import('../../loadtest/correctness/checks.js');

const actor = { userId: null, label: 'test:correctness' };
const { app: simApp, sim } = createSimulatorApp();
let server: Server;
let origin: string;
let mockTarget: string;
let sandboxTarget: string;

const reasons = (e: unknown): string[] =>
  ((e as { details?: { violations?: { code: string }[] } }).details?.violations ?? []).map(
    (v) => v.code,
  );

describe.skipIf(!dbUp)('correctness suite as a queued run (DB + safety gate + simulator)', () => {
  beforeAll(async () => {
    server = createServer(simApp);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await query(`DELETE FROM load_test_correctness_runs`);
    await query(`DELETE FROM monitored_apis WHERE name LIKE 'lt-cor-%'`);
    const creds = encryptCredentials({
      tokenUrl: `${origin}/v1/oauth/token`,
      tokenUsername: 'cli_cor',
      tokenPassword: 'secret_cor_value',
      tokenMode: 'form',
    });
    const mk = async (name: string, url: string, withCreds: boolean): Promise<string> => {
      const { rows } = await query<{ id: string }>(
        `INSERT INTO monitored_apis
           (name, endpoint_class, severity_default, url, frequency_cron, environment, authentication_type, encrypted_credentials)
         VALUES ($1, 'internal', 'LOW', $2, '*/5 * * * *', 'sandbox', $3, $4) RETURNING id`,
        [name, url, withCreds ? 'OAUTH2' : 'NONE', withCreds ? JSON.stringify(creds) : null],
      );
      return rows[0]!.id;
    };
    mockTarget = await mk('lt-cor-sim', origin, true);
    await upsertTargetConfig(mockTarget, 'MOCK', false, null);
    sandboxTarget = await mk('lt-cor-sandbox', 'https://stgdeveloper-api.ismartghana.com', false);
    await upsertTargetConfig(sandboxTarget, 'SANDBOX', false, null);
  });

  beforeEach(async () => {
    sim.reset({ resolveDelayMs: 20, openingBalance: '100000.00' });
    await setKillSwitch(false, null, null);
    await query(`DELETE FROM load_test_correctness_runs`);
  });

  afterAll(async () => {
    await setKillSwitch(false, null, null);
    await query(`DELETE FROM load_test_correctness_runs`);
    await query(`DELETE FROM monitored_apis WHERE name LIKE 'lt-cor-%'`);
    await new Promise((r) => server.close(r));
    await closePool();
    delete process.env['LOAD_TEST_ENABLED'];
    resetEnvCache();
  });

  it('runs the whole suite through the worker path and stores a PASS verdict with evidence', async () => {
    const queued = await svc.queueCorrectnessRun(mockTarget, undefined, actor);
    expect(queued.effectiveClass).toBe('MOCK');
    const claimed = await repo.claimNextCorrectnessRun('test-worker');
    expect(claimed?.id).toBe(queued.id);
    await svc.executeCorrectnessRun(claimed!, { workerId: 'test-worker' });

    const done = (await repo.getCorrectnessRun(queued.id))!;
    expect(done.status).toBe('COMPLETED');
    expect(done.mode).toBe('simulator');
    expect(done.summary).toMatchObject({
      verdict: 'PASS',
      failed: 0,
      errored: 0,
      skipped: 0,
      total: CHECKS.length,
    });
    expect(done.results).toHaveLength(CHECKS.length);
    expect(done.results!.every((r) => r.evidence.length > 0)).toBe(true);
    // Credentials and tokens must not reach stored evidence.
    const stored = JSON.stringify(done);
    expect(stored).not.toContain('secret_cor_value');
    expect(stored).not.toMatch(/sim_[0-9a-f]{20}/);
  }, 180_000);

  it('runs a selected subset and rejects unknown check ids', async () => {
    await expect(
      svc.queueCorrectnessRun(mockTarget, ['nope.nothing'], actor),
    ).rejects.toMatchObject({ statusCode: 422 });
    const queued = await svc.queueCorrectnessRun(
      mockTarget,
      ['auth.invalid-token-rejected'],
      actor,
    );
    const claimed = (await repo.claimNextCorrectnessRun('test-worker'))!;
    await svc.executeCorrectnessRun(claimed, { workerId: 'test-worker' });
    const done = (await repo.getCorrectnessRun(queued.id))!;
    expect(done.results!.filter((r) => r.status !== 'SKIPPED')).toHaveLength(1);
    expect(done.summary!.verdict).toBe('PASS');
  }, 60_000);

  it('records a FAIL verdict when the target is defective', async () => {
    sim.patchConfig({ weak: { acceptAnyToken: true } });
    const queued = await svc.queueCorrectnessRun(
      mockTarget,
      ['auth.invalid-token-rejected'],
      actor,
    );
    await svc.executeCorrectnessRun((await repo.claimNextCorrectnessRun('w'))!, { workerId: 'w' });
    const done = (await repo.getCorrectnessRun(queued.id))!;
    expect(done.status).toBe('COMPLETED'); // the run worked; the TARGET failed
    expect(done.summary!.verdict).toBe('FAIL');
  }, 60_000);

  it('goes through the safety gate: needs authorization off the simulator, honours the kill switch', async () => {
    const refused = await svc
      .queueCorrectnessRun(sandboxTarget, undefined, actor)
      .catch((e: unknown) => e);
    expect(reasons(refused)).toContain('AUTH_REQUIRED');

    await setKillSwitch(true, 'drill', null);
    const killed = await svc
      .queueCorrectnessRun(mockTarget, undefined, actor)
      .catch((e: unknown) => e);
    expect(reasons(killed)).toContain('KILL_SWITCH');
  });

  it('stops between checks when the kill switch is engaged mid-run', async () => {
    const queued = await svc.queueCorrectnessRun(mockTarget, undefined, actor);
    const claimed = (await repo.claimNextCorrectnessRun('w'))!;
    const exec = svc.executeCorrectnessRun(claimed, { workerId: 'w' });
    for (let i = 0; i < 200; i++) {
      if ((await repo.getCorrectnessRun(queued.id))?.status === 'RUNNING') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await setKillSwitch(true, 'stop now', null);
    await exec;
    const done = (await repo.getCorrectnessRun(queued.id))!;
    expect(done.status).toBe('ABORTED');
    expect(
      done.results!.some((r) => r.status === 'SKIPPED' && r.note?.includes('kill switch')),
    ).toBe(true);
  }, 120_000);

  it('fails runs whose worker stopped heartbeating', async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO load_test_correctness_runs (api_id, status, heartbeat_at)
       VALUES ($1, 'RUNNING', now() - interval '5 minutes') RETURNING id`,
      [mockTarget],
    );
    expect(await repo.recoverStaleCorrectnessRuns(60)).toContain(rows[0]!.id);
    expect((await repo.getCorrectnessRun(rows[0]!.id))?.status).toBe('FAILED');
  });
});
