import { query } from '../lib/db.js';

export type ConfigRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'APPLIED' | 'FAILED';
export type ConfigRequestKind = 'target_create' | 'target_update';

export interface ConfigChangeRequest {
  id: string;
  kind: ConfigRequestKind;
  targetId: string | null;
  status: ConfigRequestStatus;
  payload: unknown;
  summary: string;
  proposedBy: string;
  reviewedBy: string | null;
  reviewNote: string | null;
  reviewedAt: Date | null;
  appliedAt: Date | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = `
  id, kind, target_id, status, payload, summary, proposed_by, reviewed_by,
  review_note, reviewed_at, applied_at, error, created_at, updated_at`;

function toDomain(r: Record<string, unknown>): ConfigChangeRequest {
  return {
    id: r['id'] as string,
    kind: r['kind'] as ConfigRequestKind,
    targetId: (r['target_id'] as string | null) ?? null,
    status: r['status'] as ConfigRequestStatus,
    payload: r['payload'],
    summary: r['summary'] as string,
    proposedBy: r['proposed_by'] as string,
    reviewedBy: (r['reviewed_by'] as string | null) ?? null,
    reviewNote: (r['review_note'] as string | null) ?? null,
    reviewedAt: (r['reviewed_at'] as Date | null) ?? null,
    appliedAt: (r['applied_at'] as Date | null) ?? null,
    error: (r['error'] as string | null) ?? null,
    createdAt: r['created_at'] as Date,
    updatedAt: r['updated_at'] as Date,
  };
}

export async function createConfigRequest(input: {
  kind: ConfigRequestKind;
  targetId: string | null;
  payload: unknown;
  summary: string;
  proposedBy: string;
}): Promise<ConfigChangeRequest> {
  const { rows } = await query(
    `INSERT INTO config_change_requests (kind, target_id, payload, summary, proposed_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
    [input.kind, input.targetId, JSON.stringify(input.payload), input.summary, input.proposedBy],
  );
  return toDomain(rows[0]!);
}

export async function getConfigRequest(id: string): Promise<ConfigChangeRequest | null> {
  const { rows } = await query(`SELECT ${COLUMNS} FROM config_change_requests WHERE id = $1`, [id]);
  return rows[0] ? toDomain(rows[0]) : null;
}

export async function listConfigRequests(
  status?: ConfigRequestStatus,
): Promise<ConfigChangeRequest[]> {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM config_change_requests
     ${status ? 'WHERE status = $1' : ''}
     ORDER BY created_at DESC LIMIT 200`,
    status ? [status] : [],
  );
  return (rows as Array<Record<string, unknown>>).map(toDomain);
}

export async function markReviewed(
  id: string,
  reviewedBy: string,
  status: 'APPROVED' | 'REJECTED',
  note: string | null,
): Promise<ConfigChangeRequest | null> {
  const { rows } = await query(
    `UPDATE config_change_requests
     SET status = $3, reviewed_by = $2, review_note = $4, reviewed_at = now()
     WHERE id = $1 AND status = 'PENDING'
     RETURNING ${COLUMNS}`,
    [id, reviewedBy, status, note],
  );
  return rows[0] ? toDomain(rows[0]) : null;
}

export async function markApplied(id: string): Promise<void> {
  await query(
    `UPDATE config_change_requests SET status = 'APPLIED', applied_at = now() WHERE id = $1`,
    [id],
  );
}

export async function markFailed(id: string, error: string): Promise<void> {
  await query(`UPDATE config_change_requests SET status = 'FAILED', error = $2 WHERE id = $1`, [
    id,
    error,
  ]);
}
