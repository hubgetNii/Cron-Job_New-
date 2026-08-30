import { componentLogger } from '../../lib/logger.js';
import { runEscalationCycle } from './escalation.service.js';
import { runDeliveryCycle } from './delivery.service.js';

const log = componentLogger('alert-runner');

export interface AlertRunnerHandle {
  stop(): void;
  /** Runs one full cycle now (tests). */
  runOnce(): Promise<void>;
}

async function cycle(): Promise<void> {
  const esc = await runEscalationCycle();
  const del = await runDeliveryCycle();
  if (esc.tiersFired > 0 || del.delivered > 0 || del.failed > 0 || del.suppressed > 0) {
    log.info({ ...esc, ...del }, 'alert cycle');
  }
}

/**
 * Drives escalation + delivery on an interval. Runs in the scheduler process
 * alongside the cron engine.
 */
export function startAlertRunner(intervalMs = 15_000): AlertRunnerHandle {
  const run = (): void => {
    void cycle().catch((err: unknown) => log.error({ err }, 'alert cycle failed'));
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return {
    stop: (): void => clearInterval(timer),
    runOnce: cycle,
  };
}
