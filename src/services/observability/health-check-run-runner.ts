import { env } from '../../config/index.js';
import { componentLogger } from '../../lib/logger.js';
import { rollUpRun } from './health-check-run.service.js';

const log = componentLogger('health-check-run-runner');

export interface HealthCheckRunHandle {
  stop(): void;
  runOnce(): Promise<void>;
}

async function cycle(): Promise<void> {
  try {
    await rollUpRun();
  } catch (err: unknown) {
    log.error({ err }, 'health check run roll-up failed');
  }
}

/**
 * Rolls per-target checks into Health Check Run records on an interval.
 * Retention of the run records is handled by the retention sweep.
 */
export function startHealthCheckRunRunner(
  intervalMs = env().HEALTH_CHECK_RUN_INTERVAL_MINUTES * 60_000,
): HealthCheckRunHandle {
  const timer = setInterval(() => void cycle(), intervalMs);
  timer.unref();
  return { stop: (): void => clearInterval(timer), runOnce: cycle };
}
