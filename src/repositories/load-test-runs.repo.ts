import { query, type SqlRunner } from '../lib/db.js';
import type { LoadProfile, LoadRunStatus, LoadEnvironmentClass } from '../domain/enums.js';
import type { PlanConfig } from '../domain/load-plan.js';
import type { BucketRow, RunSummary } from '../services/loadtest/metrics-aggregator.js';

type Row = Record<string, unknown>;
const iso = (v: unknown): string | null => (v ? (v as Date).toISOString() : null);

export interface LoadPlan {
  id: string;
  apiId: string;
  name: string;
  profile: LoadProfile;
  config: PlanConfig;
  createdBy: string | null;
  createdAt: string;
}

export interface PlanSnapshot {
  config: PlanConfig;
  target: { name: string; url: string; isMoneyMoving: boolean; environment: string };
  peakRps: number;
}

export interface LoadRun {
  id: string;
  planId: string;
  apiId: string;
  status: LoadRunStatus;
  snapshot: PlanSnapshot;
  effectiveClass: LoadEnvironmentClass | null;
  requestedBy: string | null;
  workerId: string | null;
  abortRequested: boolean;
  abortReason: string | null;
  finishedReason: string | null;
  error: string | null;
  summary: RunSummary | null;
  k6Version: string | null;
  maintenanceWindowId: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const toPlan = (r: Row): LoadPlan => ({
  id: r['id'] as string,
  apiId: r['api_id'] as string,
  name: r['name'] as string,
  profile: r['profile'] as LoadProfile,
  config: r['config'] as PlanConfig,
  createdBy: (r['created_by'] as string | null) ?? null,
  createdAt: iso(r['created_at'])!,
});

const toRun = (r: Row): LoadRun => ({
  id: r['id'] as string,
  planId: r['plan_id'] as string,
  apiId: r['api_id'] as string,
  status: r['status'] as LoadRunStatus,
  snapshot: r['plan_snapshot'] as PlanSnapshot,
  effectiveClass: (r['effective_class'] as LoadEnvironmentClass | null) ?? null,
  requestedBy: (r['requested_by'] as string | null) ?? null,
  workerId: (r['worker_id'] as string | null) ?? null,
  abortRequested: r['abort_requested'] as boolean,
  abortReason: (r['abort_reason'] as string | null) ?? null,
  finishedReason: (r['finished_reason'] as string | null) ?? null,
  error: (r['error'] as string | null) ?? null,
  summary: (r['summary'] as RunSummary | null) ?? null,
  k6Version: (r['k6_version'] as string | null) ?? null,
  maintenanceWindowId: (r['maintenance_window_id'] as string | null) ?? null,
  queuedAt: iso(r['queued_at'])!,
  startedAt: iso(r['started_at']),
  finishedAt: iso(r['finished_at']),
});

export async function createPlan(
  input: { apiId: string; name: string; config: PlanConfig; createdBy: string | null },
  runner: SqlRunner = { query },
): Promise<LoadPlan> {
  const { rows } = await runner.query<Row>(
    `INSERT INTO load_test_plans (api_id, name, profile, config, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [input.apiId, input.name, input.config.profile, JSON.stringify(input.config), input.createdBy],
  );
  return toPlan(rows[0]!);
}

export async function getPlan(id: string): Promise<LoadPlan | null> {
  const { rows } = await query<Row>(`SELECT * FROM load_test_plans WHERE id = $1`, [id]);
  return rows[0] ? toPlan(rows[0]) : null;
}

export async function listPlans(apiId?: string): Promise<LoadPlan[]> {
  const { rows } = await query<Row>(
    `SELECT * FROM load_test_plans WHERE ($1::uuid IS NULL OR api_id = $1)
     ORDER BY created_at DESC LIMIT 200`,
    [apiId ?? null],
  );
  return rows.map(toPlan);
}

export async function createRun(input: {
  plan: LoadPlan;
  snapshot: PlanSnapshot;
  effectiveClass: LoadEnvironmentClass | null;
  requestedBy: string | null;
}): Promise<LoadRun> {
  const { rows } = await query<Row>(
    `INSERT INTO load_test_runs (plan_id, api_id, plan_snapshot, effective_class, requested_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [
      input.plan.id,
      input.plan.apiId,
      JSON.stringify(input.snapshot),
      input.effectiveClass,
      input.requestedBy,
    ],
  );
  return toRun(rows[0]!);
}

export async function getRun(id: string): Promise<LoadRun | null> {
  const { rows } = await query<Row>(`SELECT * FROM load_test_runs WHERE id = $1`, [id]);
  return rows[0] ? toRun(rows[0]) : null;
}

export async function listRuns(filter: {
  planId?: string | undefined;
  apiId?: string | undefined;
  limit?: number | undefined;
}): Promise<LoadRun[]> {
  const { rows } = await query<Row>(
    `SELECT * FROM load_test_runs
      WHERE ($1::uuid IS NULL OR plan_id = $1) AND ($2::uuid IS NULL OR api_id = $2)
      ORDER BY queued_at DESC LIMIT $3`,
    [filter.planId ?? null, filter.apiId ?? null, Math.min(filter.limit ?? 50, 200)],
  );
  return rows.map(toRun);
}

/** Atomically claims the oldest QUEUED run. SKIP LOCKED lets several workers coexist. */
export async function claimNextRun(workerId: string): Promise<LoadRun | null> {
  const { rows } = await query<Row>(
    `UPDATE load_test_runs
        SET status = 'PREFLIGHT', worker_id = $1, heartbeat_at = now()
      WHERE id = (SELECT id FROM load_test_runs WHERE status = 'QUEUED'
                  ORDER BY queued_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`,
    [workerId],
  );
  return rows[0] ? toRun(rows[0]) : null;
}

export async function markRunning(
  id: string,
  k6Version: string,
  maintenanceWindowId: string | null,
): Promise<void> {
  await query(
    `UPDATE load_test_runs
        SET status = 'RUNNING', started_at = now(), heartbeat_at = now(),
            k6_version = $2, maintenance_window_id = $3
      WHERE id = $1`,
    [id, k6Version, maintenanceWindowId],
  );
}

/** Heartbeat + read-back of the abort flag in one round trip. */
export async function heartbeat(
  id: string,
): Promise<{ abortRequested: boolean; abortReason: string | null }> {
  const { rows } = await query<Row>(
    `UPDATE load_test_runs SET heartbeat_at = now() WHERE id = $1
     RETURNING abort_requested, abort_reason`,
    [id],
  );
  return {
    abortRequested: (rows[0]?.['abort_requested'] as boolean | undefined) ?? false,
    abortReason: (rows[0]?.['abort_reason'] as string | null | undefined) ?? null,
  };
}

export async function finishRun(
  id: string,
  status: Extract<LoadRunStatus, 'COMPLETED' | 'ABORTED' | 'FAILED'>,
  finishedReason: string,
  summary: RunSummary | null,
  error: string | null,
): Promise<void> {
  await query(
    `UPDATE load_test_runs
        SET status = $2, finished_reason = $3, summary = $4, error = $5, finished_at = now()
      WHERE id = $1`,
    [id, status, finishedReason, summary ? JSON.stringify(summary) : null, error],
  );
}

/** Flags a run for abort; a QUEUED run is closed immediately. Returns the new row. */
export async function requestAbort(id: string, reason: string): Promise<LoadRun | null> {
  const { rows } = await query<Row>(
    `UPDATE load_test_runs
        SET abort_requested = true, abort_reason = $2,
            status = CASE WHEN status = 'QUEUED' THEN 'ABORTED'::load_run_status ELSE status END,
            finished_reason = CASE WHEN status = 'QUEUED' THEN 'aborted before start' ELSE finished_reason END,
            finished_at = CASE WHEN status = 'QUEUED' THEN now() ELSE finished_at END
      WHERE id = $1 AND status IN ('QUEUED','PREFLIGHT','RUNNING')
      RETURNING *`,
    [id, reason],
  );
  return rows[0] ? toRun(rows[0]) : null;
}

/** Runs whose worker stopped heartbeating are failed, so they can never hang forever. */
export async function recoverStaleRuns(staleSeconds: number): Promise<string[]> {
  const { rows } = await query<{ id: string; maintenance_window_id: string | null }>(
    `UPDATE load_test_runs
        SET status = 'FAILED', finished_reason = 'worker lost',
            error = 'Worker stopped heartbeating; run abandoned.', finished_at = now()
      WHERE status IN ('PREFLIGHT','RUNNING')
        AND heartbeat_at < now() - make_interval(secs => $1)
      RETURNING id, maintenance_window_id`,
    [staleSeconds],
  );
  if (rows.length > 0) {
    await query(`DELETE FROM maintenance_windows WHERE id = ANY($1::uuid[])`, [
      rows.map((r) => r.maintenance_window_id).filter((x): x is string => !!x),
    ]);
  }
  return rows.map((r) => r.id);
}

export async function insertMetrics(runId: string, rows: BucketRow[]): Promise<void> {
  for (const r of rows) {
    await query(
      `INSERT INTO load_test_metrics
         (run_id, bucket_start, requests, failures, rps, avg_ms, p50_ms, p95_ms, p99_ms, max_ms, status_counts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (run_id, bucket_start) DO NOTHING`,
      [
        runId,
        r.bucketStart,
        r.requests,
        r.failures,
        r.rps,
        r.avgMs,
        r.p50Ms,
        r.p95Ms,
        r.p99Ms,
        r.maxMs,
        JSON.stringify(r.statusCounts),
      ],
    );
  }
}

export interface MetricRow {
  bucketStart: string;
  requests: number;
  failures: number;
  rps: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  statusCounts: Record<string, number>;
}

export async function listMetrics(runId: string): Promise<MetricRow[]> {
  const { rows } = await query<Row>(
    `SELECT * FROM load_test_metrics WHERE run_id = $1 ORDER BY bucket_start`,
    [runId],
  );
  return rows.map((r) => ({
    bucketStart: iso(r['bucket_start'])!,
    requests: Number(r['requests']),
    failures: Number(r['failures']),
    rps: Number(r['rps']),
    avgMs: Number(r['avg_ms']),
    p50Ms: Number(r['p50_ms']),
    p95Ms: Number(r['p95_ms']),
    p99Ms: Number(r['p99_ms']),
    maxMs: Number(r['max_ms']),
    statusCounts: r['status_counts'] as Record<string, number>,
  }));
}
