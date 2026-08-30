import { query } from '../lib/db.js';

export interface SlaComputation {
  downtimeSeconds: number;
  excludedSeconds: number;
  totalChecks: number;
  failedChecks: number;
}

export interface SlaReport {
  id: string;
  apiId: string;
  periodKind: 'rolling_30d' | 'calendar_month';
  periodStart: Date;
  periodEnd: Date;
  uptimePercent: number | null;
  downtimeSeconds: number;
  excludedSeconds: number;
  slaTargetPercent: number;
  slaMet: boolean;
  totalChecks: number;
  failedChecks: number;
  generatedAt: Date;
}

const COLUMNS = `
  id, api_id, period_kind, period_start, period_end, uptime_percent, downtime_seconds,
  excluded_seconds, sla_target_percent, sla_met, total_checks, failed_checks, generated_at`;

function toDomain(r: Record<string, unknown>): SlaReport {
  return {
    id: r['id'] as string,
    apiId: r['api_id'] as string,
    periodKind: r['period_kind'] as 'rolling_30d' | 'calendar_month',
    periodStart: r['period_start'] as Date,
    periodEnd: r['period_end'] as Date,
    uptimePercent: r['uptime_percent'] != null ? Number(r['uptime_percent']) : null,
    downtimeSeconds: Number(r['downtime_seconds']),
    excludedSeconds: Number(r['excluded_seconds']),
    slaTargetPercent: Number(r['sla_target_percent']),
    slaMet: r['sla_met'] as boolean,
    totalChecks: Number(r['total_checks']),
    failedChecks: Number(r['failed_checks']),
    generatedAt: r['generated_at'] as Date,
  };
}

interface UpsertInput extends SlaComputation {
  apiId: string;
  periodStart: Date;
  periodEnd: Date;
  slaTargetPercent: number;
  slaMet: boolean;
  uptimePercent: number | null;
}

export async function upsertRollingReport(input: UpsertInput): Promise<SlaReport> {
  const { rows } = await query(
    `INSERT INTO sla_reports
       (api_id, period_kind, period_start, period_end, uptime_percent, downtime_seconds,
        excluded_seconds, sla_target_percent, sla_met, total_checks, failed_checks, generated_at)
     VALUES ($1, 'rolling_30d', $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (api_id) WHERE period_kind = 'rolling_30d'
     DO UPDATE SET
       period_start = EXCLUDED.period_start,
       period_end = EXCLUDED.period_end,
       uptime_percent = EXCLUDED.uptime_percent,
       downtime_seconds = EXCLUDED.downtime_seconds,
       excluded_seconds = EXCLUDED.excluded_seconds,
       sla_target_percent = EXCLUDED.sla_target_percent,
       sla_met = EXCLUDED.sla_met,
       total_checks = EXCLUDED.total_checks,
       failed_checks = EXCLUDED.failed_checks,
       generated_at = now()
     RETURNING ${COLUMNS}`,
    [
      input.apiId,
      input.periodStart,
      input.periodEnd,
      input.uptimePercent,
      input.downtimeSeconds,
      input.excludedSeconds,
      input.slaTargetPercent,
      input.slaMet,
      input.totalChecks,
      input.failedChecks,
    ],
  );
  return toDomain(rows[0]!);
}

export async function upsertCalendarMonthReport(input: UpsertInput): Promise<SlaReport> {
  const { rows } = await query(
    `INSERT INTO sla_reports
       (api_id, period_kind, period_start, period_end, uptime_percent, downtime_seconds,
        excluded_seconds, sla_target_percent, sla_met, total_checks, failed_checks, generated_at)
     VALUES ($1, 'calendar_month', $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT ON CONSTRAINT sla_reports_period_unique
     DO UPDATE SET
       uptime_percent = EXCLUDED.uptime_percent,
       downtime_seconds = EXCLUDED.downtime_seconds,
       excluded_seconds = EXCLUDED.excluded_seconds,
       sla_target_percent = EXCLUDED.sla_target_percent,
       sla_met = EXCLUDED.sla_met,
       total_checks = EXCLUDED.total_checks,
       failed_checks = EXCLUDED.failed_checks,
       generated_at = now()
     RETURNING ${COLUMNS}`,
    [
      input.apiId,
      input.periodStart,
      input.periodEnd,
      input.uptimePercent,
      input.downtimeSeconds,
      input.excludedSeconds,
      input.slaTargetPercent,
      input.slaMet,
      input.totalChecks,
      input.failedChecks,
    ],
  );
  return toDomain(rows[0]!);
}

export async function latestRollingByTarget(): Promise<SlaReport[]> {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM sla_reports WHERE period_kind = 'rolling_30d' ORDER BY uptime_percent ASC NULLS LAST`,
  );
  return (rows as Array<Record<string, unknown>>).map(toDomain);
}

export interface SlaSummaryRow {
  apiId: string;
  targetName: string;
  endpointClass: string;
  isMoneyMoving: boolean;
  uptimePercent: number | null;
  slaTargetPercent: number;
  slaMet: boolean;
  downtimeSeconds: number;
  excludedSeconds: number;
  generatedAt: Date;
}

export async function slaSummary(): Promise<SlaSummaryRow[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT s.api_id, m.name AS target_name, m.endpoint_class, m.is_money_moving,
            s.uptime_percent, s.sla_target_percent, s.sla_met, s.downtime_seconds,
            s.excluded_seconds, s.generated_at
     FROM sla_reports s
     JOIN monitored_apis m ON m.id = s.api_id
     WHERE s.period_kind = 'rolling_30d'
     ORDER BY s.sla_met ASC, s.uptime_percent ASC NULLS LAST`,
  );
  return rows.map((r) => ({
    apiId: r['api_id'] as string,
    targetName: r['target_name'] as string,
    endpointClass: r['endpoint_class'] as string,
    isMoneyMoving: r['is_money_moving'] as boolean,
    uptimePercent: r['uptime_percent'] != null ? Number(r['uptime_percent']) : null,
    slaTargetPercent: Number(r['sla_target_percent']),
    slaMet: r['sla_met'] as boolean,
    downtimeSeconds: Number(r['downtime_seconds']),
    excludedSeconds: Number(r['excluded_seconds']),
    generatedAt: r['generated_at'] as Date,
  }));
}

export async function reportsForTarget(apiId: string): Promise<SlaReport[]> {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM sla_reports WHERE api_id = $1
     ORDER BY period_kind, period_end DESC LIMIT 50`,
    [apiId],
  );
  return (rows as Array<Record<string, unknown>>).map(toDomain);
}

/** Calendar-month reports whose period overlaps [from, to) — for compliance exports. */
export async function monthlyReportsInRange(from: Date, to: Date): Promise<SlaReport[]> {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM sla_reports
     WHERE period_kind = 'calendar_month' AND period_start < $2 AND period_end > $1
     ORDER BY period_start, api_id`,
    [from, to],
  );
  return (rows as Array<Record<string, unknown>>).map(toDomain);
}
