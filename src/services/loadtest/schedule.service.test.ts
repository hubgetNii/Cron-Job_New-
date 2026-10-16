import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDbHealth, closePool, query } from '../../lib/db.js';
import { resetEnvCache } from '../../config/index.js';

const dbUp = (await checkDbHealth()).ok;

process.env['LOAD_TEST_ENABLED'] = 'true';
resetEnvCache();

const { upsertTargetConfig, setKillSwitch } =
  await import('../../repositories/load-test-safety.repo.js');
const svc = await import('./schedule.service.js');
const repo = await import('../../repositories/load-test-schedules.repo.js');

const actor = { userId: null, label: 'test:schedule' };
let classified: string;
let unclassified: string;

async function mk(name: string): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO monitored_apis
       (name, endpoint_class, severity_default, url, frequency_cron, environment, authentication_type)
     VALUES ($1, 'internal', 'LOW', 'http://127.0.0.1:9', '*/5 * * * *', 'sandbox', 'NONE') RETURNING id`,
    [name],
  );
  return rows[0]!.id;
}

const makeDue = (id: string): Promise<unknown> =>
  query(`UPDATE load_test_schedules SET next_run_at = now() - interval '5 minutes' WHERE id = $1`, [
    id,
  ]);
const runsFor = async (apiId: string): Promise<number> =>
  Number(
    (
      await query<{ n: string }>(
        `SELECT count(*) AS n FROM load_test_correctness_runs WHERE api_id = $1`,
        [apiId],
      )
    ).rows[0]!.n,
  );

describe('cron validation', () => {
  it('refuses anything more frequent than hourly and accepts a daily cadence', () => {
    expect(() => svc.validateCron('*/5 * * * *')).toThrow(/once an hour/);
    expect(() => svc.validateCron('not a cron')).toThrow();
    expect(svc.validateCron('0 3 * * *').getTime()).toBeGreaterThan(Date.now());
  });
});

describe.skipIf(!dbUp)('scheduled suites', () => {
  beforeAll(async () => {
    await query(`DELETE FROM monitored_apis WHERE name LIKE 'lt-sch-%'`);
    classified = await mk('lt-sch-mock');
    await upsertTargetConfig(classified, 'MOCK', false, null);
    unclassified = await mk('lt-sch-unclassified');
  });
  beforeEach(async () => {
    await setKillSwitch(false, null, null);
    await query(`DELETE FROM load_test_schedules`);
    await query(`DELETE FROM load_test_correctness_runs`);
  });
  afterAll(async () => {
    await query(`DELETE FROM load_test_correctness_runs`);
    await query(`DELETE FROM monitored_apis WHERE name LIKE 'lt-sch-%'`);
    await closePool();
    delete process.env['LOAD_TEST_ENABLED'];
    resetEnvCache();
  });

  it('queues a due suite once, advances to a future slot and never bursts', async () => {
    const s = await svc.createSchedule(
      { apiId: classified, suite: 'security', cron: '0 3 * * *' },
      actor,
    );
    await makeDue(s.id);
    expect(await svc.tickSchedules()).toBe(1);
    expect(await runsFor(classified)).toBe(1);
    const after = (await repo.getSchedule(s.id))!;
    expect(after.lastOutcome).toBe('QUEUED');
    expect(new Date(after.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect(await svc.tickSchedules()).toBe(0);
    expect(await runsFor(classified)).toBe(1);
  });

  it('skips while the previous scheduled run is unfinished', async () => {
    const s = await svc.createSchedule(
      { apiId: classified, suite: 'correctness', cron: '0 3 * * *' },
      actor,
    );
    await makeDue(s.id);
    await svc.tickSchedules();
    await makeDue(s.id);
    expect(await svc.tickSchedules()).toBe(0);
    expect((await repo.getSchedule(s.id))!.lastOutcome).toBe('SKIPPED_BUSY');
    expect(await runsFor(classified)).toBe(1);
  });

  it('is refused by the safety gate like a manual run would be, and still moves on', async () => {
    const s = await svc.createSchedule(
      { apiId: unclassified, suite: 'correctness', cron: '0 3 * * *' },
      actor,
    );
    await makeDue(s.id);
    expect(await svc.tickSchedules()).toBe(0);
    const after = (await repo.getSchedule(s.id))!;
    expect(after.lastOutcome).toBe('REFUSED');
    expect(new Date(after.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect(await runsFor(unclassified)).toBe(0);
  });

  it('does nothing while disabled, and re-enabling does not fire the backlog', async () => {
    const s = await svc.createSchedule(
      { apiId: classified, suite: 'correctness', cron: '0 3 * * *' },
      actor,
    );
    await svc.setScheduleEnabled(s.id, false, actor);
    await makeDue(s.id);
    expect(await svc.tickSchedules()).toBe(0);
    const back = await svc.setScheduleEnabled(s.id, true, actor);
    expect(new Date(back.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect(await svc.tickSchedules()).toBe(0);
  });
});
