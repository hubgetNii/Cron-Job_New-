import { componentLogger } from '../../lib/logger.js';
import { intervalSeconds, previousSlot } from '../../lib/cron.js';
import type { MonitoredApi } from '../../domain/target.js';
import {
  bumpMissedRunCount,
  getScheduleState,
  recordAlert,
} from '../../repositories/scheduler.repo.js';

const log = componentLogger('missed-run');

/** Multiple of the interval a run may be late before it counts as missed. */
const TOLERANCE_MULTIPLE = 2;

export interface MissedRun {
  targetId: string;
  name: string;
  expectedRunAt: Date;
  lastActualRunAt: Date | null;
  lateBySeconds: number;
}

/**
 * Flags targets whose most recent expected slot did not run within
 * `TOLERANCE_MULTIPLE × interval`. This indicates the MONITOR is unhealthy for
 * that target (a wedged worker, a persistent dead-letter), which is a distinct
 * alarm from the target being DOWN (see vault: "Drift Correction and
 * Missed-Run Detection"). Scheduler-wide silence is the watchdog's job.
 */
export async function detectMissedRuns(
  targets: MonitoredApi[],
  now: Date = new Date(),
): Promise<MissedRun[]> {
  const missed: MissedRun[] = [];

  for (const target of targets) {
    const interval = intervalSeconds(target.frequencyCron, now);
    const expected = previousSlot(target.frequencyCron, now);
    const toleranceMs = interval * 1000 * TOLERANCE_MULTIPLE;

    const state = await getScheduleState(target.id);
    const lastActual = state?.lastActualRunAt ?? null;

    // Grace on boot: a target with no recorded run yet is only "missed" once it
    // has been registered longer than the tolerance window.
    const reference = lastActual ?? state?.updatedAt ?? target.createdAt;
    const lateByMs = now.getTime() - reference.getTime();

    if (lateByMs > toleranceMs && expected.getTime() > (lastActual?.getTime() ?? 0)) {
      const record: MissedRun = {
        targetId: target.id,
        name: target.name,
        expectedRunAt: expected,
        lastActualRunAt: lastActual,
        lateBySeconds: Math.round(lateByMs / 1000),
      };
      missed.push(record);
      log.warn(record, 'scheduled run missed');
      await bumpMissedRunCount(target.id, 1);
      await recordAlert({
        alertType: 'SCHEDULER_HEARTBEAT_MISSED',
        channel: 'WEBHOOK',
        recipient: 'ops',
        apiId: target.id,
        errorMessage: `No check for "${target.name}" in ${record.lateBySeconds}s (interval ${interval}s)`,
      });
    }
  }

  return missed;
}
