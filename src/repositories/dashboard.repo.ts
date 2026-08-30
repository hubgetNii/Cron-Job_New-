import { query } from '../lib/db.js';
import type { HealthStatus } from '../domain/enums.js';

export interface DashboardSummary {
  targets: {
    total: number;
    active: number;
    moneyMoving: number;
    byStatus: Record<HealthStatus | 'PENDING', number>;
  };
  incidents: {
    open: number;
    acknowledged: number;
    resolved24h: number;
    bySeverity: Record<string, number>;
    flapping: number;
  };
  alerts: { pending: number; failed24h: number; suppressed24h: number };
  uptime24h: number | null;
  checks24h: number;
}

export async function getDashboardSummary(): Promise<DashboardSummary> {
  const [targets, statuses, incidents, severity, alerts, uptime] = await Promise.all([
    query<{ total: string; active: string; money: string }>(
      `SELECT count(*) total,
              count(*) FILTER (WHERE is_active) active,
              count(*) FILTER (WHERE is_money_moving) money
       FROM monitored_apis`,
    ),
    query<{ status: HealthStatus | null; n: string }>(
      `SELECT s.last_status status, count(*) n
       FROM monitored_apis m
       LEFT JOIN target_schedule_state s ON s.target_id = m.id
       WHERE m.is_active
       GROUP BY s.last_status`,
    ),
    query<{ open: string; ack: string; resolved: string; flapping: string }>(
      `SELECT count(*) FILTER (WHERE status = 'OPEN') open,
              count(*) FILTER (WHERE status = 'ACKNOWLEDGED') ack,
              count(*) FILTER (WHERE status = 'RESOLVED' AND resolved_at > now() - interval '24 hours') resolved,
              count(*) FILTER (WHERE status <> 'RESOLVED' AND incident_type = 'FLAPPING') flapping
       FROM incidents`,
    ),
    query<{ severity: string; n: string }>(
      `SELECT severity, count(*) n FROM incidents WHERE status <> 'RESOLVED' GROUP BY severity`,
    ),
    query<{ pending: string; failed: string; suppressed: string }>(
      `SELECT count(*) FILTER (WHERE status = 'PENDING') pending,
              count(*) FILTER (WHERE status = 'FAILED' AND created_at > now() - interval '24 hours') failed,
              count(*) FILTER (WHERE status = 'SUPPRESSED' AND created_at > now() - interval '24 hours') suppressed
       FROM alerts`,
    ),
    query<{ up: string; total: string }>(
      `SELECT count(*) FILTER (WHERE status IN ('UP','DEGRADED')) up, count(*) total
       FROM health_check_results WHERE checked_at > now() - interval '24 hours'`,
    ),
  ]);

  const byStatus: DashboardSummary['targets']['byStatus'] = {
    UP: 0,
    DOWN: 0,
    DEGRADED: 0,
    UNKNOWN: 0,
    PENDING: 0,
  };
  for (const row of statuses.rows) {
    byStatus[row.status ?? 'PENDING'] = Number(row.n);
  }

  const bySeverity: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const row of severity.rows) bySeverity[row.severity] = Number(row.n);

  const t = targets.rows[0]!;
  const i = incidents.rows[0]!;
  const a = alerts.rows[0]!;
  const u = uptime.rows[0]!;
  const checks = Number(u.total);

  return {
    targets: {
      total: Number(t.total),
      active: Number(t.active),
      moneyMoving: Number(t.money),
      byStatus,
    },
    incidents: {
      open: Number(i.open),
      acknowledged: Number(i.ack),
      resolved24h: Number(i.resolved),
      bySeverity,
      flapping: Number(i.flapping),
    },
    alerts: {
      pending: Number(a.pending),
      failed24h: Number(a.failed),
      suppressed24h: Number(a.suppressed),
    },
    uptime24h: checks > 0 ? Number(((Number(u.up) / checks) * 100).toFixed(3)) : null,
    checks24h: checks,
  };
}

export interface PerfBucket {
  bucket: string;
  avgMs: number | null;
  p95Ms: number | null;
  up: number;
  down: number;
  degraded: number;
}

