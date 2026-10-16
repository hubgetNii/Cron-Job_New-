import { query, type SqlRunner } from '../lib/db.js';
import type { LoadAuthorizationStatus, LoadEnvironmentClass } from '../domain/enums.js';

export interface LoadTargetConfig {
  apiId: string;
  environmentClass: LoadEnvironmentClass;
  hasRealSideEffects: boolean;
  updatedBy: string | null;
  updatedAt: string;
}

export interface LoadAuthorization {
  id: string;
  apiId: string;
  status: LoadAuthorizationStatus;
  reference: string;
  scope: string;
  windowStart: Date;
  windowEnd: Date;
  maxRps: number;
  maxVus: number;
  maxDurationSeconds: number;
  allowRealSideEffects: boolean;
  proposedBy: string;
  reviewedBy: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  createdAt: string;
}

type Row = Record<string, unknown>;
const iso = (v: unknown): string | null => (v ? (v as Date).toISOString() : null);

function toConfig(r: Row): LoadTargetConfig {
  return {
    apiId: r['api_id'] as string,
    environmentClass: r['environment_class'] as LoadEnvironmentClass,
    hasRealSideEffects: r['has_real_side_effects'] as boolean,
    updatedBy: (r['updated_by'] as string | null) ?? null,
    updatedAt: iso(r['updated_at'])!,
  };
}

function toAuth(r: Row): LoadAuthorization {
  return {
    id: r['id'] as string,
    apiId: r['api_id'] as string,
    status: r['status'] as LoadAuthorizationStatus,
    reference: r['reference'] as string,
    scope: r['scope'] as string,
    windowStart: r['window_start'] as Date,
    windowEnd: r['window_end'] as Date,
    maxRps: Number(r['max_rps']),
    maxVus: Number(r['max_vus']),
    maxDurationSeconds: Number(r['max_duration_seconds']),
    allowRealSideEffects: r['allow_real_side_effects'] as boolean,
    proposedBy: r['proposed_by'] as string,
    reviewedBy: (r['reviewed_by'] as string | null) ?? null,
    reviewNote: (r['review_note'] as string | null) ?? null,
    reviewedAt: iso(r['reviewed_at']),
    revokedAt: iso(r['revoked_at']),
    revokedReason: (r['revoked_reason'] as string | null) ?? null,
    createdAt: iso(r['created_at'])!,
  };
}

export async function getTargetConfig(apiId: string): Promise<LoadTargetConfig | null> {
  const { rows } = await query<Row>(`SELECT * FROM load_test_target_config WHERE api_id = $1`, [
    apiId,
  ]);
  return rows[0] ? toConfig(rows[0]) : null;
}

export async function upsertTargetConfig(
  apiId: string,
  environmentClass: LoadEnvironmentClass,
  hasRealSideEffects: boolean,
  updatedBy: string | null,
  runner: SqlRunner = { query },
): Promise<LoadTargetConfig> {
  const { rows } = await runner.query<Row>(
    `INSERT INTO load_test_target_config (api_id, environment_class, has_real_side_effects, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (api_id) DO UPDATE SET
       environment_class = EXCLUDED.environment_class,
       has_real_side_effects = EXCLUDED.has_real_side_effects,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING *`,
    [apiId, environmentClass, hasRealSideEffects, updatedBy],
  );
  return toConfig(rows[0]!);
}

export interface NewAuthorization {
  apiId: string;
  reference: string;
  scope: string;
  windowStart: Date;
  windowEnd: Date;
  maxRps: number;
  maxVus: number;
  maxDurationSeconds: number;
  allowRealSideEffects: boolean;
  proposedBy: string;
}

