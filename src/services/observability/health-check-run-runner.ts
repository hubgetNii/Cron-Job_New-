import { env } from '../../config/index.js';
import { componentLogger } from '../../lib/logger.js';
import { rollUpRun } from './health-check-run.service.js';
import { pruneRuns } from '../../repositories/health-check-runs.repo.js';

const log = componentLogger('health-check-run-runner');

export interface HealthCheckRunHandle {
  stop(): void;
  runOnce(): Promise<void>;
}

let cyclesSincePrune = 0;

async function cycle(): Promise<void> {
  try {
    await rollUpRun();
    // Prune roughly hourly (every 12th cycle at the 5-min default).
    if (++cyclesSincePrune >= 12) {
      cyclesSincePrune = 0;
      const deleted = await pruneRuns(env().HEALTH_CHECK_RUN_RETENTION_DAYS);
      if (deleted > 0) log.info({ deleted }, 'pruned old health check runs');
    }
  } catch (err: unknown) {
    log.error({ err }, 'health check run roll-up failed');
  }
}

/** Rolls per-target checks into Health Check Run records on an interval. */
export function startHealthCheckRunRunner(
  intervalMs = env().HEALTH_CHECK_RUN_INTERVAL_MINUTES * 60_000,
): HealthCheckRunHandle {
  const timer = setInterval(() => void cycle(), intervalMs);
  timer.unref();
  return { stop: (): void => clearInterval(timer), runOnce: cycle };
}
