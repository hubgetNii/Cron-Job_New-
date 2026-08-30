import { query } from '../lib/db.js';

export interface MaintenanceWindow {
  id: string;
  targetId: string | null;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  ticketRef: string | null;
  createdBy: string | null;
  createdAt: Date;
}

function toDomain(r: Record<string, unknown>): MaintenanceWindow {
  return {
    id: r['id'] as string,
    targetId: (r['target_id'] as string | null) ?? null,
    startsAt: r['starts_at'] as Date,
    endsAt: r['ends_at'] as Date,
    reason: r['reason'] as string,
    ticketRef: (r['ticket_ref'] as string | null) ?? null,
    createdBy: (r['created_by'] as string | null) ?? null,
    createdAt: r['created_at'] as Date,
  };
}

const COLUMNS = `id, target_id, starts_at, ends_at, reason, ticket_ref, created_by, created_at`;

export async function createMaintenanceWindow(input: {
  targetId: string | null;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  ticketRef?: string | null;
  createdBy?: string | null;
}): Promise<MaintenanceWindow> {
  const { rows } = await query(
    `INSERT INTO maintenance_windows (target_id, starts_at, ends_at, reason, ticket_ref, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${COLUMNS}`,
    [
      input.targetId,
      input.startsAt,
      input.endsAt,
      input.reason,
      input.ticketRef ?? null,
      input.createdBy ?? null,
    ],
  );
  return toDomain(rows[0] as Record<string, unknown>);
}

export async function deleteMaintenanceWindow(id: string): Promise<boolean> {
  const { rowCount } = await query(`DELETE FROM maintenance_windows WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

export async function listMaintenanceWindows(includeExpired = false): Promise<MaintenanceWindow[]> {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM maintenance_windows
     ${includeExpired ? '' : 'WHERE ends_at > now()'}
     ORDER BY starts_at DESC LIMIT 200`,
  );
  return (rows as Array<Record<string, unknown>>).map(toDomain);
}

/**
 * The maintenance window currently suppressing alerts for a target, if any —
 * a target-specific window or a global one (target_id IS NULL). Checks still
 * run and record; only alerting is suppressed (see vault: "Maintenance Windows").
 */
export async function activeWindowForTarget(
  apiId: string,
  at: Date = new Date(),
): Promise<MaintenanceWindow | null> {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM maintenance_windows
     WHERE (target_id = $1 OR target_id IS NULL)
       AND starts_at <= $2 AND ends_at > $2
     ORDER BY target_id NULLS LAST
     LIMIT 1`,
    [apiId, at],
  );
  return rows[0] ? toDomain(rows[0]) : null;
}