export async function createAuthorization(
  a: NewAuthorization,
  runner: SqlRunner = { query },
): Promise<LoadAuthorization> {
  const { rows } = await runner.query<Row>(
    `INSERT INTO load_test_authorizations
       (api_id, reference, scope, window_start, window_end, max_rps, max_vus,
        max_duration_seconds, allow_real_side_effects, proposed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      a.apiId,
      a.reference,
      a.scope,
      a.windowStart,
      a.windowEnd,
      a.maxRps,
      a.maxVus,
      a.maxDurationSeconds,
      a.allowRealSideEffects,
      a.proposedBy,
    ],
  );
  return toAuth(rows[0]!);
}

export async function getAuthorization(
  id: string,
  runner: SqlRunner = { query },
): Promise<LoadAuthorization | null> {
  const { rows } = await runner.query<Row>(`SELECT * FROM load_test_authorizations WHERE id = $1`, [
    id,
  ]);
  return rows[0] ? toAuth(rows[0]) : null;
}

export async function listAuthorizations(filter: {
  apiId?: string | undefined;
  status?: LoadAuthorizationStatus | undefined;
}): Promise<LoadAuthorization[]> {
  const { rows } = await query<Row>(
    `SELECT * FROM load_test_authorizations
      WHERE ($1::uuid IS NULL OR api_id = $1)
        AND ($2::load_authorization_status IS NULL OR status = $2)
      ORDER BY created_at DESC LIMIT 200`,
    [filter.apiId ?? null, filter.status ?? null],
  );
  return rows.map(toAuth);
}

/**
 * The authorization a run would be judged against: an APPROVED one covering
 * `now` if any, else the most recent approved/revoked/pending one so the
 * violation message can say *why* it does not qualify.
 */
export async function findRelevantAuthorization(
  apiId: string,
  now: Date,
): Promise<LoadAuthorization | null> {
  const { rows } = await query<Row>(
    `SELECT * FROM load_test_authorizations
      WHERE api_id = $1
      ORDER BY (status = 'APPROVED' AND window_start <= $2 AND window_end > $2) DESC,
               created_at DESC
      LIMIT 1`,
    [apiId, now],
  );
  return rows[0] ? toAuth(rows[0]) : null;
}

/** Moves a PENDING authorization to APPROVED/REJECTED. Returns null if not pending. */
export async function reviewAuthorization(
  id: string,
  status: 'APPROVED' | 'REJECTED',
  reviewedBy: string,
  note: string | null,
  runner: SqlRunner = { query },
): Promise<LoadAuthorization | null> {
  const { rows } = await runner.query<Row>(
    `UPDATE load_test_authorizations
        SET status = $2, reviewed_by = $3, review_note = $4, reviewed_at = now()
      WHERE id = $1 AND status = 'PENDING'
      RETURNING *`,
    [id, status, reviewedBy, note],
  );
  return rows[0] ? toAuth(rows[0]) : null;
}

export async function revokeAuthorization(
  id: string,
  reason: string,
  runner: SqlRunner = { query },
): Promise<LoadAuthorization | null> {
  const { rows } = await runner.query<Row>(
    `UPDATE load_test_authorizations
        SET status = 'REVOKED', revoked_at = now(), revoked_reason = $2
      WHERE id = $1 AND status IN ('PENDING','APPROVED')
      RETURNING *`,
    [id, reason],
  );
  return rows[0] ? toAuth(rows[0]) : null;
}

export interface KillSwitchState {
  engaged: boolean;
  reason: string | null;
  setBy: string | null;
  setAt: string;
}

export async function getKillSwitch(): Promise<KillSwitchState> {
  const { rows } = await query<Row>(`SELECT * FROM load_test_control WHERE singleton`);
  const r = rows[0];
  // A missing control row is treated as engaged — fail closed.
  if (!r)
    return {
      engaged: true,
      reason: 'control row missing',
      setBy: null,
      setAt: new Date().toISOString(),
    };
  return {
    engaged: r['kill_switch'] as boolean,
    reason: (r['reason'] as string | null) ?? null,
    setBy: (r['set_by'] as string | null) ?? null,
    setAt: iso(r['set_at'])!,
  };
}

export async function setKillSwitch(
  engaged: boolean,
  reason: string | null,
  setBy: string | null,
): Promise<KillSwitchState> {
  await query(
    `UPDATE load_test_control SET kill_switch = $1, reason = $2, set_by = $3, set_at = now() WHERE singleton`,
    [engaged, reason, setBy],
  );
  return getKillSwitch();
}
