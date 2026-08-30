import { componentLogger } from '../../lib/logger.js';
import { query } from '../../lib/db.js';
import { listTargets } from '../../repositories/monitored-apis.repo.js';
import {
  upsertRollingReport,
  upsertCalendarMonthReport,
  type SlaComputation,
} from '../../repositories/sla-reports.repo.js';

const log = componentLogger('sla');

export interface SlaResult extends SlaComputation {
  apiId: string;
  periodStart: Date;
  periodEnd: Date;
  slaTargetPercent: number;
  slaMet: boolean;
  /** null when the window had no checks at all. */
  uptimePercent: number | null;
}

/**
 * Count-based uptime over `[periodStart, periodEnd)`, matching the rest of the
 * codebase (DEGRADED counts as up). Checks that fall inside an approved
 * maintenance window are excluded from the SLA-breach math but their downtime
 * is still recorded (see vault: "SLA and Uptime" — never silently deleted).
 */
export async function computeSla(
  apiId: string,
  periodStart: Date,
  periodEnd: Date,
  slaTargetPercent: number,
): Promise<SlaResult> {
  const { rows } = await query<Record<string, unknown>>(
    `WITH checks AS (
       SELECT r.status,
              EXISTS (
                SELECT 1 FROM maintenance_windows w
                WHERE (w.target_id = r.api_id OR w.target_id IS NULL)
                  AND w.starts_at <= r.checked_at AND w.ends_at > r.checked_at
              ) AS in_maint
       FROM health_check_results r
       WHERE r.api_id = $1 AND r.checked_at >= $2 AND r.checked_at < $3
     )
     SELECT
       count(*)                                                              AS total_all,
       count(*) FILTER (WHERE status = 'DOWN')                               AS down_all,
       count(*) FILTER (WHERE NOT in_maint)                                  AS total_sla,
       count(*) FILTER (WHERE NOT in_maint AND status IN ('UP','DEGRADED'))  AS up_sla,
       count(*) FILTER (WHERE in_maint AND status = 'DOWN')                  AS down_maint
     FROM checks`,
    [apiId, periodStart, periodEnd],
  );
  const r = rows[0]!;
  const totalAll = Number(r['total_all']);
  const downAll = Number(r['down_all']);
  const totalSla = Number(r['total_sla']);
  const upSla = Number(r['up_sla']);
  const downMaint = Number(r['down_maint']);

  const periodSeconds = Math.round((periodEnd.getTime() - periodStart.getTime()) / 1000);
  const downtimeSeconds = totalAll > 0 ? Math.round((downAll / totalAll) * periodSeconds) : 0;
  const excludedSeconds = totalAll > 0 ? Math.round((downMaint / totalAll) * periodSeconds) : 0;
  const uptimePercent = totalSla > 0 ? (upSla / totalSla) * 100 : null;
  const slaMet = uptimePercent == null ? true : uptimePercent >= slaTargetPercent;

  return {
    apiId,
    periodStart,
    periodEnd,
    slaTargetPercent,
    slaMet,
    uptimePercent,
    downtimeSeconds,
    excludedSeconds,
    totalChecks: totalAll,
    failedChecks: downAll,
  };
}

function monthBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

/**
 * Recomputes and persists the rolling-30d and current-calendar-month SLA report
 * for every target. Idempotent — safe to run on an interval.
 */
export async function runSlaReports(now: Date = new Date()): Promise<{ targets: number }> {
  const targets = await listTargets({});
  const rollingStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const { start: monthStart, end: monthEnd } = monthBounds(now);

  for (const t of targets) {
    const rolling = await computeSla(t.id, rollingStart, now, t.slaTargetPercent);
    await upsertRollingReport(rolling);

    // Cap the month window at "now" so a mid-month report doesn't claim the
    // remaining days as either up or down.
    const monthTo = now < monthEnd ? now : monthEnd;
    const monthly = await computeSla(t.id, monthStart, monthTo, t.slaTargetPercent);
    await upsertCalendarMonthReport({ ...monthly, periodStart: monthStart, periodEnd: monthEnd });
  }
  log.info({ targets: targets.length }, 'SLA reports refreshed');
  return { targets: targets.length };
}
