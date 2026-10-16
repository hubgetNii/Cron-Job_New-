import { query } from '../lib/db.js';
import type { LoadEnvironmentClass, LoadRunStatus } from '../domain/enums.js';
import type { CheckResult, SuiteSummary } from '../loadtest/correctness/suite.js';

type Row = Record<string, unknown>;
const iso = (v: unknown): string | null => (v ? (v as Date).toISOString() : null);

export interface CorrectnessRun {
  id: string;
  apiId: string;
  status: LoadRunStatus;
  mode: 'simulator' | 'live' | null;
  effectiveClass: LoadEnvironmentClass | null;
  selectedChecks: string[];
  requestedBy: string | null;
  workerId: string | null;
  results: CheckResult[] | null;
  summary: SuiteSummary | null;
  error: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const toRun = (r: Row): CorrectnessRun => ({
  id: r['id'] as string,
  apiId: r['api_id'] as string,
  status: r['status'] as LoadRunStatus,
  mode: (r['mode'] as 'simulator' | 'live' | null) ?? null,
  effectiveClass: (r['effective_class'] as LoadEnvironmentClass | null) ?? null,
  selectedChecks: r['selected_checks'] as string[],
  requestedBy: (r['requested_by'] as string | null) ?? null,
  workerId: (r['worker_id'] as string | null) ?? null,
  results: (r['results'] as CheckResult[] | null) ?? null,
  summary: (r['summary'] as SuiteSummary | null) ?? null,
  error: (r['error'] as string | null) ?? null,
  queuedAt: iso(r['queued_at'])!,
  startedAt: iso(r['started_at']),
  finishedAt: iso(r['finished_at']),
});

export async function createCorrectnessRun(input: {
  apiId: string;
  checks: string[];
  effectiveClass: LoadEnvironmentClass | null;
  requestedBy: string | null;
}): Promise<CorrectnessRun> {
  const { rows } = await query<Row>(
    `INSERT INTO load_test_correctness_runs (api_id, selected_checks, effective_class, requested_by)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [input.apiId, input.checks, input.effectiveClass, input.requestedBy],
  );
  return toRun(rows[0]!);
}

export async function getCorrectnessRun(id: string): Promise<CorrectnessRun | null> {
  const { rows } = await query<Row>(`SELECT * FROM load_test_correctness_runs WHERE id = $1`, [id]);
  return rows[0] ? toRun(rows[0]) : null;
}

export async function listCorrectnessRuns(filter: {
  apiId?: string | undefined;
  limit?: number | undefined;
}): Promise<CorrectnessRun[]> {
  const { rows } = await query<Row>(
    `SELECT * FROM load_test_correctness_runs WHERE ($1::uuid IS NULL OR api_id = $1)
     ORDER BY queued_at DESC LIMIT $2`,
    [filter.apiId ?? null, Math.min(filter.limit ?? 50, 200)],
  );
  return rows.map(toRun);
}

export async function claimNextCorrectnessRun(workerId: string): Promise<CorrectnessRun | null> {
  const { rows } = await query<Row>(
    `UPDATE load_test_correctness_runs
        SET status = 'PREFLIGHT', worker_id = $1, heartbeat_at = now()
      WHERE id = (SELECT id FROM load_test_correctness_runs WHERE status = 'QUEUED'
                  ORDER BY queued_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`,
    [workerId],
  );
  return rows[0] ? toRun(rows[0]) : null;
}

export async function markCorrectnessRunning(
  id: string,
  mode: 'simulator' | 'live',
): Promise<void> {
  await query(
    `UPDATE load_test_correctness_runs SET status = 'RUNNING', mode = $2, started_at = now(), heartbeat_at = now() WHERE id = $1`,
    [id, mode],
  );
}

export async function correctnessHeartbeat(id: string): Promise<void> {
  await query(`UPDATE load_test_correctness_runs SET heartbeat_at = now() WHERE id = $1`, [id]);
}

export async function finishCorrectnessRun(
  id: string,
  status: Extract<LoadRunStatus, 'COMPLETED' | 'ABORTED' | 'FAILED'>,
  results: CheckResult[] | null,
  summary: SuiteSummary | null,
  error: string | null,
): Promise<void> {
  await query(
    `UPDATE load_test_correctness_runs
        SET status = $2, results = $3, summary = $4, error = $5, finished_at = now()
      WHERE id = $1`,
    [
      id,
      status,
      results ? JSON.stringify(results) : null,
      summary ? JSON.stringify(summary) : null,
      error,
    ],
  );
}

export async function recoverStaleCorrectnessRuns(staleSeconds: number): Promise<string[]> {
  const { rows } = await query<{ id: string }>(
    `UPDATE load_test_correctness_runs
        SET status = 'FAILED', error = 'Worker stopped heartbeating; run abandoned.', finished_at = now()
      WHERE status IN ('PREFLIGHT','RUNNING') AND heartbeat_at < now() - make_interval(secs => $1)
      RETURNING id`,
    [staleSeconds],
  );
  return rows.map((r) => r.id);
}
