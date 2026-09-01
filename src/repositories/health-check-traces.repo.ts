import { randomBytes } from 'node:crypto';
import { query, sql, type SqlRunner } from '../lib/db.js';
import { encryptJson, decryptJson } from '../lib/crypto/credential-cipher.js';
import { isCredentialEnvelope } from '../lib/crypto/credential-cipher.js';
import type { CheckFailureType, HealthStatus, HttpMethod } from '../domain/enums.js';
import type { RequestResponseTrace } from '../domain/health-check.js';

function runner(client?: SqlRunner): SqlRunner {
  return client ?? sql;
}

export function newRequestId(): string {
  return `REQ-${randomBytes(6).toString('hex')}`;
}

export interface InsertTraceInput {
  checkId: string;
  apiId: string;
  jobRunId: string | null;
  requestId: string;
  correlationId: string;
  checkedAt: Date;
  healthStatus: HealthStatus;
  attempts: number;
  failureType: CheckFailureType | null;
  trace: RequestResponseTrace;
}

/** Persists one trace. Masked columns are plain; the true request/response is encrypted. */
export async function insertTrace(input: InsertTraceInput, client?: SqlRunner): Promise<void> {
  const t = input.trace;
  await runner(client).query(
    `INSERT INTO health_check_traces
       (check_id, api_id, job_run_id, request_id, correlation_id, checked_at,
        request_method, request_url_masked, request_headers_masked, request_body_masked,
        response_status, response_headers_masked, response_body_masked, response_bytes,
        response_content_type, response_time_ms, attempts, health_status, failure_type, raw_encrypted)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (check_id) DO NOTHING`,
    [
      input.checkId,
      input.apiId,
      input.jobRunId,
      input.requestId,
      input.correlationId,
      input.checkedAt,
      t.requestMethod,
      t.requestUrlMasked,
      JSON.stringify(t.requestHeadersMasked),
      t.requestBodyMasked,
      t.responseStatus,
      JSON.stringify(t.responseHeadersMasked),
      t.responseBodyMasked,
      t.responseBytes,
      t.responseContentType,
      t.responseTimeMs,
      input.attempts,
      input.healthStatus,
      input.failureType,
      JSON.stringify(encryptJson(t.raw)),
    ],
  );
}

export interface TraceRow {
  id: string;
  checkId: string;
  apiId: string;
  targetName: string | null;
  jobRunId: string | null;
  requestId: string;
  correlationId: string;
  checkedAt: string;
  requestMethod: HttpMethod;
  requestUrlMasked: string;
  requestHeadersMasked: Record<string, string>;
  requestBodyMasked: string | null;
  responseStatus: number | null;
  responseHeadersMasked: Record<string, string>;
  responseBodyMasked: string | null;
  responseBytes: number | null;
  responseContentType: string | null;
  responseTimeMs: number | null;
  attempts: number;
  healthStatus: HealthStatus;
  failureType: CheckFailureType | null;
  hasRaw: boolean;
}

function toRow(r: Record<string, unknown>): TraceRow {
  return {
    id: r['id'] as string,
    checkId: r['check_id'] as string,
    apiId: r['api_id'] as string,
    targetName: (r['target_name'] as string | null) ?? null,
    jobRunId: (r['job_run_id'] as string | null) ?? null,
    requestId: r['request_id'] as string,
    correlationId: r['correlation_id'] as string,
    checkedAt: (r['checked_at'] as Date).toISOString(),
    requestMethod: r['request_method'] as HttpMethod,
    requestUrlMasked: r['request_url_masked'] as string,
    requestHeadersMasked: (r['request_headers_masked'] as Record<string, string> | null) ?? {},
    requestBodyMasked: (r['request_body_masked'] as string | null) ?? null,
    responseStatus: (r['response_status'] as number | null) ?? null,
    responseHeadersMasked: (r['response_headers_masked'] as Record<string, string> | null) ?? {},
    responseBodyMasked: (r['response_body_masked'] as string | null) ?? null,
    responseBytes: (r['response_bytes'] as number | null) ?? null,
    responseContentType: (r['response_content_type'] as string | null) ?? null,
    responseTimeMs: (r['response_time_ms'] as number | null) ?? null,
    attempts: Number(r['attempts']),
    healthStatus: r['health_status'] as HealthStatus,
    failureType: (r['failure_type'] as CheckFailureType | null) ?? null,
    hasRaw: r['raw_encrypted'] === true,
  };
}

