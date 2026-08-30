import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkDbHealth, closePool, query } from '../../lib/db.js';
import { makeMonitoredApi } from '../../tests/fixtures.js';
import type { MonitoredApi } from '../../domain/target.js';
import type { HealthCheckOutcome } from '../../domain/health-check.js';
import { acquireLock, releaseLock } from './lock.service.js';
import { jobRunId, runScheduledCheck } from './job-runner.service.js';
import { detectMissedRuns } from './missed-run-detector.js';
import { Scheduler } from './scheduler.service.js';
import { evaluateSchedulerLiveness } from '../../watchdog/watchdog.js';

const dbUp = (await checkDbHealth()).ok;

const upOutcome = (): HealthCheckOutcome => ({
  status: 'UP',
  httpStatus: 200,
  responseTimeMs: 12,
  failureType: null,
  errorMessage: null,
  validation: { passed: true, results: [] },
  attempts: 1,
  responseSample: '{"ok":true}',
  checkedAt: new Date(),
});

let target: MonitoredApi;

async function insertTarget(cron = '*/1 * * * *'): Promise<MonitoredApi> {
  const { rows } = await query<{ id: string; created_at: Date }>(
    `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron, allow_private_network)
     VALUES ($1, 'internal', 'LOW', 'https://203.0.113.50/x', $2, true)
     RETURNING id, created_at`,
    [`rel-${Math.random().toString(36).slice(2)}`, cron],
  );
  return makeMonitoredApi({
    id: rows[0]!.id,
    frequencyCron: cron,
    createdAt: rows[0]!.created_at,
    retry: { count: 0, baseDelayMs: 0, backoffMultiplier: 2, maxDelayMs: 0 },
  });
}

