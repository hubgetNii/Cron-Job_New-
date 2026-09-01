import { env } from '../../config/index.js';
import { componentLogger } from '../../lib/logger.js';
import { query } from '../../lib/db.js';
import { rollUp } from '../digest/health-digest.service.js';
import {
  backfillRunLinks,
  insertRun,
  latestRunWindowEnd,
  nextHcId,
  type HealthCheckRun,
} from '../../repositories/health-check-runs.repo.js';
import { listRuns, getRunByHcId, runServices } from '../../repositories/health-check-runs.repo.js';
import type { Environment } from '../../domain/enums.js';

const log = componentLogger('health-check-run');

export { listRuns, getRunByHcId, runServices };

interface WindowRow {
  api_id: string;
  status: string;
  is_money_moving: boolean;
  endpoint_class: string;
  environment: Environment;
}

/**
 * Rolls every check in the window `[start, end)` into one Health Check Run
 * record (spec §2). The window defaults to "since the last run" so a missed
 * cycle is absorbed by the next one. Idempotent-ish: it will not create a run
 * for a window with zero checks.
 */
export async function rollUpRun(now: Date = new Date()): Promise<HealthCheckRun | null> {
  const intervalMs = env().HEALTH_CHECK_RUN_INTERVAL_MINUTES * 60_000;
  const lastEnd = await latestRunWindowEnd();
  let start = lastEnd ?? new Date(now.getTime() - intervalMs);
  // Guard against a huge catch-up window after a long outage of the runner.
  const maxLookback = new Date(now.getTime() - 6 * intervalMs);
  if (start < maxLookback) start = maxLookback;
  if (start >= now) return null;

  const latest = await query<WindowRow>(
    `SELECT DISTINCT ON (r.api_id)
            r.api_id, r.status, m.is_money_moving, m.endpoint_class, m.environment
     FROM health_check_results r
     JOIN monitored_apis m ON m.id = r.api_id
     WHERE r.checked_at >= $1 AND r.checked_at < $2
     ORDER BY r.api_id, r.checked_at DESC`,
    [start, now],
  );
  if (latest.rows.length === 0) return null;

  const totals = await query<{ total_checks: string; dur_ms: string | null }>(
    `SELECT count(*)::text AS total_checks, sum(response_time_ms)::text AS dur_ms
     FROM health_check_results
     WHERE checked_at >= $1 AND checked_at < $2`,
    [start, now],
  );

  const services = latest.rows;
  const healthy = services.filter((s) => s.status === 'UP').length;
  const degraded = services.filter((s) => s.status === 'DEGRADED').length;
  const failed = services.filter((s) => s.status === 'DOWN').length;
  const unknown = services.filter((s) => s.status === 'UNKNOWN').length;

  const envs = [...new Set(services.map((s) => s.environment))];
  const environment: Environment | null = envs.length === 1 ? envs[0]! : null;

  const overallStatus = rollUp(
    services.map((s) => ({
      status: s.status,
      isMoneyMoving: s.is_money_moving,
      endpointClass: s.endpoint_class,
    })),
  );

  const durMs = totals.rows[0]?.dur_ms;
  const hcId = await nextHcId(now);
  const runId = await insertRun({
    hcId,
    windowStart: start,
    windowEnd: now,
    environment,
    servicesTested: services.length,
    healthy,
    degraded,
    failed,
    unknown,
    checksTotal: Number(totals.rows[0]?.total_checks ?? '0'),
    overallStatus,
    durationMs: durMs != null ? Math.round(Number(durMs)) : null,
  });
  const linked = await backfillRunLinks(runId, start, now);

  log.info(
    { hcId, servicesTested: services.length, healthy, degraded, failed, overallStatus, linked },
    'health check run recorded',
  );

  return {
    id: runId,
    hcId,
    windowStart: start.toISOString(),
    windowEnd: now.toISOString(),
    environment,
    servicesTested: services.length,
    healthy,
    degraded,
    failed,
    unknown,
    checksTotal: Number(totals.rows[0]?.total_checks ?? '0'),
    overallStatus,
    durationMs: durMs != null ? Math.round(Number(durMs)) : null,
    createdAt: new Date().toISOString(),
  };
}
