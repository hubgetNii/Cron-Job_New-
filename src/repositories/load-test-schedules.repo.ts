import type { PoolClient } from 'pg';
import { query } from '../lib/db.js';

type Row = Record<string, unknown>;

export type ScheduleSuite = 'correctness' | 'security';
export type ScheduleOutcome = 'QUEUED' | 'REFUSED' | 'SKIPPED_BUSY' | 'ERROR';

export interface LoadSchedule {
  id: string;
  apiId: string;
  targetName: string | null;
  suite: ScheduleSuite;
  cron: string;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastOutcome: ScheduleOutcome | null;
  lastMessage: string | null;
  createdAt: string;
}

const iso = (v: unknown): string | null => (v ? (v as Date).toISOString() : null);

const toSchedule = (r: Row): LoadSchedule => ({
  id: r['id'] as string,
  apiId: r['api_id'] as string,
  targetName: (r['target_name'] as string | null) ?? null,
  suite: r['suite'] as ScheduleSuite,
  cron: r['cron'] as string,
  enabled: r['enabled'] as boolean,
  nextRunAt: iso(r['next_run_at'])!,
  lastRunAt: iso(r['last_run_at']),
  lastRunId: (r['last_run_id'] as string | null) ?? null,
  lastOutcome: (r['last_outcome'] as ScheduleOutcome | null) ?? null,
  lastMessage: (r['last_message'] as string | null) ?? null,
  createdAt: iso(r['created_at'])!,
});

const SELECT = `SELECT s.*, a.name AS target_name FROM load_test_schedules s
                JOIN monitored_apis a ON a.id = s.api_id`;

export async function upsertSchedule(i: {
  apiId: string;
  suite: ScheduleSuite;
  cron: string;
  nextRunAt: Date;
  createdBy: string | null;
}): Promise<LoadSchedule> {
  const { rows } = await query<Row>(
    `INSERT INTO load_test_schedules (api_id, suite, cron, next_run_at, created_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (api_id, suite)
       DO UPDATE SET cron = EXCLUDED.cron, next_run_at = EXCLUDED.next_run_at, enabled = true
     RETURNING id`,
    [i.apiId, i.suite, i.cron, i.nextRunAt, i.createdBy],
  );
  return (await getSchedule(rows[0]!['id'] as string))!;
}

export async function getSchedule(id: string): Promise<LoadSchedule | null> {
  const { rows } = await query<Row>(`${SELECT} WHERE s.id = $1`, [id]);
  return rows[0] ? toSchedule(rows[0]) : null;
}

export async function listSchedules(): Promise<LoadSchedule[]> {
  const { rows } = await query<Row>(`${SELECT} ORDER BY a.name, s.suite`);
  return rows.map(toSchedule);
}

export async function setEnabled(
  id: string,
  enabled: boolean,
  nextRunAt: Date | null,
): Promise<void> {
  await query(
    `UPDATE load_test_schedules SET enabled = $2, next_run_at = COALESCE($3, next_run_at) WHERE id = $1`,
    [id, enabled, nextRunAt],
  );
}

export async function deleteSchedule(id: string): Promise<boolean> {
  const res = await query('DELETE FROM load_test_schedules WHERE id = $1', [id]);
  return (res.rowCount ?? 0) > 0;
}

/** Locks due schedules so two workers can never fire the same slot. */
export async function lockDue(client: PoolClient, now: Date): Promise<LoadSchedule[]> {
  const { rows } = await client.query<Row>(
    `SELECT s.*, a.name AS target_name FROM load_test_schedules s
       JOIN monitored_apis a ON a.id = s.api_id
      WHERE s.enabled AND s.next_run_at <= $1
      ORDER BY s.next_run_at
      LIMIT 20
      FOR UPDATE OF s SKIP LOCKED`,
    [now],
  );
  return rows.map(toSchedule);
}

export async function recordFire(
  client: PoolClient,
  id: string,
  f: {
    nextRunAt: Date;
    at: Date;
    runId: string | null;
    outcome: ScheduleOutcome;
    message: string | null;
  },
): Promise<void> {
  await client.query(
    `UPDATE load_test_schedules
        SET next_run_at = $2, last_run_at = $3, last_run_id = COALESCE($4, last_run_id),
            last_outcome = $5, last_message = $6
      WHERE id = $1`,
    [id, f.nextRunAt, f.at, f.runId, f.outcome, f.message],
  );
}
