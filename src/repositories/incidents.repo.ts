import { query, sql, type SqlRunner } from '../lib/db.js';
import type { Incident } from '../domain/incident.js';
import type {
  CheckFailureType,
  EndpointClass,
  IncidentStatus,
  IncidentType,
  Severity,
} from '../domain/enums.js';

function runner(client?: SqlRunner): SqlRunner {
  return client ?? sql;
}

const COLUMNS = `
  id, api_id, incident_number, incident_type, severity, endpoint_class_snapshot,
  is_money_moving_snapshot, status, started_at, detected_by_check_id,
  acknowledged_at, acknowledged_by, resolved_at, duration_seconds, failure_count,
  failure_type, escalation_level_reached, root_cause, resolution, created_at, updated_at`;

function toDomain(r: Record<string, unknown>): Incident {
  return {
    id: r['id'] as string,
    apiId: r['api_id'] as string,
    incidentNumber: r['incident_number'] as string,
    incidentType: r['incident_type'] as IncidentType,
    severity: r['severity'] as Severity,
    endpointClassSnapshot: r['endpoint_class_snapshot'] as EndpointClass,
    isMoneyMovingSnapshot: r['is_money_moving_snapshot'] as boolean,
    status: r['status'] as IncidentStatus,
    startedAt: r['started_at'] as Date,
    detectedByCheckId: (r['detected_by_check_id'] as string | null) ?? null,
    acknowledgedAt: (r['acknowledged_at'] as Date | null) ?? null,
    acknowledgedBy: (r['acknowledged_by'] as string | null) ?? null,
    resolvedAt: (r['resolved_at'] as Date | null) ?? null,
    durationSeconds: (r['duration_seconds'] as number | null) ?? null,
    failureCount: r['failure_count'] as number,
    failureType: (r['failure_type'] as CheckFailureType | null) ?? null,
    escalationLevelReached: r['escalation_level_reached'] as number,
    rootCause: (r['root_cause'] as string | null) ?? null,
    resolution: (r['resolution'] as string | null) ?? null,
    createdAt: r['created_at'] as Date,
    updatedAt: r['updated_at'] as Date,
  };
}

/** The one non-resolved incident for a target, if any (DB enforces at most one). */
export async function findActiveIncident(
  apiId: string,
  client?: SqlRunner,
): Promise<Incident | null> {
  const { rows } = await runner(client).query(
    `SELECT ${COLUMNS} FROM incidents WHERE api_id = $1 AND status <> 'RESOLVED'`,
    [apiId],
  );
  return rows[0] ? toDomain(rows[0]) : null;
}

export interface OpenIncidentInput {
  apiId: string;
  incidentType: IncidentType;
  severity: Severity;
  endpointClassSnapshot: EndpointClass;
  isMoneyMovingSnapshot: boolean;
  detectedByCheckId: string | null;
  failureType: CheckFailureType | null;
}

export async function openIncident(
  input: OpenIncidentInput,
  client?: SqlRunner,
): Promise<Incident> {
  const { rows } = await runner(client).query(
    `INSERT INTO incidents
       (api_id, incident_number, incident_type, severity, endpoint_class_snapshot,
        is_money_moving_snapshot, status, detected_by_check_id, failure_type, failure_count)
     VALUES ($1,
             'INC-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('incident_number_seq')::text, 6, '0'),
             $2, $3, $4, $5, 'OPEN', $6, $7, 1)
     RETURNING ${COLUMNS}`,
    [
      input.apiId,
      input.incidentType,
      input.severity,
      input.endpointClassSnapshot,
      input.isMoneyMovingSnapshot,
      input.detectedByCheckId,
      input.failureType,
    ],
  );
  return toDomain(rows[0]!);
}

export async function incrementFailureCount(
  id: string,
  failureType: CheckFailureType | null,
  client?: SqlRunner,
): Promise<void> {
  await runner(client).query(
    `UPDATE incidents
     SET failure_count = failure_count + 1,
         failure_type = COALESCE($2, failure_type)
     WHERE id = $1`,
    [id, failureType],
  );
}

export async function markIncidentFlapping(id: string, client?: SqlRunner): Promise<void> {
  await runner(client).query(
    `UPDATE incidents SET incident_type = 'FLAPPING' WHERE id = $1 AND incident_type <> 'FLAPPING'`,
    [id],
  );
}

export async function escalateIncident(
  id: string,
  level: number,
  client?: SqlRunner,
): Promise<void> {
  await runner(client).query(
    `UPDATE incidents SET escalation_level_reached = GREATEST(escalation_level_reached, $2) WHERE id = $1`,
    [id, level],
  );
}