describe.skipIf(!dbUp)('cron engine reliability (Phase 5 GATE)', () => {
  beforeAll(async () => {
    target = await insertTarget();
  });
  afterAll(async () => {
    await query(`DELETE FROM monitored_apis`);
    await closePool();
  });
  beforeEach(async () => {
    await query(`DELETE FROM cron_job_runs`);
    await query(`DELETE FROM health_check_results`);
    await query(`DELETE FROM alerts`);
    await query(`DELETE FROM job_locks`);
    await query(`UPDATE target_schedule_state SET missed_run_count = 0, last_actual_run_at = NULL`);
  });

  describe('distributed lock', () => {
    it('grants to exactly one holder and frees on release', async () => {
      expect(await acquireLock('k1', 'A', 5_000)).toBe(true);
      expect(await acquireLock('k1', 'B', 5_000)).toBe(false);
      await releaseLock('k1', 'A');
      expect(await acquireLock('k1', 'B', 5_000)).toBe(true);
    });

    it('lets another holder steal an expired lock', async () => {
      expect(await acquireLock('k2', 'A', 1)).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
      expect(await acquireLock('k2', 'B', 5_000)).toBe(true);
    });
  });

  describe('job runner', () => {
    const slot = new Date('2026-08-30T13:00:00.000Z');

    it('is idempotent for a (target, slot) pair', async () => {
      const exec = vi.fn().mockResolvedValue(upOutcome());
      const first = await runScheduledCheck(target, slot, { execute: exec });
      const second = await runScheduledCheck(target, slot, { execute: exec });

      expect(first.kind).toBe('executed');
      expect(second.kind).toBe('skipped');
      expect(exec).toHaveBeenCalledTimes(1);

      const results = await query(`SELECT 1 FROM health_check_results WHERE job_run_id = $1`, [
        jobRunId(target.id, slot),
      ]);
      expect(results.rowCount).toBe(1);
      const success = await query(
        `SELECT 1 FROM cron_job_runs WHERE target_id = $1 AND status = 'SUCCESS'`,
        [target.id],
      );
      expect(success.rowCount).toBe(1);
    });

    it('never double-executes under concurrent workers', async () => {
      let running = 0;
      let maxParallel = 0;
      const exec = vi.fn().mockImplementation(async () => {
        running += 1;
        maxParallel = Math.max(maxParallel, running);
        await new Promise((r) => setTimeout(r, 60));
        running -= 1;
        return upOutcome();
      });

      const results = await Promise.all(
        ['w1', 'w2', 'w3'].map((w) =>
          runScheduledCheck(target, slot, { workerId: w, execute: exec }),
        ),
      );

      expect(maxParallel).toBe(1);
      expect(results.filter((r) => r.kind === 'executed')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'skipped')).toHaveLength(2);

      const rows = await query(`SELECT 1 FROM health_check_results WHERE job_run_id = $1`, [
        jobRunId(target.id, slot),
      ]);
      expect(rows.rowCount).toBe(1);
    });

    it('dead-letters when the check itself fails to run', async () => {
      const exec = vi.fn().mockRejectedValue(new Error('database write failed'));
      const result = await runScheduledCheck(target, slot, { execute: exec });

      expect(result.kind).toBe('dead_lettered');
      const dl = await query(
        `SELECT 1 FROM cron_job_runs WHERE target_id = $1 AND status = 'DEAD_LETTERED'`,
        [target.id],
      );
      expect(dl.rowCount).toBe(1);
      const alert = await query(
        `SELECT 1 FROM alerts WHERE api_id = $1 AND alert_type = 'JOB_EXECUTION_FAILURE'`,
        [target.id],
      );
      expect(alert.rowCount).toBe(1);
    });
  });

  describe('scheduler', () => {
    let clock: Date;
    let run: ReturnType<typeof vi.fn>;
    let scheduler: Scheduler;

    beforeEach(() => {
      clock = new Date('2026-08-30T12:00:30.000Z');
      run = vi.fn().mockResolvedValue({ kind: 'executed', outcome: upOutcome() });
      scheduler = new Scheduler({
        now: () => clock,
        loadTargets: () => Promise.resolve([target]),
        run: run as unknown as typeof runScheduledCheck,
        tickIntervalMs: 10_000,
        heartbeatIntervalMs: 10_000,
      });
    });
    afterEach(() => scheduler.stop());

    it('fires exactly one job per anchored slot, once', async () => {
      await scheduler.reload();
      await scheduler.tick(); // 12:00:30 — seeds lastFired=12:00:00, no fire
      expect(run).not.toHaveBeenCalled();

      clock = new Date('2026-08-30T12:01:05.000Z');
      await scheduler.tick();
      expect(run).toHaveBeenCalledTimes(1);
      expect((run.mock.calls[0]![1] as Date).toISOString()).toBe('2026-08-30T12:01:00.000Z');

      await scheduler.tick(); // same clock — must not re-fire
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('detects slots skipped while it was down', async () => {
      await scheduler.reload();
      await scheduler.tick(); // seed at 12:00:00

      clock = new Date('2026-08-30T12:05:20.000Z');
      await scheduler.tick();

      expect(run).toHaveBeenCalledTimes(1); // fires the current slot
      expect((run.mock.calls[0]![1] as Date).toISOString()).toBe('2026-08-30T12:05:00.000Z');

      const missed = await query<{ missed_run_count: number }>(
        `SELECT missed_run_count FROM target_schedule_state WHERE target_id = $1`,
        [target.id],
      );
      expect(missed.rows[0]!.missed_run_count).toBe(4); // 12:01, 12:02, 12:03, 12:04
      const alert = await query(
        `SELECT 1 FROM alerts WHERE api_id = $1 AND alert_type = 'SCHEDULER_HEARTBEAT_MISSED'`,
        [target.id],
      );
      expect(alert.rowCount).toBe(1);
    });
  });

  describe('missed-run detector', () => {
    it('flags a target whose last run is far past the tolerance window', async () => {
      await query(
        `INSERT INTO target_schedule_state (target_id, last_actual_run_at)
         VALUES ($1, now() - interval '10 minutes')
         ON CONFLICT (target_id) DO UPDATE SET last_actual_run_at = now() - interval '10 minutes'`,
        [target.id],
      );
      const missed = await detectMissedRuns([target], new Date());
      expect(missed).toHaveLength(1);
      expect(missed[0]!.targetId).toBe(target.id);
    });

    it('does not flag a target that just ran', async () => {
      await query(
        `INSERT INTO target_schedule_state (target_id, last_actual_run_at)
         VALUES ($1, now())
         ON CONFLICT (target_id) DO UPDATE SET last_actual_run_at = now()`,
        [target.id],
      );
      expect(await detectMissedRuns([target], new Date())).toHaveLength(0);
    });
  });

  describe('watchdog liveness', () => {
    beforeEach(() => query(`DELETE FROM scheduler_heartbeats`));

    it('is unhealthy with no heartbeat at all', async () => {
      const v = await evaluateSchedulerLiveness(30_000);
      expect(v.healthy).toBe(false);
    });

    it('is healthy with a recent heartbeat', async () => {
      await query(
        `INSERT INTO scheduler_heartbeats (instance_id, last_tick_at) VALUES ('s1', now())`,
      );
      expect((await evaluateSchedulerLiveness(30_000)).healthy).toBe(true);
    });

    it('is unhealthy once the heartbeat goes stale', async () => {
      await query(
        `INSERT INTO scheduler_heartbeats (instance_id, last_tick_at)
         VALUES ('s1', now() - interval '5 minutes')`,
      );
      const v = await evaluateSchedulerLiveness(30_000);
      expect(v.healthy).toBe(false);
      expect(v.reason).toMatch(/last ticked/);
    });
  });
});
