import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { withTransaction } from '../../lib/db.js';
import { assertValidCron, intervalSeconds, nextSlot } from '../../lib/cron.js';
import { componentLogger } from '../../lib/logger.js';
import { findTargetById } from '../../repositories/monitored-apis.repo.js';
import * as repo from '../../repositories/load-test-schedules.repo.js';
import { getCorrectnessRun } from '../../repositories/load-test-correctness.repo.js';
import { recordAudit, type AuditActor } from '../audit/audit.service.js';
import { queueCorrectnessRun } from './correctness.service.js';

/**
 * Scheduled regression (B5/B13). Only the correctness and security suites can be
 * scheduled — they are bounded and go through the same safety gate as a manual run,
 * so a schedule can never get past what a person could not start by hand.
 */
const log = componentLogger('loadtest-schedule');

/** Suites are not a monitoring probe; hourly is the floor. */
export const MIN_INTERVAL_SECONDS = 3600;

export function validateCron(cron: string, from = new Date()): Date {
  assertValidCron(cron);
  if (intervalSeconds(cron, from) < MIN_INTERVAL_SECONDS) {
    throw new ValidationError('Scheduled suites may run at most once an hour.');
  }
  return nextSlot(cron, from);
}

export async function createSchedule(
  input: { apiId: string; suite: repo.ScheduleSuite; cron: string },
  actor: AuditActor,
): Promise<repo.LoadSchedule> {
  const target = await findTargetById(input.apiId);
  if (!target) throw new NotFoundError('Target not found');
  const next = validateCron(input.cron);
  const s = await repo.upsertSchedule({
    ...input,
    nextRunAt: next,
    createdBy: actor.userId ?? null,
  });
  await recordAudit({
    actor,
    action: 'load_test.schedule.saved',
    entityType: 'load_test_schedule',
    entityId: s.id,
    summary: `${input.suite} on ${target.name}: ${input.cron}`,
  });
  return s;
}

export async function setScheduleEnabled(
  id: string,
  enabled: boolean,
  actor: AuditActor,
): Promise<repo.LoadSchedule> {
  const s = await repo.getSchedule(id);
  if (!s) throw new NotFoundError('Schedule not found');
  // Re-enabling must not fire a backlog of missed slots.
  await repo.setEnabled(id, enabled, enabled ? nextSlot(s.cron) : null);
  await recordAudit({
    actor,
    action: enabled ? 'load_test.schedule.enabled' : 'load_test.schedule.disabled',
    entityType: 'load_test_schedule',
    entityId: id,
    summary: `${s.suite} on ${s.targetName ?? s.apiId}`,
  });
  return (await repo.getSchedule(id))!;
}

export async function removeSchedule(id: string, actor: AuditActor): Promise<void> {
  const s = await repo.getSchedule(id);
  if (!s || !(await repo.deleteSchedule(id))) throw new NotFoundError('Schedule not found');
  await recordAudit({
    actor,
    action: 'load_test.schedule.deleted',
    entityType: 'load_test_schedule',
    entityId: id,
    summary: `${s.suite} on ${s.targetName ?? s.apiId}`,
  });
}

const SYSTEM: AuditActor = { userId: null, label: 'system:schedule' };

/**
 * Fires every due schedule once. Each schedule always advances to its next future
 * slot, so downtime never causes a burst of catch-up runs. Returns how many were queued.
 */
export async function tickSchedules(now = new Date()): Promise<number> {
  let queued = 0;
  await withTransaction(async (client) => {
    for (const s of await repo.lockDue(client, now)) {
      const next = nextSlot(s.cron, now);
      let outcome: repo.ScheduleOutcome = 'QUEUED';
      let message: string | null = null;
      let runId: string | null = null;
      try {
        const prev = s.lastRunId ? await getCorrectnessRun(s.lastRunId) : null;
        if (prev && ['QUEUED', 'PREFLIGHT', 'RUNNING'].includes(prev.status)) {
          outcome = 'SKIPPED_BUSY';
          message = 'The previous scheduled run had not finished.';
        } else {
          runId = (await queueCorrectnessRun(s.apiId, undefined, SYSTEM, s.suite)).id;
          queued++;
        }
      } catch (err) {
        const refused = err instanceof ValidationError;
        outcome = refused ? 'REFUSED' : 'ERROR';
        message = err instanceof Error ? err.message.slice(0, 500) : 'Unknown error';
        log.warn({ scheduleId: s.id, outcome, message }, 'scheduled run not queued');
      }
      await repo.recordFire(client, s.id, { nextRunAt: next, at: now, runId, outcome, message });
    }
  });
  return queued;
}
