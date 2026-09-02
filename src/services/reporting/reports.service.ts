/**
 * Advanced report builders (spec §15). Each returns a JSON structure and knows
 * how to flatten itself to CSV. SLA / compliance already have their own module.
 */

import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { query } from '../../lib/db.js';
import { listActiveTargets } from '../../repositories/monitored-apis.repo.js';
import { computeSla } from './sla.service.js';
import { classifyFailure } from '../../domain/failure-taxonomy.js';
import type { CheckFailureType } from '../../domain/enums.js';

export type ReportType =
  | 'system-health'
  | 'api-performance'
  | 'failure'
  | 'incident'
  | 'dependency'
  | 'latency'
  | 'security'
  | 'executive';

export interface Report<T> {
  type: ReportType;
  generatedAt: string;
  period: { from: string; to: string };
  data: T;
}

const iso = (d: Date): string => d.toISOString();

function wrap<T>(type: ReportType, from: Date, to: Date, data: T): Report<T> {
  return { type, generatedAt: new Date().toISOString(), period: { from: iso(from), to: iso(to) }, data };
}

/* --- shared building blocks --------------------------------------------- */

interface TargetPerfRow {
  apiId: string;
  targetName: string;
  endpointClass: string;
  isMoneyMoving: boolean;
  checks: number;
  failed: number;
  errorRatePct: number | null;
  uptimePercent: number | null;
  avgMs: number | null;
  p95Ms: number | null;
}

async function targetPerf(from: Date, to: Date): Promise<TargetPerfRow[]> {
  const targets = await listActiveTargets();
  const out: TargetPerfRow[] = [];
  for (const t of targets) {
    const { rows } = await query<{ checks: string; failed: string; avg: string | null; p95: string | null }>(
      `SELECT count(*)::text AS checks,
              count(*) FILTER (WHERE status = 'DOWN')::text AS failed,
              avg(response_time_ms) FILTER (WHERE status IN ('UP','DEGRADED'))::text AS avg,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY response_time_ms)
                FILTER (WHERE response_time_ms IS NOT NULL AND status IN ('UP','DEGRADED'))::text AS p95
       FROM health_check_results
       WHERE api_id = $1 AND checked_at >= $2 AND checked_at < $3`,
      [t.id, from, to],
    );
    const r = rows[0]!;
    const checks = Number(r.checks);
    const failed = Number(r.failed);
    const sla = await computeSla(t.id, from, to, t.slaTargetPercent);
    out.push({
      apiId: t.id,
      targetName: t.name,
      endpointClass: t.endpointClass,
      isMoneyMoving: t.isMoneyMoving,
      checks,
      failed,
      errorRatePct: checks > 0 ? Number(((failed / checks) * 100).toFixed(2)) : null,
      uptimePercent: sla.uptimePercent,
      avgMs: r.avg == null ? null : Math.round(Number(r.avg)),
      p95Ms: r.p95 == null ? null : Math.round(Number(r.p95)),
    });
  }
  return out;
}

