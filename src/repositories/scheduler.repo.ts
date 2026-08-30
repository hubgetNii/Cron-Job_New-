import { query, sql, type SqlRunner } from '../lib/db.js';
import type { AlertChannel, AlertType, CronRunStatus, HealthStatus } from '../domain/enums.js';
import type { HealthCheckOutcome } from '../domain/health-check.js';

function runner(client?: SqlRunner): SqlRunner {
  return client ?? sql;
}

// ── cron_job_runs ──────────────────────────────────────────────────────────

export interface CronJobRun {
  id: string;
  targetId: string;
  scheduledSlot: Date;
  jobRunId: string;
  workerId: string | null;
  status: CronRunStatus;
  attemptNumber: number;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

/**
 * Claims a run for (target, slot, attempt). Returns the row id, or null if a
 * row already exists — the caller must then treat the slot as already handled
 * (idempotency, see vault: "Idempotency and Duplicate Prevention").
 */
export async function claimJobRun(
  input: {
    targetId: string;
    scheduledSlot: Date;
    jobRunId: string;
    workerId: string;
    attemptNumber?: number;
  },
  client?: SqlRunner,
): Promise<string | null> {
  const { rows } = await runner(client).query<{ id: string }>(
    `INSERT INTO cron_job_runs
       (target_id, scheduled_slot, job_run_id, worker_id, lock_acquired_at, started_at, status, attempt_number)
     VALUES ($1, $2, $3, $4, now(), now(), 'RUNNING', $5)
     ON CONFLICT (target_id, scheduled_slot, attempt_number) DO NOTHING
     RETURNING id`,
    [input.targetId, input.scheduledSlot, input.jobRunId, input.workerId, input.attemptNumber ?? 1],
  );
  return rows[0]?.id ?? null;
}

export async function completeJobRun(
  id: string,
  status: CronRunStatus,
  client?: SqlRunner,
): Promise<void> {
  await runner(client).query(
    `UPDATE cron_job_runs SET status = $2, completed_at = now() WHERE id = $1`,
    [id, status],
  );
}

export async function recordSkippedRun(input: {
  targetId: string;
  scheduledSlot: Date;
  jobRunId: string;
  workerId: string;
  status: Extract<CronRunStatus, 'SKIPPED_LOCK_CONTENDED' | 'DEAD_LETTERED'>;
}): Promise<void> {
  await query(
    `INSERT INTO cron_job_runs
       (target_id, scheduled_slot, job_run_id, worker_id, started_at, completed_at, status, attempt_number)
     VALUES ($1, $2, $3, $4, now(), now(), $5, 1)
     ON CONFLICT (target_id, scheduled_slot, attempt_number) DO UPDATE SET status = EXCLUDED.status, completed_at = now()`,
    [input.targetId, input.scheduledSlot, input.jobRunId, input.workerId, input.status],
  );
}

export async function jobRunExists(jobRunId: string): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM cron_job_runs WHERE job_run_id = $1 AND status IN ('SUCCESS','DEAD_LETTERED') LIMIT 1`,
    [jobRunId],
  );
  return rows.length > 0;
}

export async function listJobRuns(filters: {
  targetId?: string;
  limit?: number;
  offset?: number;
}): Promise<CronJobRun[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (filters.targetId) {
    params.push(filters.targetId);
    where.push(`target_id = $${params.length}`);
  }
  const limit = Math.min(filters.limit ?? 100, 500);
  const offset = filters.offset ?? 0;
  params.push(limit, offset);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id, target_id, scheduled_slot, job_run_id, worker_id, status, attempt_number,
            started_at, completed_at, created_at
     FROM cron_job_runs
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY scheduled_slot DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    id: r['id'] as string,
    targetId: r['target_id'] as string,
    scheduledSlot: r['scheduled_slot'] as Date,
    jobRunId: r['job_run_id'] as string,
    workerId: (r['worker_id'] as string | null) ?? null,
    status: r['status'] as CronRunStatus,
    attemptNumber: r['attempt_number'] as number,
    startedAt: (r['started_at'] as Date | null) ?? null,
    completedAt: (r['completed_at'] as Date | null) ?? null,
    createdAt: r['created_at'] as Date,
  }));
}

// ── health_check_results ───────────────────────────────────────────────────

export async function insertHealthCheckResult(
  input: {
    apiId: string;
    jobRunId: string;
    outcome: HealthCheckOutcome;
  },
  client?: SqlRunner,
): Promise<string | null> {
  const { outcome } = input;
  const { rows } = await runner(client).query<{ id: string }>(
    `INSERT INTO health_check_results
       (api_id, job_run_id, checked_at, status, http_status, response_time_ms, error_type, error_message, validation_result, response_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (job_run_id) WHERE job_run_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      input.apiId,
      input.jobRunId,
      outcome.checkedAt,
      outcome.status,
      outcome.httpStatus,
      outcome.responseTimeMs,
      outcome.failureType,
      outcome.errorMessage,
      outcome.validation ? JSON.stringify(outcome.validation) : null,
      outcome.httpStatus === null ? null : String(outcome.httpStatus),
    ],
  );
  return rows[0]?.id ?? null;
}

