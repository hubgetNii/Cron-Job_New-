/**
 * Data retention (spec §17). A fintech platform keeps the *audit trail*, the
 * *incident record* and the *SLA reports* forever — but the high-volume
 * operational data (health checks, traces, cron runs, heartbeats, delivered
 * alerts, digests) is pruned past a per-class window.
 *
 * Deletes are batched so a large first sweep does not lock a table.
 */

import { env } from '../../config/index.js';
import { componentLogger } from '../../lib/logger.js';
import { query } from '../../lib/db.js';

const log = componentLogger('retention');

const BATCH = 5000;
const MAX_BATCHES = 200; // ≤ 1M rows per class per sweep

interface ClassSpec {
  name: string;
  table: string;
  tsColumn: string;
  days: number;
  /** extra WHERE clause, e.g. only delivered alerts */
  extra?: string;
}

function specs(): ClassSpec[] {
  const e = env();
  return [
    {
      name: 'health_check_results',
      table: 'health_check_results',
      tsColumn: 'checked_at',
      days: e.RETENTION_HEALTH_CHECK_DAYS,
    },
    {
      name: 'health_check_traces',
      table: 'health_check_traces',
      tsColumn: 'checked_at',
      days: e.TRACE_RETENTION_DAYS,
    },
    {
      name: 'health_check_runs',
      table: 'health_check_runs',
      tsColumn: 'window_end',
      days: e.HEALTH_CHECK_RUN_RETENTION_DAYS,
    },
    {
      name: 'cron_job_runs',
      table: 'cron_job_runs',
      tsColumn: 'scheduled_slot',
      days: e.RETENTION_CRON_RUN_DAYS,
    },
    {
      name: 'scheduler_heartbeats',
      table: 'scheduler_heartbeats',
      tsColumn: 'created_at',
      days: e.RETENTION_HEARTBEAT_DAYS,
    },
    {
      name: 'alerts',
      table: 'alerts',
      tsColumn: 'created_at',
      days: e.RETENTION_ALERT_DAYS,
      extra: `status <> 'PENDING'`,
    },
    {
      name: 'health_digests',
      table: 'health_digests',
      tsColumn: 'generated_at',
      days: e.RETENTION_DIGEST_DAYS,
    },
  ];
}

async function pruneClass(spec: ClassSpec): Promise<number> {
  let deleted = 0;
  const where = `${spec.tsColumn} < now() - ($1::int * interval '1 day')${
    spec.extra ? ` AND ${spec.extra}` : ''
  }`;
  for (let i = 0; i < MAX_BATCHES; i += 1) {
    const { rowCount } = await query(
      `DELETE FROM ${spec.table}
       WHERE ctid IN (SELECT ctid FROM ${spec.table} WHERE ${where} LIMIT ${BATCH})`,
      [spec.days],
    );
    const n = rowCount ?? 0;
    deleted += n;
    if (n < BATCH) break;
  }
  return deleted;
}

export interface RetentionRunResult {
  ranAt: string;
  pruned: { class: string; days: number; deleted: number }[];
  totalDeleted: number;
}

export async function runRetention(): Promise<RetentionRunResult> {
  const pruned: RetentionRunResult['pruned'] = [];
  for (const spec of specs()) {
    try {
      const deleted = await pruneClass(spec);
      pruned.push({ class: spec.name, days: spec.days, deleted });
      if (deleted > 0) log.info({ class: spec.name, deleted, days: spec.days }, 'pruned');
    } catch (err) {
      log.error({ err, class: spec.name }, 'prune failed for class');
      pruned.push({ class: spec.name, days: spec.days, deleted: 0 });
    }
  }
  return {
    ranAt: new Date().toISOString(),
    pruned,
    totalDeleted: pruned.reduce((s, p) => s + p.deleted, 0),
  };
}

export interface RetentionStatusRow {
  class: string;
  retentionDays: number | null;
  rows: number;
  oldest: string | null;
  overdue: number;
}

/** Row counts, oldest timestamp and "how many are past the window" per class. */
export async function retentionStatus(): Promise<RetentionStatusRow[]> {
  const pruneable = specs();
  const immutable: { name: string; table: string; ts: string }[] = [
    { name: 'incidents', table: 'incidents', ts: 'started_at' },
    { name: 'audit_logs', table: 'audit_logs', ts: 'created_at' },
    { name: 'sla_reports', table: 'sla_reports', ts: 'generated_at' },
    { name: 'incident_events', table: 'incident_events', ts: 'at' },
  ];

  const out: RetentionStatusRow[] = [];
  for (const s of pruneable) {
    const { rows } = await query<{ n: string; oldest: Date | null; overdue: string }>(
      `SELECT count(*)::text AS n, min(${s.tsColumn}) AS oldest,
              count(*) FILTER (WHERE ${s.tsColumn} < now() - ($1::int * interval '1 day')
                ${s.extra ? `AND ${s.extra}` : ''})::text AS overdue
       FROM ${s.table}`,
      [s.days],
    );
    const r = rows[0]!;
    out.push({
      class: s.name,
      retentionDays: s.days,
      rows: Number(r.n),
      oldest: r.oldest ? r.oldest.toISOString() : null,
      overdue: Number(r.overdue),
    });
  }
  for (const s of immutable) {
    const { rows } = await query<{ n: string; oldest: Date | null }>(
      `SELECT count(*)::text AS n, min(${s.ts}) AS oldest FROM ${s.table}`,
    );
    const r = rows[0]!;
    out.push({
      class: s.name,
      retentionDays: null,
      rows: Number(r.n),
      oldest: r.oldest ? r.oldest.toISOString() : null,
      overdue: 0,
    });
  }
  return out;
}

export interface RetentionHandle {
  stop(): void;
  runOnce(): Promise<RetentionRunResult>;
}

/** Runs the retention sweep every RETENTION_SWEEP_HOURS in the scheduler process. */
export function startRetentionRunner(
  intervalMs = env().RETENTION_SWEEP_HOURS * 3_600_000,
): RetentionHandle {
  const timer = setInterval(() => void runRetention(), intervalMs);
  timer.unref();
  return { stop: (): void => clearInterval(timer), runOnce: runRetention };
}
