import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDbHealth, closePool, query } from '../lib/db.js';
import {
  getTraceByCheckId,
  insertTrace,
  newRequestId,
  pruneTraces,
  revealRawTrace,
  searchTraces,
} from './health-check-traces.repo.js';
import type { RequestResponseTrace } from '../domain/health-check.js';

const dbUp = (await checkDbHealth()).ok;

let apiId: string;

async function seedCheck(status: string, httpStatus: number | null): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO health_check_results (api_id, job_run_id, checked_at, status, http_status, response_time_ms)
     VALUES ($1, $2, now(), $3, $4, 42) RETURNING id`,
    [apiId, `${apiId}:${Math.random()}`, status, httpStatus],
  );
  return rows[0]!.id;
}

const trace = (): RequestResponseTrace => ({
  requestMethod: 'GET',
  requestUrlMasked: 'https://api.example.com/v1/payment/status?api_key=***MASKED***',
  requestHeadersMasked: { authorization: '***MASKED***', 'content-type': 'application/json' },
  requestBodyMasked: '{"reference":"HEALTH-1","pin":"***MASKED***"}',
  responseStatus: 503,
  responseHeadersMasked: { 'content-type': 'application/json' },
  responseBodyMasked: '{"code":"DB_CONNECTION_ERROR"}',
  responseBytes: 30,
  responseContentType: 'application/json',
  responseTimeMs: 2842,
  raw: {
    requestUrl: 'https://api.example.com/v1/payment/status?api_key=sk_live_secret',
    requestHeaders: { authorization: 'Bearer real.token.value' },
    requestBody: '{"reference":"HEALTH-1","pin":"1234"}',
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: '{"code":"DB_CONNECTION_ERROR"}',
  },
});

describe.skipIf(!dbUp)('health_check_traces repo (Phase 12)', () => {
  beforeAll(async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron, allow_private_network)
       VALUES ('trace-t', 'payment_status', 'CRITICAL', 'https://203.0.113.92/x', '*/1 * * * *', true)
       RETURNING id`,
    );
    apiId = rows[0]!.id;
  });
  afterAll(async () => {
    await query(`DELETE FROM monitored_apis`);
    await closePool();
  });
  beforeEach(async () => {
    await query(`DELETE FROM health_check_results WHERE api_id = $1`, [apiId]);
  });

  it('stores the masked trace and an encrypted raw copy; reveal returns the truth', async () => {
    const checkId = await seedCheck('DOWN', 503);
    await insertTrace({
      checkId,
      apiId,
      jobRunId: 'job-1',
      requestId: newRequestId(),
      correlationId: 'job-1',
      checkedAt: new Date(),
      healthStatus: 'DOWN',
      attempts: 2,
      failureType: 'HTTP_5XX',
      trace: trace(),
    });

    const stored = await getTraceByCheckId(checkId);
    expect(stored).not.toBeNull();
    expect(stored!.requestHeadersMasked['authorization']).toBe('***MASKED***');
    expect(stored!.responseStatus).toBe(503);
    expect(stored!.hasRaw).toBe(true);

    // raw column must not contain the plaintext secret
    const rawCol = await query<{ raw_encrypted: unknown }>(
      `SELECT raw_encrypted FROM health_check_traces WHERE check_id = $1`,
      [checkId],
    );
    expect(JSON.stringify(rawCol.rows[0]!.raw_encrypted)).not.toContain('sk_live_secret');

    const revealed = await revealRawTrace(checkId);
    expect(revealed!.requestHeaders['authorization']).toBe('Bearer real.token.value');
  });

  it('searches by status class and failure type', async () => {
    for (const [s, code, ft] of [
      ['DOWN', 503, 'HTTP_5XX'],
      ['DOWN', 401, 'AUTHENTICATION_ERROR'],
      ['UP', 200, null],
    ] as const) {
      const id = await seedCheck(s, code);
      await insertTrace({
        checkId: id,
        apiId,
        jobRunId: null,
        requestId: newRequestId(),
        correlationId: 'c',
        checkedAt: new Date(),
        healthStatus: s,
        attempts: 1,
        failureType: ft,
        trace: { ...trace(), responseStatus: code },
      });
    }

    const fivexx = await searchTraces({ apiId, statusClass: '5xx' });
    expect(fivexx.total).toBe(1);
    expect(fivexx.rows[0]!.responseStatus).toBe(503);

    const auth = await searchTraces({ apiId, failureType: 'AUTHENTICATION_ERROR' });
    expect(auth.total).toBe(1);
  });

  it('prunes old traces', async () => {
    const id = await seedCheck('UP', 200);
    await insertTrace({
      checkId: id,
      apiId,
      jobRunId: null,
      requestId: newRequestId(),
      correlationId: 'c',
      checkedAt: new Date(),
      healthStatus: 'UP',
      attempts: 1,
      failureType: null,
      trace: trace(),
    });
    await query(
      `UPDATE health_check_traces SET checked_at = now() - interval '40 days' WHERE check_id = $1`,
      [id],
    );
    const deleted = await pruneTraces(30);
    expect(deleted).toBeGreaterThanOrEqual(1);
  });
});