async function incidentsInRange(from: Date, to: Date): Promise<Array<Record<string, unknown>>> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT i.incident_number, m.name AS target_name, i.severity, i.incident_type,
            i.is_money_moving_snapshot, i.status, i.started_at, i.resolved_at,
            i.duration_seconds, i.failure_type, i.failure_count,
            i.rca ->> 'category' AS rca_category, i.root_cause, i.resolution
     FROM incidents i JOIN monitored_apis m ON m.id = i.api_id
     WHERE i.started_at < $2 AND (i.resolved_at IS NULL OR i.resolved_at >= $1)
     ORDER BY i.started_at`,
    [from, to],
  );
  return rows;
}

/* --- reports ------------------------------------------------------------ */

export async function apiPerformanceReport(from: Date, to: Date): Promise<Report<TargetPerfRow[]>> {
  return wrap('api-performance', from, to, await targetPerf(from, to));
}

export async function systemHealthReport(from: Date, to: Date) {
  const perf = await targetPerf(from, to);
  const uptimes = perf.map((p) => p.uptimePercent).filter((v): v is number => v != null);
  const latencies = perf.map((p) => p.p95Ms).filter((v): v is number => v != null);
  const incidents = await incidentsInRange(from, to);
  const open = incidents.filter((i) => i['status'] !== 'RESOLVED').length;
  return wrap('system-health', from, to, {
    totals: {
      services: perf.length,
      avgUptimePercent:
        uptimes.length > 0
          ? Number((uptimes.reduce((a, b) => a + b, 0) / uptimes.length).toFixed(3))
          : null,
      avgP95Ms:
        latencies.length > 0
          ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
          : null,
      totalChecks: perf.reduce((s, p) => s + p.checks, 0),
      totalFailures: perf.reduce((s, p) => s + p.failed, 0),
      incidents: incidents.length,
      openIncidents: open,
    },
    topProblemServices: [...perf]
      .sort((a, b) => (b.errorRatePct ?? 0) - (a.errorRatePct ?? 0) || (b.p95Ms ?? 0) - (a.p95Ms ?? 0))
      .slice(0, 5),
    services: perf,
  });
}

export async function failureReport(from: Date, to: Date) {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT r.error_type, r.http_status, r.error_message, m.name AS target_name, count(*)::int AS n
     FROM health_check_results r JOIN monitored_apis m ON m.id = r.api_id
     WHERE r.status = 'DOWN' AND r.checked_at >= $1 AND r.checked_at < $2
     GROUP BY r.error_type, r.http_status, r.error_message, m.name
     ORDER BY n DESC`,
    [from, to],
  );
  const byCategory = new Map<string, { category: string; count: number; failureTypes: Set<string>; targets: Set<string> }>();
  const flat = rows.map((r) => {
    const c = classifyFailure({
      failureType: (r['error_type'] as CheckFailureType | null) ?? null,
      httpStatus: (r['http_status'] as number | null) ?? null,
      errorMessage: (r['error_message'] as string | null) ?? null,
    });
    const n = Number(r['n']);
    const g = byCategory.get(c.category) ?? {
      category: c.category,
      count: 0,
      failureTypes: new Set<string>(),
      targets: new Set<string>(),
    };
    g.count += n;
    if (r['error_type']) g.failureTypes.add(r['error_type'] as string);
    g.targets.add(r['target_name'] as string);
    byCategory.set(c.category, g);
    return {
      category: c.category,
      subtype: c.subtype,
      failureType: (r['error_type'] as string | null) ?? null,
      httpStatus: (r['http_status'] as number | null) ?? null,
      targetName: r['target_name'] as string,
      count: n,
    };
  });
  return wrap('failure', from, to, {
    byCategory: [...byCategory.values()]
      .map((g) => ({
        category: g.category,
        count: g.count,
        failureTypes: [...g.failureTypes],
        affectedServices: g.targets.size,
      }))
      .sort((a, b) => b.count - a.count),
    detail: flat,
  });
}

export async function incidentReport(from: Date, to: Date) {
  const rows = await incidentsInRange(from, to);
  const resolved = rows.filter((i) => i['duration_seconds'] != null);
  const durations = resolved.map((i) => Number(i['duration_seconds']));
  return wrap('incident', from, to, {
    totals: {
      incidents: rows.length,
      resolved: resolved.length,
      open: rows.length - resolved.length,
      moneyMoving: rows.filter((i) => i['is_money_moving_snapshot']).length,
      meanTimeToResolveSeconds:
        durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    },
    bySeverity: countBy(rows, 'severity'),
    incidents: rows.map(mapIncident),
  });
}

export async function dependencyReport(from: Date, to: Date) {
  const rows = (await incidentsInRange(from, to)).filter(
    (i) => i['rca_category'] === 'DEPENDENCY' || i['rca_category'] === 'DATABASE',
  );
  const byTarget = countBy(rows, 'target_name');
  return wrap('dependency', from, to, {
    totals: {
      dependencyIncidents: rows.length,
      database: rows.filter((i) => i['rca_category'] === 'DATABASE').length,
      dependency: rows.filter((i) => i['rca_category'] === 'DEPENDENCY').length,
    },
    byService: byTarget,
    incidents: rows.map(mapIncident),
  });
}

