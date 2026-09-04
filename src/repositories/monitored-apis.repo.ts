import { query, sql, type SqlRunner } from '../lib/db.js';
import type { CredentialEnvelope } from '../lib/crypto/credential-cipher.js';
import type { MonitoredApi, RetryConfig, ValidationRule } from '../domain/target.js';
import type {
  AuthType,
  EndpointClass,
  Environment,
  HttpMethod,
  Severity,
} from '../domain/enums.js';

function runner(client?: SqlRunner): SqlRunner {
  return client ?? sql;
}

/** Fully-resolved target ready to persist (service has validated + encrypted). */
export interface TargetWriteModel {
  name: string;
  description: string | null;
  environment: Environment;
  endpointClass: EndpointClass;
  severityDefault: Severity;
  isMoneyMoving: boolean;
  url: string;
  method: HttpMethod;
  authenticationType: AuthType;
  encryptedCredentials: CredentialEnvelope | null;
  headers: Record<string, string>;
  requestBody: unknown;
  expectedStatus: number | null;
  expectedResponse: ValidationRule | null;
  timeoutMs: number;
  frequencyCron: string;
  retry: RetryConfig;
  slaTargetPercent: number;
  ownerId: string | null;
  teamId: string | null;
  escalationPolicyId: string | null;
  tags: string[];
  isActive: boolean;
  allowPrivateNetwork: boolean;
  bypassMinIntervalFloor: boolean;
}

