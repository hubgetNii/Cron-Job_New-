import { query, sql, type SqlRunner } from '../lib/db.js';
import type { SystemHealthLevel } from './health-digests.repo.js';
import type { Environment, HealthStatus } from '../domain/enums.js';

function runner(client?: SqlRunner): SqlRunner {
  return client ?? sql;
}

export interface HealthCheckRun {
  id: string;
  hcId: string;
  windowStart: string;
  windowEnd: string;
  environment: Environment | null;
  servicesTested: number;
  healthy: number;
  degraded: number;
  failed: number;
  unknown: number;
  checksTotal: number;
  overallStatus: SystemHealthLevel;
  durationMs: number | null;
  createdAt: string;
}

function toRun(r: Record<string, unknown>): HealthCheckRun {
  return {
    id: r['id'] as string,
    hcId: r['hc_id'] as string,
    windowStart: (r['window_start'] as Date).toISOString(),
    windowEnd: (r['window_end'] as Date).toISOString(),
    environment: (r['environment'] as Environment | null) ?? null,
    servicesTested: Number(r['services_tested']),
    healthy: Number(r['healthy']),
    degraded: Number(r['degraded']),
    failed: Number(r['failed']),
    unknown: Number(r['unknown']),
    checksTotal: Number(r['checks_total']),
    overallStatus: r['overall_status'] as SystemHealthLevel,
    durationMs: (r['duration_ms'] as number | null) ?? null,
    createdAt: (r['created_at'] as Date).toISOString(),
  };
}

/** `HC-20260901-103002-001245` — date, window-end time, zero-padded sequence. */
export async function nextHcId(windowEnd: Date, client?: SqlRunner): Promise<string> {
  const { rows } = await runner(client).query<{ n: string }>(
    `SELECT nextval('health_check_run_seq')::text AS n`,
  );
  const seq = String(rows[0]!.n).padStart(6, '0').slice(-6);
  const d = windowEnd;
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `HC-${date}-${time}-${seq}`;
}

export interface InsertRunInput {
  hcId: string;
  windowStart: Date;
  windowEnd: Date;
  environment: Environment | null;
  servicesTested: number;
  healthy: number;
  degraded: number;
  failed: number;
  unknown: number;
  checksTotal: number;
  overallStatus: SystemHealthLevel;
  durationMs: number | null;
}

export async function insertRun(input: InsertRunInput, client?: SqlRunner): Promise<string> {
  const { rows } = await runner(client).query<{ id: string }>(
    `INSERT INTO health_check_runs
       (hc_id, window_start, window_end, environment, services_tested, healthy,
        degraded, failed, unknown, checks_total, overall_status, duration_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [
      input.hcId,
      input.windowStart,
      input.windowEnd,
      input.environment,
      input.servicesTested,
      input.healthy,
      input.degraded,
      input.failed,
      input.unknown,
      input.checksTotal,
      input.overallStatus,
      input.durationMs,
    ],
  );
  return rows[0]!.id;
}

/** Links every unassigned check inside the window to this run. Returns the count. */
export async function backfillRunLinks(
  runId: string,
  windowStart: Date,
  windowEnd: Date,
  client?: SqlRunner,
): Promise<number> {
  const { rowCount } = await runner(client).query(
    `UPDATE health_check_results
       SET hc_run_id = $1
     WHERE hc_run_id IS NULL AND checked_at >= $2 AND checked_at < $3`,
    [runId, windowStart, windowEnd],
  );
  return rowCount ?? 0;
}

/** End of the most recent run's window, or null. */
export async function latestRunWindowEnd(): Promise<Date | null> {
  const { rows } = await query<{ window_end: Date }>(
    `SELECT window_end FROM health_check_runs ORDER BY window_end DESC LIMIT 1`,
  );
  return rows[0]?.window_end ?? null;
}

export async function listRuns(limit = 50): Promise<HealthCheckRun[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT * FROM health_check_runs ORDER BY window_end DESC LIMIT $1`,
    [Math.min(limit, 200)],
  );
  return rows.map(toRun);
}

export async function getRunByHcId(hcId: string): Promise<HealthCheckRun | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT * FROM health_check_runs WHERE hc_id = $1`,
    [hcId],
  );
  return rows[0] ? toRun(rows[0]) : null;
}

export interface RunServiceRow {
  checkId: string;
  apiId: string;
  targetName: string;
  endpointClass: string;
  isMoneyMoving: boolean;
  status: HealthStatus;
  httpStatus: number | null;
  responseTimeMs: number | null;
  errorType: string | null;
  errorMessage: string | null;
  checkedAt: string;
}

/** Per-service breakdown for one run — the latest check per target in the window. */
export async function runServices(runId: string): Promise<RunServiceRow[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT DISTINCT ON (r.api_id)
            r.id, r.api_id, m.name AS target_name, m.endpoint_class, m.is_money_moving,
            r.status, r.http_status, r.response_time_ms, r.error_type, r.error_message, r.checked_at
     FROM health_check_results r
     JOIN monitored_apis m ON m.id = r.api_id
     WHERE r.hc_run_id = $1
     ORDER BY r.api_id, r.checked_at DESC`,
    [runId],
  );
  return rows.map((r) => ({
    checkId: r['id'] as string,
    apiId: r['api_id'] as string,
    targetName: r['target_name'] as string,
    endpointClass: r['endpoint_class'] as string,
    isMoneyMoving: r['is_money_moving'] as boolean,
    status: r['status'] as HealthStatus,
    httpStatus: (r['http_status'] as number | null) ?? null,
    responseTimeMs: (r['response_time_ms'] as number | null) ?? null,
    errorType: (r['error_type'] as string | null) ?? null,
    errorMessage: (r['error_message'] as string | null) ?? null,
    checkedAt: (r['checked_at'] as Date).toISOString(),
  }));
}

export async function pruneRuns(days: number): Promise<number> {
  const { rowCount } = await query(
    `DELETE FROM health_check_runs WHERE window_end < now() - ($1::int * interval '1 day')`,
    [days],
  );
  return rowCount ?? 0;
}
