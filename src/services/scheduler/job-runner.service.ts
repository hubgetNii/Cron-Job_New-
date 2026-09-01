import { env } from '../../config/index.js';
import { componentLogger } from '../../lib/logger.js';
import { withTransaction } from '../../lib/db.js';
import type { MonitoredApi } from '../../domain/target.js';
import type { HealthCheckOutcome } from '../../domain/health-check.js';
import { executeCheck, type ExecuteOptions } from '../health-check/executor.service.js';
import { acquireLock, releaseLock } from './lock.service.js';
import { processCheckOutcome } from '../incident/state-machine.service.js';
import { buildRootCauseAnalysis } from '../intelligence/rca.service.js';
import {
  claimJobRun,
  completeJobRun,
  insertHealthCheckResult,
  jobRunExists,
  recordAlert,
  recordRunOutcome,
  recordSkippedRun,
} from '../../repositories/scheduler.repo.js';

const log = componentLogger('job-runner');

/**
 * Recomputes the deterministic RCA after the check + incident transition have
 * committed (spec §8). Best-effort and advisory — a failure here never affects
 * the check result or the incident.
 */
async function refreshRcaFor(
  transition: Awaited<ReturnType<typeof processCheckOutcome>>,
): Promise<void> {
  if (
    transition.kind !== 'opened' &&
    transition.kind !== 'failure_recorded' &&
    transition.kind !== 'flapping_detected'
  ) {
    return;
  }
  try {
    await buildRootCauseAnalysis(transition.incident.id);
  } catch (err) {
    log.warn({ err, incidentId: transition.incident.id }, 'RCA refresh failed (advisory)');
  }
}

/** Deterministic idempotency key for a (target, slot) pair. */
export function jobRunId(targetId: string, slot: Date): string {
  return `${targetId}:${Math.floor(slot.getTime() / 1000)}`;
}

export function lockKey(targetId: string, slot: Date): string {
  return `lock:job:${targetId}:${Math.floor(slot.getTime() / 1000)}`;
}

export type RunResult =
  | { kind: 'executed'; outcome: HealthCheckOutcome }
  | { kind: 'skipped'; reason: 'already_done' | 'lock_contended' }
  | { kind: 'dead_lettered'; error: string };

/**
 * Runs one scheduled health check with the cron engine's reliability
 * guarantees: idempotent per (target, slot), single-execution across workers via
 * a TTL'd distributed lock, and a dead-letter path for the case where the
 * monitor itself fails to run the check (distinct from the target being DOWN —
 * see vault: "Dead Letter Queue").
 */
export async function runScheduledCheck(
  target: MonitoredApi,
  scheduledSlot: Date,
  opts: {
    workerId?: string;
    execute?: (t: MonitoredApi, o?: ExecuteOptions) => Promise<HealthCheckOutcome>;
  } = {},
): Promise<RunResult> {
  const workerId = opts.workerId ?? env().INSTANCE_ID;
  const runId = jobRunId(target.id, scheduledSlot);
  const execute = opts.execute ?? executeCheck;

  if (await jobRunExists(runId)) {
    return { kind: 'skipped', reason: 'already_done' };
  }

  const key = lockKey(target.id, scheduledSlot);
  // Hold the lock a little longer than the worst-case check duration.
  const ttlMs = Math.max(
    env().SCHEDULER_LOCK_TTL_MS,
    target.timeoutMs * (target.retry.count + 1) + 5_000,
  );

  if (!(await acquireLock(key, workerId, ttlMs))) {
    await recordSkippedRun({
      targetId: target.id,
      scheduledSlot,
      jobRunId: runId,
      workerId,
      status: 'SKIPPED_LOCK_CONTENDED',
    });
    return { kind: 'skipped', reason: 'lock_contended' };
  }

  try {
    const claimId = await claimJobRun({
      targetId: target.id,
      scheduledSlot,
      jobRunId: runId,
      workerId,
    });
    if (claimId === null) {
      return { kind: 'skipped', reason: 'already_done' };
    }

    try {
      const outcome = await execute(target);
      let transition: Awaited<ReturnType<typeof processCheckOutcome>> = { kind: 'noop' };
      await withTransaction(async (client) => {
        const checkId = await insertHealthCheckResult(
          { apiId: target.id, jobRunId: runId, outcome },
          client,
        );
        const counters = await recordRunOutcome(
          { targetId: target.id, scheduledSlot, status: outcome.status },
          client,
        );
        transition = await processCheckOutcome(
          {
            target,
            status: outcome.status,
            failureType: outcome.failureType,
            checkId,
            consecutiveSuccesses: counters.consecutiveSuccesses,
          },
          client,
        );
        await completeJobRun(claimId, 'SUCCESS', client);
      });
      await refreshRcaFor(transition);
      return { kind: 'executed', outcome };
    } catch (err) {
      // The check failed to run at all — the monitor is the incident here.
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err, targetId: target.id, slot: scheduledSlot },
        'job execution failed; dead-lettering',
      );
      await completeJobRun(claimId, 'DEAD_LETTERED');
      await recordAlert({
        alertType: 'JOB_EXECUTION_FAILURE',
        channel: 'WEBHOOK',
        recipient: 'ops',
        apiId: target.id,
        errorMessage: message,
      });
      return { kind: 'dead_lettered', error: message };
    }
  } finally {
    await releaseLock(key, workerId).catch(() => {
      /* lock will expire via TTL */
    });
  }
}
