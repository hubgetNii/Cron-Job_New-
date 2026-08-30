import { query, sql, type SqlRunner } from '../lib/db.js';
import type { AlertChannel, AlertStatus, AlertType } from '../domain/enums.js';

function runner(client?: SqlRunner): SqlRunner {
  return client ?? sql;
}

export interface Alert {
  id: string;
  incidentId: string | null;
  apiId: string | null;
  alertType: AlertType;
  channel: AlertChannel;
  recipient: string;
  status: AlertStatus;
  escalationTier: number | null;
  sentAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
}

const COLUMNS = `
  id, incident_id, api_id, alert_type, channel, recipient, status,
  escalation_tier, sent_at, error_message, created_at`;

function toDomain(r: Record<string, unknown>): Alert {
  return {
    id: r['id'] as string,
    incidentId: (r['incident_id'] as string | null) ?? null,
    apiId: (r['api_id'] as string | null) ?? null,
    alertType: r['alert_type'] as AlertType,
    channel: r['channel'] as AlertChannel,
    recipient: r['recipient'] as string,
    status: r['status'] as AlertStatus,
    escalationTier: (r['escalation_tier'] as number | null) ?? null,
    sentAt: (r['sent_at'] as Date | null) ?? null,
    errorMessage: (r['error_message'] as string | null) ?? null,
    createdAt: r['created_at'] as Date,
  };
}

export interface CreateAlertInput {
  alertType: AlertType;
  channel: AlertChannel;
  recipient: string;
  incidentId?: string | null;
  apiId?: string | null;
  escalationTier?: number | null;
  status?: AlertStatus;
}

export async function createAlert(input: CreateAlertInput, client?: SqlRunner): Promise<Alert> {
  const { rows } = await runner(client).query(
    `INSERT INTO alerts (incident_id, api_id, alert_type, channel, recipient, status, escalation_tier)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${COLUMNS}`,
    [
      input.incidentId ?? null,
      input.apiId ?? null,
      input.alertType,
      input.channel,
      input.recipient,
      input.status ?? 'PENDING',
      input.escalationTier ?? null,
    ],
  );
  return toDomain(rows[0] as Record<string, unknown>);
}

export async function listPendingAlerts(limit = 100): Promise<Alert[]> {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM alerts WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT $1`,
    [limit],
  );
  return (rows as Array<Record<string, unknown>>).map(toDomain);
}

export async function markAlert(
  id: string,
  status: Extract<AlertStatus, 'SENT' | 'FAILED' | 'SUPPRESSED'>,
  detail: string | null,
): Promise<void> {
  await query(
    `UPDATE alerts
     SET status = $2::alert_status,
         sent_at = CASE WHEN $2::text = 'SENT' THEN now() ELSE sent_at END,
         error_message = $3
     WHERE id = $1`,
    [id, status, detail],
  );
}

export interface ListAlertFilters {
  incidentId?: string;
  apiId?: string;
  status?: AlertStatus;
  alertType?: AlertType;
  limit?: number;
  offset?: number;
}

export async function listAlerts(filters: ListAlertFilters = {}): Promise<Alert[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (frag: string, value: unknown): void => {
    params.push(value);
    where.push(frag.replace('?', `$${params.length}`));
  };
  if (filters.incidentId) add('incident_id = ?', filters.incidentId);
  if (filters.apiId) add('api_id = ?', filters.apiId);
  if (filters.status) add('status = ?', filters.status);
  if (filters.alertType) add('alert_type = ?', filters.alertType);

  const limit = Math.min(filters.limit ?? 100, 500);
  const offset = filters.offset ?? 0;
  params.push(limit, offset);

  const { rows } = await query(
    `SELECT ${COLUMNS} FROM alerts
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return (rows as Array<Record<string, unknown>>).map(toDomain);
}

/** The highest escalation tier already actioned for an incident. */
export async function highestTierFired(incidentId: string): Promise<number> {
  const { rows } = await query<{ tier: number | null }>(
    `SELECT MAX(escalation_tier) AS tier FROM alerts
     WHERE incident_id = $1 AND status <> 'FAILED'`,
    [incidentId],
  );
  return rows[0]?.tier ?? -1;
}

/** Distinct channel+recipient pairs already notified for an incident (for recovery fan-out). */
export async function notifiedTargetsForIncident(
  incidentId: string,
): Promise<Array<{ channel: AlertChannel; recipient: string }>> {
  const { rows } = await query<{ channel: AlertChannel; recipient: string }>(
    `SELECT DISTINCT channel, recipient FROM alerts
     WHERE incident_id = $1 AND status = 'SENT' AND alert_type <> 'API_RECOVERED'`,
    [incidentId],
  );
  return rows;
}

/** Was a similar alert sent for this incident inside the suppression window? */
export async function recentAlertExists(
  incidentId: string,
  alertType: AlertType,
  withinMinutes: number,
): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM alerts
     WHERE incident_id = $1 AND alert_type = $2 AND status IN ('SENT','PENDING','SUPPRESSED')
       AND created_at > now() - ($3::int * interval '1 minute')
     LIMIT 1`,
    [incidentId, alertType, withinMinutes],
  );
  return rows.length > 0;
}