// ── target_schedule_state ──────────────────────────────────────────────────

export interface TargetScheduleState {
  targetId: string;
  lastExpectedRunAt: Date | null;
  lastActualRunAt: Date | null;
  lastStatus: HealthStatus | null;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  missedRunCount: number;
  updatedAt: Date;
}

/**
 * Updates the per-target recovery counters. Only a clean `UP` counts toward
 * recovery (see vault: "Incident Lifecycle" — N consecutive *successful*
 * checks); `DEGRADED` and `UNKNOWN` break the streak without escalating a
 * DOWN, and only `DOWN` grows the failure count.
 */
export async function recordRunOutcome(
  input: { targetId: string; scheduledSlot: Date; status: HealthStatus },
  client?: SqlRunner,
): Promise<{ consecutiveSuccesses: number; consecutiveFailures: number }> {
  const isUp = input.status === 'UP';
  const isDown = input.status === 'DOWN';
  const { rows } = await runner(client).query<{
    consecutive_successes: number;
    consecutive_failures: number;
  }>(
    `INSERT INTO target_schedule_state
       (target_id, last_expected_run_at, last_actual_run_at, last_status,
        consecutive_successes, consecutive_failures)
     VALUES ($1, $2, now(), $3, $4, $5)
     ON CONFLICT (target_id) DO UPDATE SET
       last_expected_run_at = EXCLUDED.last_expected_run_at,
       last_actual_run_at = now(),
       last_status = EXCLUDED.last_status,
       consecutive_successes = CASE WHEN $6 THEN target_schedule_state.consecutive_successes + 1 ELSE 0 END,
       consecutive_failures  = CASE WHEN $7 THEN target_schedule_state.consecutive_failures + 1
                                    WHEN $6 THEN 0
                                    ELSE target_schedule_state.consecutive_failures END
     RETURNING consecutive_successes, consecutive_failures`,
    [input.targetId, input.scheduledSlot, input.status, isUp ? 1 : 0, isDown ? 1 : 0, isUp, isDown],
  );
  return {
    consecutiveSuccesses: rows[0]?.consecutive_successes ?? 0,
    consecutiveFailures: rows[0]?.consecutive_failures ?? 0,
  };
}

export async function bumpMissedRunCount(targetId: string, by: number): Promise<void> {
  await query(
    `INSERT INTO target_schedule_state (target_id, missed_run_count)
     VALUES ($1, $2)
     ON CONFLICT (target_id) DO UPDATE SET missed_run_count = target_schedule_state.missed_run_count + $2`,
    [targetId, by],
  );
}