export async function resolveIncident(
  id: string,
  resolution: string | null,
  client?: SqlRunner,
): Promise<Incident | null> {
  const { rows } = await runner(client).query(
    `UPDATE incidents
     SET status = 'RESOLVED',
         resolved_at = now(),
         duration_seconds = EXTRACT(EPOCH FROM (now() - started_at))::int,
         resolution = COALESCE($2, resolution)
     WHERE id = $1 AND status <> 'RESOLVED'
     RETURNING ${COLUMNS}`,
    [id, resolution],
  );
  return rows[0] ? toDomain(rows[0]) : null;
}

export async function acknowledgeIncident(
  id: string,
  /** User UUID, or null when acted on by a system/anonymous actor (Phase 9 adds real users). */
  byUserId: string | null,
  client?: SqlRunner,
): Promise<Incident | null> {
  const { rows } = await runner(client).query(
    `UPDATE incidents
     SET status = CASE WHEN status = 'OPEN' THEN 'ACKNOWLEDGED' ELSE status END,
         acknowledged_at = COALESCE(acknowledged_at, now()),
         acknowledged_by = COALESCE(acknowledged_by, $2::uuid)
     WHERE id = $1 AND status <> 'RESOLVED'
     RETURNING ${COLUMNS}`,
    [id, byUserId],
  );
  return rows[0] ? toDomain(rows[0]) : null;
}

export async function setRootCause(id: string, rootCause: string): Promise<Incident | null> {
  const { rows } = await query(
    `UPDATE incidents SET root_cause = $2 WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, rootCause],
  );
  return rows[0] ? toDomain(rows[0]) : null;
}

export async function getIncident(id: string): Promise<Incident | null> {
  const { rows } = await query(`SELECT ${COLUMNS} FROM incidents WHERE id = $1`, [id]);
  return rows[0] ? toDomain(rows[0]) : null;
}

export interface ListIncidentFilters {
  status?: IncidentStatus;
  severity?: Severity;
  apiId?: string;
  isMoneyMoving?: boolean;
  incidentType?: IncidentType;
  limit?: number;
  offset?: number;
}

export interface EscalatableIncident {
  incident: Incident;
  escalationPolicyId: string;
  targetName: string;
}

/** OPEN incidents whose target has an escalation policy — the escalation engine's work list. */
export async function listOpenIncidentsForEscalation(): Promise<EscalatableIncident[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${COLUMNS.split(',')
      .map((c) => `i.${c.trim()}`)
      .join(', ')},
            m.escalation_policy_id, m.name AS target_name
     FROM incidents i
     JOIN monitored_apis m ON m.id = i.api_id
     WHERE i.status = 'OPEN' AND m.escalation_policy_id IS NOT NULL
     ORDER BY i.started_at ASC`,
  );
  return rows.map((r) => ({
    incident: toDomain(r),
    escalationPolicyId: r['escalation_policy_id'] as string,
    targetName: r['target_name'] as string,
  }));
}

export async function listIncidents(filters: ListIncidentFilters = {}): Promise<Incident[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (frag: string, value: unknown): void => {
    params.push(value);
    where.push(frag.replace('?', `$${params.length}`));
  };
  if (filters.status) add('status = ?', filters.status);
  if (filters.severity) add('severity = ?', filters.severity);
  if (filters.apiId) add('api_id = ?', filters.apiId);
  if (filters.isMoneyMoving !== undefined)
    add('is_money_moving_snapshot = ?', filters.isMoneyMoving);
  if (filters.incidentType) add('incident_type = ?', filters.incidentType);

  const limit = Math.min(filters.limit ?? 100, 500);
  const offset = filters.offset ?? 0;
  params.push(limit, offset);

  const { rows } = await query(
    `SELECT ${COLUMNS} FROM incidents
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY started_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return (rows as Array<Record<string, unknown>>).map(toDomain);
}

/**
 * Counts health-status changes for a target in the recent window, by walking
 * its check results. Used by the flapping guard (see vault: "Incident
 * Lifecycle") — a table is unnecessary when the results already record it.
 */
export async function countStatusTransitions(
  apiId: string,
  windowMinutes: number,
  client?: SqlRunner,
): Promise<number> {
  const { rows } = await runner(client).query<{ status: string }>(
    `SELECT status FROM health_check_results
     WHERE api_id = $1 AND checked_at > now() - ($2::int * interval '1 minute')
     ORDER BY checked_at ASC`,
    [apiId, windowMinutes],
  );
  let transitions = 0;
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i]!.status !== rows[i - 1]!.status) transitions += 1;
  }
  return transitions;
}