/** Response-time + status counts bucketed over the last N hours, for the overview chart. */
export async function getPerformanceSeries(hours = 6): Promise<PerfBucket[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT to_char(date_trunc('minute', checked_at)
              - (extract(minute FROM checked_at)::int % 5) * interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:00Z') bucket,
            round(avg(response_time_ms))::int avg_ms,
            percentile_disc(0.95) WITHIN GROUP (ORDER BY response_time_ms)::int p95_ms,
            count(*) FILTER (WHERE status = 'UP') up,
            count(*) FILTER (WHERE status = 'DOWN') down,
            count(*) FILTER (WHERE status = 'DEGRADED') degraded
     FROM health_check_results
     WHERE checked_at > now() - ($1::int * interval '1 hour')
     GROUP BY 1 ORDER BY 1`,
    [hours],
  );
  return rows.map((r) => ({
    bucket: r['bucket'] as string,
    avgMs: (r['avg_ms'] as number | null) ?? null,
    p95Ms: (r['p95_ms'] as number | null) ?? null,
    up: Number(r['up']),
    down: Number(r['down']),
    degraded: Number(r['degraded']),
  }));
}

export interface TargetStatusRow {
  id: string;
  name: string;
  endpointClass: string;
  environment: string;
  isMoneyMoving: boolean;
  isActive: boolean;
  status: HealthStatus | null;
  lastActualRunAt: Date | null;
  lastResponseMs: number | null;
  uptime24h: number | null;
  openIncidentId: string | null;
}

export async function getTargetStatusBoard(): Promise<TargetStatusRow[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT m.id, m.name, m.endpoint_class, m.environment, m.is_money_moving, m.is_active,
            s.last_status, s.last_actual_run_at,
            (SELECT response_time_ms FROM health_check_results r
             WHERE r.api_id = m.id ORDER BY r.checked_at DESC LIMIT 1) last_response_ms,
            (SELECT round(100.0 * count(*) FILTER (WHERE status IN ('UP','DEGRADED')) / NULLIF(count(*), 0), 2)
             FROM health_check_results r
             WHERE r.api_id = m.id AND r.checked_at > now() - interval '24 hours') uptime_24h,
            (SELECT id FROM incidents i WHERE i.api_id = m.id AND i.status <> 'RESOLVED' LIMIT 1) open_incident_id
     FROM monitored_apis m
     LEFT JOIN target_schedule_state s ON s.target_id = m.id
     ORDER BY m.is_money_moving DESC, m.name`,
  );
  return rows.map((r) => ({
    id: r['id'] as string,
    name: r['name'] as string,
    endpointClass: r['endpoint_class'] as string,
    environment: r['environment'] as string,
    isMoneyMoving: r['is_money_moving'] as boolean,
    isActive: r['is_active'] as boolean,
    status: (r['last_status'] as HealthStatus | null) ?? null,
    lastActualRunAt: (r['last_actual_run_at'] as Date | null) ?? null,
    lastResponseMs: (r['last_response_ms'] as number | null) ?? null,
    uptime24h: r['uptime_24h'] != null ? Number(r['uptime_24h']) : null,
    openIncidentId: (r['open_incident_id'] as string | null) ?? null,
  }));
}

export interface HealthCheckRow {
  id: string;
  checkedAt: Date;
  status: HealthStatus;
  httpStatus: number | null;
  responseTimeMs: number | null;
  errorType: string | null;
  errorMessage: string | null;
}

export async function getRecentHealthChecks(apiId: string, limit = 100): Promise<HealthCheckRow[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id, checked_at, status, http_status, response_time_ms, error_type, error_message
     FROM health_check_results WHERE api_id = $1 ORDER BY checked_at DESC LIMIT $2`,
    [apiId, Math.min(limit, 500)],
  );
  return rows.map((r) => ({
    id: r['id'] as string,
    checkedAt: r['checked_at'] as Date,
    status: r['status'] as HealthStatus,
    httpStatus: (r['http_status'] as number | null) ?? null,
    responseTimeMs: (r['response_time_ms'] as number | null) ?? null,
    errorType: (r['error_type'] as string | null) ?? null,
    errorMessage: (r['error_message'] as string | null) ?? null,
  }));
}
