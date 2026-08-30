import { env } from '../../config/index.js';
import { componentLogger } from '../../lib/logger.js';
import { runSlaReports } from './sla.service.js';

const log = componentLogger('report-runner');

export interface ReportRunnerHandle {
  stop(): void;
  /** Runs one refresh now (tests). */
  runOnce(): Promise<void>;
}

async function cycle(): Promise<void> {
  try {
    await runSlaReports();
  } catch (err: unknown) {
    log.error({ err }, 'SLA report refresh failed');
  }
}

/**
 * Refreshes SLA reports on an interval. Runs in the scheduler process alongside
 * the cron engine and the alert runner.
 */
export function startReportRunner(
  intervalMs = env().SLA_REPORT_INTERVAL_MINUTES * 60_000,
): ReportRunnerHandle {
  void cycle();
  const timer = setInterval(() => void cycle(), intervalMs);
  timer.unref();
  return {
    stop: (): void => clearInterval(timer),
    runOnce: cycle,
  };
}