export async function getScheduleState(targetId: string): Promise<TargetScheduleState | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT target_id, last_expected_run_at, last_actual_run_at, last_status,
            consecutive_successes, consecutive_failures, missed_run_count, updated_at
     FROM target_schedule_state WHERE target_id = $1`,
    [targetId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    targetId: r['target_id'] as string,
    lastExpectedRunAt: (r['last_expected_run_at'] as Date | null) ?? null,
    lastActualRunAt: (r['last_actual_run_at'] as Date | null) ?? null,
    lastStatus: (r['last_status'] as HealthStatus | null) ?? null,
    consecutiveSuccesses: r['consecutive_successes'] as number,
    consecutiveFailures: r['consecutive_failures'] as number,
    missedRunCount: r['missed_run_count'] as number,
    updatedAt: r['updated_at'] as Date,
  };
}

// ── scheduler_heartbeats ───────────────────────────────────────────────────

export async function writeHeartbeat(input: {
  instanceId: string;
  activeJobCount: number;
  queueDepth: number;
}): Promise<void> {
  await query(
    `INSERT INTO scheduler_heartbeats (instance_id, last_tick_at, active_job_count, queue_depth)
     VALUES ($1, now(), $2, $3)`,
    [input.instanceId, input.activeJobCount, input.queueDepth],
  );
}

export async function pruneHeartbeats(keepMinutes = 60): Promise<number> {
  const { rowCount } = await query(
    `DELETE FROM scheduler_heartbeats WHERE created_at < now() - ($1::int * interval '1 minute')`,
    [keepMinutes],
  );
  return rowCount ?? 0;
}

export interface LatestHeartbeat {
  instanceId: string;
  lastTickAt: Date;
  activeJobCount: number;
  queueDepth: number;
  ageMs: number;
}

export async function latestHeartbeat(): Promise<LatestHeartbeat | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT instance_id, last_tick_at, active_job_count, queue_depth,
            EXTRACT(EPOCH FROM (now() - last_tick_at)) * 1000 AS age_ms
     FROM scheduler_heartbeats ORDER BY last_tick_at DESC LIMIT 1`,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    instanceId: r['instance_id'] as string,
    lastTickAt: r['last_tick_at'] as Date,
    activeJobCount: r['active_job_count'] as number,
    queueDepth: r['queue_depth'] as number,
    ageMs: Math.round(Number(r['age_ms'])),
  };
}

export interface MissedRunSummary {
  targetId: string;
  name: string;
  lastActualRunAt: Date | null;
  lastExpectedRunAt: Date | null;
  missedRunCount: number;
}

export async function listMissedRuns(): Promise<MissedRunSummary[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT s.target_id, m.name, s.last_actual_run_at, s.last_expected_run_at, s.missed_run_count
     FROM target_schedule_state s
     JOIN monitored_apis m ON m.id = s.target_id
     WHERE s.missed_run_count > 0
     ORDER BY s.missed_run_count DESC, m.name`,
  );
  return rows.map((r) => ({
    targetId: r['target_id'] as string,
    name: r['name'] as string,
    lastActualRunAt: (r['last_actual_run_at'] as Date | null) ?? null,
    lastExpectedRunAt: (r['last_expected_run_at'] as Date | null) ?? null,
    missedRunCount: r['missed_run_count'] as number,
  }));
}

export async function totalMissedRuns(): Promise<number> {
  const { rows } = await query<{ total: string }>(
    `SELECT COALESCE(SUM(missed_run_count), 0)::text AS total FROM target_schedule_state`,
  );
  return Number(rows[0]?.total ?? 0);
}

// ── alerts (recorded here; delivered in Phase 7) ────────────────────────────

export async function recordAlert(
  input: {
    alertType: AlertType;
    channel: AlertChannel;
    recipient: string;
    incidentId?: string | null;
    apiId?: string | null;
    errorMessage?: string | null;
  },
  client?: SqlRunner,
): Promise<void> {
  await runner(client).query(
    `INSERT INTO alerts (incident_id, api_id, alert_type, channel, recipient, status, error_message)
     VALUES ($1, $2, $3, $4, $5, 'PENDING', $6)`,
    [
      input.incidentId ?? null,
      input.apiId ?? null,
      input.alertType,
      input.channel,
      input.recipient,
      input.errorMessage ?? null,
    ],
  );
}