const SELECT = `
  SELECT t.id, t.check_id, t.api_id, m.name AS target_name, t.job_run_id, t.request_id,
         t.correlation_id, t.checked_at, t.request_method, t.request_url_masked,
         t.request_headers_masked, t.request_body_masked, t.response_status,
         t.response_headers_masked, t.response_body_masked, t.response_bytes,
         t.response_content_type, t.response_time_ms, t.attempts, t.health_status,
         t.failure_type, (t.raw_encrypted IS NOT NULL) AS raw_encrypted
  FROM health_check_traces t
  LEFT JOIN monitored_apis m ON m.id = t.api_id`;

export async function getTraceByCheckId(checkId: string): Promise<TraceRow | null> {
  const { rows } = await query<Record<string, unknown>>(`${SELECT} WHERE t.check_id = $1`, [checkId]);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function getTraceById(id: string): Promise<TraceRow | null> {
  const { rows } = await query<Record<string, unknown>>(`${SELECT} WHERE t.id = $1`, [id]);
  return rows[0] ? toRow(rows[0]) : null;
}

export interface TraceSearchFilters {
  apiId?: string;
  healthStatus?: HealthStatus;
  httpStatus?: number;
  statusClass?: '2xx' | '3xx' | '4xx' | '5xx';
  failureType?: CheckFailureType;
  requestId?: string;
  correlationId?: string;
  /** substring match on the masked URL / bodies */
  q?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

/** Builds the shared WHERE clause + params for search and export. */
function buildWhere(f: TraceSearchFilters): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (frag: string, value: unknown): void => {
    params.push(value);
    clauses.push(frag.replace('?', `$${params.length}`));
  };
  if (f.apiId) add('t.api_id = ?', f.apiId);
  if (f.healthStatus) add('t.health_status = ?', f.healthStatus);
  if (f.httpStatus != null) add('t.response_status = ?', f.httpStatus);
  if (f.statusClass) {
    const lo = Number(f.statusClass[0]) * 100;
    add('t.response_status >= ?', lo);
    add('t.response_status < ?', lo + 100);
  }
  if (f.failureType) add('t.failure_type = ?', f.failureType);
  if (f.requestId) add('t.request_id = ?', f.requestId);
  if (f.correlationId) add('t.correlation_id = ?', f.correlationId);
  if (f.from) add('t.checked_at >= ?', f.from);
  if (f.to) add('t.checked_at < ?', f.to);
  if (f.q) {
    params.push(`%${f.q}%`);
    const p = `$${params.length}`;
    clauses.push(
      `(t.request_url_masked ILIKE ${p} OR t.request_body_masked ILIKE ${p} OR t.response_body_masked ILIKE ${p})`,
    );
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export async function searchTraces(
  f: TraceSearchFilters,
): Promise<{ rows: TraceRow[]; total: number }> {
  const { where, params } = buildWhere(f);
  const limit = Math.min(f.limit ?? 50, 500);
  const offset = f.offset ?? 0;

  const list = await query<Record<string, unknown>>(
    `${SELECT} ${where} ORDER BY t.checked_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  const count = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM health_check_traces t ${where}`,
    params,
  );
  return { rows: list.rows.map(toRow), total: Number(count.rows[0]?.n ?? '0') };
}

export interface RawTrace {
  requestUrl: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseHeaders: Record<string, string>;
  responseBody: string | null;
}

/** Decrypts and returns the true request/response. Caller MUST have logged the reveal. */
export async function revealRawTrace(checkId: string): Promise<RawTrace | null> {
  const { rows } = await query<{ raw_encrypted: unknown }>(
    `SELECT raw_encrypted FROM health_check_traces WHERE check_id = $1`,
    [checkId],
  );
  const env = rows[0]?.raw_encrypted;
  if (!env || !isCredentialEnvelope(env)) return null;
  return decryptJson<RawTrace>(env);
}

/** Retention prune — delete traces older than `days`. */
export async function pruneTraces(days: number): Promise<number> {
  const { rowCount } = await query(
    `DELETE FROM health_check_traces WHERE checked_at < now() - ($1::int * interval '1 day')`,
    [days],
  );
  return rowCount ?? 0;
}
