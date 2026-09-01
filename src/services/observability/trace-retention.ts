import { env } from '../../config/index.js';
import { componentLogger } from '../../lib/logger.js';
import { pruneTraces } from '../../repositories/health-check-traces.repo.js';

const log = componentLogger('trace-retention');

export interface TraceRetentionHandle {
  stop(): void;
  runOnce(): Promise<void>;
}

async function cycle(): Promise<void> {
  try {
    const deleted = await pruneTraces(env().TRACE_RETENTION_DAYS);
    if (deleted > 0) log.info({ deleted, retentionDays: env().TRACE_RETENTION_DAYS }, 'pruned old traces');
  } catch (err: unknown) {
    log.error({ err }, 'trace prune failed');
  }
}

/** Prunes health_check_traces past TRACE_RETENTION_DAYS, hourly. */
export function startTraceRetention(intervalMs = 3_600_000): TraceRetentionHandle {
  void cycle();
  const timer = setInterval(() => void cycle(), intervalMs);
  timer.unref();
  return { stop: (): void => clearInterval(timer), runOnce: cycle };
}