export async function latencyReport(from: Date, to: Date) {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT m.name AS target_name,
            date_trunc('day', r.checked_at) AS day,
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY r.response_time_ms)::int AS p50,
            percentile_cont(0.9)  WITHIN GROUP (ORDER BY r.response_time_ms)::int AS p90,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY r.response_time_ms)::int AS p95,
            percentile_cont(0.99) WITHIN GROUP (ORDER BY r.response_time_ms)::int AS p99,
            count(*)::int AS samples
     FROM health_check_results r JOIN monitored_apis m ON m.id = r.api_id
     WHERE r.response_time_ms IS NOT NULL AND r.status IN ('UP','DEGRADED')
       AND r.checked_at >= $1 AND r.checked_at < $2
     GROUP BY m.name, day ORDER BY m.name, day`,
    [from, to],
  );
  return wrap('latency', from, to, {
    daily: rows.map((r) => ({
      targetName: r['target_name'] as string,
      day: (r['day'] as Date).toISOString().slice(0, 10),
      p50: r['p50'] as number,
      p90: r['p90'] as number,
      p95: r['p95'] as number,
      p99: r['p99'] as number,
      samples: r['samples'] as number,
    })),
  });
}

export async function securityReport(from: Date, to: Date) {
  const authFailures = await query<{ n: string; target_name: string }>(
    `SELECT count(*)::text AS n, m.name AS target_name
     FROM health_check_results r JOIN monitored_apis m ON m.id = r.api_id
     WHERE r.status = 'DOWN' AND r.error_type = 'AUTHENTICATION_ERROR'
       AND r.checked_at >= $1 AND r.checked_at < $2
     GROUP BY m.name ORDER BY n DESC`,
    [from, to],
  );
  const authIncidents = (await incidentsInRange(from, to)).filter(
    (i) => i['failure_type'] === 'AUTHENTICATION_ERROR' || i['rca_category'] === 'AUTHENTICATION',
  );
  const audit = await query<{ action: string; n: string }>(
    `SELECT action, count(*)::text AS n FROM audit_logs
     WHERE created_at >= $1 AND created_at < $2
       AND (action ILIKE '%credential%' OR action ILIKE '%login%' OR action ILIKE '%auth%'
            OR action ILIKE '%reveal%' OR action ILIKE '%role%')
     GROUP BY action ORDER BY n DESC`,
    [from, to],
  );
  const reveals = await query<Record<string, unknown>>(
    `SELECT actor_label, entity_id, created_at, ip_address FROM audit_logs
     WHERE action = 'observability.trace.reveal' AND created_at >= $1 AND created_at < $2
     ORDER BY created_at DESC LIMIT 200`,
    [from, to],
  );
  return wrap('security', from, to, {
    totals: {
      authFailureChecks: authFailures.rows.reduce((s, r) => s + Number(r.n), 0),
      authIncidents: authIncidents.length,
      credentialAudits: audit.rows.reduce((s, r) => s + Number(r.n), 0),
      traceReveals: reveals.rows.length,
    },
    authFailuresByService: authFailures.rows.map((r) => ({
      targetName: r.target_name,
      count: Number(r.n),
    })),
    authIncidents: authIncidents.map(mapIncident),
    auditByAction: audit.rows.map((r) => ({ action: r.action, count: Number(r.n) })),
    traceReveals: reveals.rows.map((r) => ({
      actor: r['actor_label'] as string,
      checkId: r['entity_id'] as string,
      at: (r['created_at'] as Date).toISOString(),
      ip: (r['ip_address'] as string | null) ?? null,
    })),
  });
}

export async function executiveReport(from: Date, to: Date) {
  const sh = await systemHealthReport(from, to);
  const inc = await incidentReport(from, to);
  const t = sh.data.totals;
  const availability = t.avgUptimePercent;
  const status =
    availability == null
      ? 'No data'
      : availability >= 99.9
        ? 'On target'
        : availability >= 99.0
          ? 'Below target'
          : 'At risk';
  return wrap('executive', from, to, {
    headline: {
      platformAvailabilityPercent: availability,
      status,
      avgResponseMs: t.avgP95Ms,
      incidentsInPeriod: t.incidents,
      openIncidents: t.openIncidents,
      meanTimeToResolveMinutes:
        inc.data.totals.meanTimeToResolveSeconds != null
          ? Math.round(inc.data.totals.meanTimeToResolveSeconds / 60)
          : null,
    },
    topProblemServices: sh.data.topProblemServices.map((s) => ({
      service: s.targetName,
      uptimePercent: s.uptimePercent,
      errorRatePercent: s.errorRatePct,
      moneyMoving: s.isMoneyMoving,
    })),
    note: 'Business summary — see the API Performance and Incident reports for detail.',
  });
}

/* --- helpers ----------------------------------------------------------- */

function countBy(rows: Array<Record<string, unknown>>, key: string): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of rows) {
    const k = String(r[key]);
    m[k] = (m[k] ?? 0) + 1;
  }
  return m;
}

function mapIncident(r: Record<string, unknown>) {
  return {
    incidentNumber: r['incident_number'] as string,
    targetName: r['target_name'] as string,
    severity: r['severity'] as string,
    type: r['incident_type'] as string,
    moneyMoving: r['is_money_moving_snapshot'] as boolean,
    status: r['status'] as string,
    startedAt: (r['started_at'] as Date).toISOString(),
    resolvedAt: r['resolved_at'] ? (r['resolved_at'] as Date).toISOString() : null,
    durationSeconds: (r['duration_seconds'] as number | null) ?? null,
    failureType: (r['failure_type'] as string | null) ?? null,
    rcaCategory: (r['rca_category'] as string | null) ?? null,
    rootCause: (r['root_cause'] as string | null) ?? null,
    resolution: (r['resolution'] as string | null) ?? null,
  };
}

/* --- CSV ------------------------------------------------------------------ */

const cell = (v: unknown): string => {
  let s: string;
  if (v == null) s = '';
  else if (typeof v === 'string') s = v;
  else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
  else s = JSON.stringify(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function reportToCsv(report: Report<unknown>): string {
  // pick the most useful flat table per report type
  const d = report.data as Record<string, unknown>;
  let rows: Array<Record<string, unknown>> = [];
  switch (report.type) {
    case 'api-performance':
    case 'system-health':
      rows = (report.type === 'system-health' ? (d['services'] as unknown[]) : (report.data as unknown[])) as Array<
        Record<string, unknown>
      >;
      break;
    case 'failure':
      rows = d['detail'] as Array<Record<string, unknown>>;
      break;
    case 'incident':
    case 'dependency':
      rows = d['incidents'] as Array<Record<string, unknown>>;
      break;
    case 'latency':
      rows = d['daily'] as Array<Record<string, unknown>>;
      break;
    case 'security':
      rows = d['authFailuresByService'] as Array<Record<string, unknown>>;
      break;
    case 'executive':
      rows = (d['topProblemServices'] as Array<Record<string, unknown>>) ?? [];
      break;
  }
  if (!rows || rows.length === 0) return 'no rows';
  const headers = Object.keys(rows[0]!);
  const lines = rows.map((r) => headers.map((h) => cell(r[h])).join(','));
  return [headers.join(','), ...lines].join('\n');
}

/* --- table extraction (shared by XLSX + PDF) --------------------------- */

export interface ReportTable {
  name: string;
  rows: Array<Record<string, unknown>>;
}

const titleCase = (s: string): string =>
  s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());

function isRowArray(v: unknown): v is Array<Record<string, unknown>> {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => x != null && typeof x === 'object' && !Array.isArray(x))
  );
}

/** Every tabular slice of a report, for the multi-sheet / multi-section exports. */
export function reportTables(report: Report<unknown>): ReportTable[] {
  const tables: ReportTable[] = [
    {
      name: 'Report',
      rows: [
        {
          type: report.type,
          generatedAt: report.generatedAt,
          from: report.period.from,
          to: report.period.to,
        },
      ],
    },
  ];

  const data = report.data;
  if (isRowArray(data)) {
    tables.push({ name: 'Data', rows: data });
    return tables;
  }
  if (data == null || typeof data !== 'object') return tables;

  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (isRowArray(value)) {
      tables.push({ name: titleCase(key), rows: value });
    } else if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      tables.push({ name: titleCase(key), rows: [value as Record<string, unknown>] });
    } else if (value != null && !Array.isArray(value)) {
      summary[key] = value;
    }
  }
  if (Object.keys(summary).length > 0) tables.splice(1, 0, { name: 'Summary', rows: [summary] });
  return tables;
}

function flatCell(v: unknown): string | number | boolean {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return JSON.stringify(v);
}

/* --- XLSX ------------------------------------------------------------------ */

export async function reportToXlsx(report: Report<unknown>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FinTech Cron Monitor';
  wb.created = new Date();

  const used = new Set<string>();
  for (const table of reportTables(report)) {
    // Excel sheet names: ≤31 chars, unique, no []*?/\:
    let name = table.name.replace(/[[\]*?/\\:]/g, ' ').slice(0, 31) || 'Sheet';
    let n = 1;
    while (used.has(name.toLowerCase())) name = `${table.name.slice(0, 28)} ${++n}`;
    used.add(name.toLowerCase());

    const ws = wb.addWorksheet(name);
    const headers = Object.keys(table.rows[0] ?? {});
    ws.columns = headers.map((h) => ({ header: titleCase(h), key: h, width: Math.min(40, Math.max(12, h.length + 4)) }));
    for (const row of table.rows) {
      ws.addRow(Object.fromEntries(headers.map((h) => [h, flatCell(row[h])])));
    }
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  const arr = await wb.xlsx.writeBuffer();
  return Buffer.from(arr);
}

/* --- PDF ----------------------------------------------------------------- */

export function reportToPdf(report: Report<unknown>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, layout: 'landscape' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text(`${titleCase(report.type)} report`, { continued: false });
    doc
      .fontSize(9)
      .fillColor('#666')
      .text(
        `Period ${report.period.from.slice(0, 10)} → ${report.period.to.slice(0, 10)}  ·  generated ${report.generatedAt.slice(0, 19).replace('T', ' ')}`,
      );
    doc.fillColor('#000').moveDown(0.6);

    const tables = reportTables(report).filter((t) => t.name !== 'Report');
    for (const table of tables) {
      if (table.rows.length === 0) continue;
      doc.moveDown(0.4).fontSize(12).text(table.name);
      doc.moveDown(0.2);
      const headers = Object.keys(table.rows[0]!);
      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const colW = pageWidth / headers.length;
      const drawRow = (values: string[], bold: boolean): void => {
        const y = doc.y;
        doc.fontSize(7).font(bold ? 'Helvetica-Bold' : 'Helvetica');
        headers.forEach((_, i) => {
          doc.text(values[i] ?? '', doc.page.margins.left + i * colW, y, {
            width: colW - 4,
            height: 10,
            ellipsis: true,
            lineBreak: false,
          });
        });
        doc.moveDown(0.9);
        if (doc.y > doc.page.height - doc.page.margins.bottom - 20) doc.addPage();
      };
      drawRow(headers.map(titleCase), true);
      for (const row of table.rows.slice(0, 500)) {
        drawRow(headers.map((h) => String(flatCell(row[h]))), false);
      }
      if (table.rows.length > 500) {
        doc.fontSize(7).fillColor('#999').text(`… ${table.rows.length - 500} more rows (see CSV/Excel)`);
        doc.fillColor('#000');
      }
    }

    doc.end();
  });
}

export type ReportFormat = 'json' | 'csv' | 'xlsx' | 'pdf';

export const REPORT_CONTENT_TYPE: Record<Exclude<ReportFormat, 'json'>, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

export async function renderReport(
  report: Report<unknown>,
  format: Exclude<ReportFormat, 'json'>,
): Promise<Buffer | string> {
  if (format === 'csv') return reportToCsv(report);
  if (format === 'xlsx') return reportToXlsx(report);
  return reportToPdf(report);
}

export async function buildReport(type: ReportType, from: Date, to: Date): Promise<Report<unknown>> {
  switch (type) {
    case 'system-health':
      return systemHealthReport(from, to);
    case 'api-performance':
      return apiPerformanceReport(from, to);
    case 'failure':
      return failureReport(from, to);
    case 'incident':
      return incidentReport(from, to);
    case 'dependency':
      return dependencyReport(from, to);
    case 'latency':
      return latencyReport(from, to);
    case 'security':
      return securityReport(from, to);
    case 'executive':
      return executiveReport(from, to);
  }
}