interface Row {
  id: string;
  name: string;
  description: string | null;
  environment: Environment;
  endpoint_class: EndpointClass;
  severity_default: Severity;
  is_money_moving: boolean;
  url: string;
  method: HttpMethod;
  authentication_type: AuthType;
  encrypted_credentials: CredentialEnvelope | null;
  headers: Record<string, string>;
  request_body: unknown;
  expected_status: number | null;
  expected_response: ValidationRule | null;
  timeout_ms: number;
  frequency_cron: string;
  retry_count: number;
  retry_base_delay_ms: number;
  retry_backoff_multiplier: string;
  retry_max_delay_ms: number;
  sla_target_percent: string;
  owner_id: string | null;
  team_id: string | null;
  escalation_policy_id: string | null;
  tags: string[];
  is_active: boolean;
  allow_private_network: boolean;
  bypass_min_interval_floor: boolean;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `
  id, name, description, environment, endpoint_class, severity_default, is_money_moving,
  url, method, authentication_type, encrypted_credentials, headers, request_body,
  expected_status, expected_response, timeout_ms, frequency_cron,
  retry_count, retry_base_delay_ms, retry_backoff_multiplier, retry_max_delay_ms,
  sla_target_percent, owner_id, team_id, escalation_policy_id, tags, is_active,
  allow_private_network, bypass_min_interval_floor, created_at, updated_at`;

function toDomain(row: Row): MonitoredApi {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    environment: row.environment,
    endpointClass: row.endpoint_class,
    severityDefault: row.severity_default,
    isMoneyMoving: row.is_money_moving,
    url: row.url,
    method: row.method,
    authenticationType: row.authentication_type,
    hasCredentials: row.encrypted_credentials !== null,
    headers: row.headers ?? {},
    requestBody: row.request_body,
    expectedStatus: row.expected_status,
    expectedResponse: row.expected_response,
    timeoutMs: row.timeout_ms,
    frequencyCron: row.frequency_cron,
    retry: {
      count: row.retry_count,
      baseDelayMs: row.retry_base_delay_ms,
      backoffMultiplier: Number(row.retry_backoff_multiplier),
      maxDelayMs: row.retry_max_delay_ms,
    },
    slaTargetPercent: Number(row.sla_target_percent),
    ownerId: row.owner_id,
    teamId: row.team_id,
    escalationPolicyId: row.escalation_policy_id,
    tags: row.tags ?? [],
    isActive: row.is_active,
    allowPrivateNetwork: row.allow_private_network,
    bypassMinIntervalFloor: row.bypass_min_interval_floor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function writeParams(m: TargetWriteModel): unknown[] {
  return [
    m.name,
    m.description,
    m.environment,
    m.endpointClass,
    m.severityDefault,
    m.isMoneyMoving,
    m.url,
    m.method,
    m.authenticationType,
    m.encryptedCredentials ? JSON.stringify(m.encryptedCredentials) : null,
    JSON.stringify(m.headers),
    m.requestBody === undefined ? null : JSON.stringify(m.requestBody),
    m.expectedStatus,
    m.expectedResponse ? JSON.stringify(m.expectedResponse) : null,
    m.timeoutMs,
    m.frequencyCron,
    m.retry.count,
    m.retry.baseDelayMs,
    m.retry.backoffMultiplier,
    m.retry.maxDelayMs,
    m.slaTargetPercent,
    m.ownerId,
    m.teamId,
    m.escalationPolicyId,
    m.tags,
    m.isActive,
    m.allowPrivateNetwork,
    m.bypassMinIntervalFloor,
  ];
}

const WRITE_COLUMNS = `
  name, description, environment, endpoint_class, severity_default, is_money_moving,
  url, method, authentication_type, encrypted_credentials, headers, request_body,
  expected_status, expected_response, timeout_ms, frequency_cron,
  retry_count, retry_base_delay_ms, retry_backoff_multiplier, retry_max_delay_ms,
  sla_target_percent, owner_id, team_id, escalation_policy_id, tags, is_active,
  allow_private_network, bypass_min_interval_floor`;

export async function createTarget(
  model: TargetWriteModel,
  client?: SqlRunner,
): Promise<MonitoredApi> {
  const params = writeParams(model);
  const placeholders = params.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await runner(client).query(
    `INSERT INTO monitored_apis (${WRITE_COLUMNS}) VALUES (${placeholders}) RETURNING ${COLUMNS}`,
    params,
  );
  return toDomain(rows[0] as Row);
}

export async function updateTarget(
  id: string,
  model: TargetWriteModel,
  client?: SqlRunner,
): Promise<MonitoredApi | null> {
  const params = writeParams(model);
  const cols = WRITE_COLUMNS.split(',').map((c) => c.trim());
  const setClause = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
  const { rows } = await runner(client).query(
    `UPDATE monitored_apis SET ${setClause} WHERE id = $${params.length + 1} RETURNING ${COLUMNS}`,
    [...params, id],
  );
  return rows[0] ? toDomain(rows[0] as Row) : null;
}

export async function findTargetById(id: string, client?: SqlRunner): Promise<MonitoredApi | null> {
  const { rows } = await runner(client).query(
    `SELECT ${COLUMNS} FROM monitored_apis WHERE id = $1`,
    [id],
  );
  return rows[0] ? toDomain(rows[0] as Row) : null;
}

/** Raw encrypted credential envelope for a target, for the health-check worker. */
export async function findTargetCredentialEnvelope(
  id: string,
  client?: SqlRunner,
): Promise<CredentialEnvelope | null> {
  const { rows } = await runner(client).query<{ encrypted_credentials: CredentialEnvelope | null }>(
    `SELECT encrypted_credentials FROM monitored_apis WHERE id = $1`,
    [id],
  );
  return rows[0]?.encrypted_credentials ?? null;
}

export interface ListTargetFilters {
  environment?: Environment;
  endpointClass?: EndpointClass;
  isActive?: boolean;
  isMoneyMoving?: boolean;
  teamId?: string;
  tag?: string;
  limit?: number;
  offset?: number;
}

export async function listTargets(filters: ListTargetFilters = {}): Promise<MonitoredApi[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (frag: string, value: unknown): void => {
    params.push(value);
    where.push(frag.replace('?', `$${params.length}`));
  };
  if (filters.environment) add('environment = ?', filters.environment);
  if (filters.endpointClass) add('endpoint_class = ?', filters.endpointClass);
  if (filters.isActive !== undefined) add('is_active = ?', filters.isActive);
  if (filters.isMoneyMoving !== undefined) add('is_money_moving = ?', filters.isMoneyMoving);
  if (filters.teamId) add('team_id = ?', filters.teamId);
  if (filters.tag) add('? = ANY(tags)', filters.tag);

  const limit = Math.min(filters.limit ?? 100, 500);
  const offset = filters.offset ?? 0;
  params.push(limit, offset);

  const { rows } = await query(
    `SELECT ${COLUMNS} FROM monitored_apis
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return (rows as Row[]).map(toDomain);
}

/** Active targets with their schedule, for the scheduler to register. */
export async function listActiveTargets(): Promise<MonitoredApi[]> {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM monitored_apis WHERE is_active = true ORDER BY id`,
  );
  return (rows as Row[]).map(toDomain);
}

export async function setTargetActive(
  id: string,
  isActive: boolean,
  client?: SqlRunner,
): Promise<MonitoredApi | null> {
  const { rows } = await runner(client).query(
    `UPDATE monitored_apis SET is_active = $1 WHERE id = $2 RETURNING ${COLUMNS}`,
    [isActive, id],
  );
  return rows[0] ? toDomain(rows[0] as Row) : null;
}

export async function deleteTarget(id: string, client?: SqlRunner): Promise<boolean> {
  const { rowCount } = await runner(client).query(`DELETE FROM monitored_apis WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}
