import { query } from '../../lib/db.js';
import {
  monthlyReportsInRange,
  latestRollingByTarget,
} from '../../repositories/sla-reports.repo.js';

export interface ComplianceReport {
  generatedAt: string;
  period: { from: string; to: string };
  slaSummary: {
    targetsMeeting: number;
    targetsBreaching: number;
    worst: { targetId: string; uptimePercent: number | null; slaTargetPercent: number }[];
  };
  monthlySla: Awaited<ReturnType<typeof monthlyReportsInRange>>;
  incidents: {
    id: string;
    incidentNumber: string;
    targetName: string;
    severity: string;
    incidentType: string;
    isMoneyMoving: boolean;
    status: string;
    startedAt: string;
    resolvedAt: string | null;
    durationSeconds: number | null;
    acknowledgedAt: string | null;
    rootCause: string | null;
    resolution: string | null;
  }[];
  maintenanceWindows: {
    id: string;
    targetName: string | null;
    startsAt: string;
    endsAt: string;
    reason: string;
    ticketRef: string | null;
  }[];
  auditSummary: {
    totalEntries: number;
    byAction: { action: string; count: number }[];
    credentialAccessEvents: number;
  };
}

export async function buildComplianceReport(from: Date, to: Date): Promise<ComplianceReport> {
  const rolling = await latestRollingByTarget();
  const monthly = await monthlyReportsInRange(from, to);

  const incidents = await query<Record<string, unknown>>(
    `SELECT i.id, i.incident_number, i.severity, i.incident_type, i.is_money_moving_snapshot,
            i.status, i.started_at, i.resolved_at, i.duration_seconds, i.acknowledged_at,
            i.root_cause, i.resolution, m.name AS target_name
     FROM incidents i
     JOIN monitored_apis m ON m.id = i.api_id
     WHERE i.started_at < $2 AND (i.resolved_at IS NULL OR i.resolved_at >= $1)
     ORDER BY i.started_at`,
    [from, to],
  );

  const windows = await query<Record<string, unknown>>(
    `SELECT w.id, w.starts_at, w.ends_at, w.reason, w.ticket_ref, m.name AS target_name
     FROM maintenance_windows w
     LEFT JOIN monitored_apis m ON m.id = w.target_id
     WHERE w.starts_at < $2 AND w.ends_at > $1
     ORDER BY w.starts_at`,
    [from, to],
  );

  const audit = await query<Record<string, unknown>>(
    `SELECT action, count(*)::int AS n FROM audit_logs
     WHERE created_at >= $1 AND created_at < $2
     GROUP BY action ORDER BY n DESC`,
    [from, to],
  );
  const auditTotal = audit.rows.reduce((sum, r) => sum + Number(r['n']), 0);
  const credentialAccess = audit.rows
    .filter((r) => String(r['action']).toLowerCase().includes('credential'))
    .reduce((sum, r) => sum + Number(r['n']), 0);

  return {
    generatedAt: new Date().toISOString(),
    period: { from: from.toISOString(), to: to.toISOString() },
    slaSummary: {
      targetsMeeting: rolling.filter((r) => r.slaMet).length,
      targetsBreaching: rolling.filter((r) => !r.slaMet).length,
      worst: rolling.slice(0, 5).map((r) => ({
        targetId: r.apiId,
        uptimePercent: r.uptimePercent,
        slaTargetPercent: r.slaTargetPercent,
      })),
    },
    monthlySla: monthly,
    incidents: incidents.rows.map((r) => ({
      id: r['id'] as string,
      incidentNumber: r['incident_number'] as string,
      targetName: r['target_name'] as string,
      severity: r['severity'] as string,
      incidentType: r['incident_type'] as string,
      isMoneyMoving: r['is_money_moving_snapshot'] as boolean,
      status: r['status'] as string,
      startedAt: (r['started_at'] as Date).toISOString(),
      resolvedAt: r['resolved_at'] ? (r['resolved_at'] as Date).toISOString() : null,
      durationSeconds: (r['duration_seconds'] as number | null) ?? null,
      acknowledgedAt: r['acknowledged_at'] ? (r['acknowledged_at'] as Date).toISOString() : null,
      rootCause: (r['root_cause'] as string | null) ?? null,
      resolution: (r['resolution'] as string | null) ?? null,
    })),
    maintenanceWindows: windows.rows.map((r) => ({
      id: r['id'] as string,
      targetName: (r['target_name'] as string | null) ?? null,
      startsAt: (r['starts_at'] as Date).toISOString(),
      endsAt: (r['ends_at'] as Date).toISOString(),
      reason: r['reason'] as string,
      ticketRef: (r['ticket_ref'] as string | null) ?? null,
    })),
    auditSummary: {
      totalEntries: auditTotal,
      byAction: audit.rows.map((r) => ({ action: r['action'] as string, count: Number(r['n']) })),
      credentialAccessEvents: credentialAccess,
    },
  };
}

/** Flattens the incident list to CSV for auditors who live in spreadsheets. */
export function incidentsToCsv(report: ComplianceReport): string {
  const header = [
    'incident_number',
    'target',
    'severity',
    'type',
    'money_moving',
    'status',
    'started_at',
    'resolved_at',
    'duration_seconds',
    'root_cause',
    'resolution',
  ];
  const escape = (v: string | number | boolean): string => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = report.incidents.map((i) =>
    [
      i.incidentNumber,
      i.targetName,
      i.severity,
      i.incidentType,
      i.isMoneyMoving,
      i.status,
      i.startedAt,
      i.resolvedAt ?? '',
      i.durationSeconds ?? '',
      i.rootCause ?? '',
      i.resolution ?? '',
    ]
      .map(escape)
      .join(','),
  );
  return [header.join(','), ...lines].join('\n');
}
