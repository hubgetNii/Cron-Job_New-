import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDbHealth, closePool, query } from '../../lib/db.js';
import { buildRootCauseAnalysis, getStoredRca } from './rca.service.js';

const dbUp = (await checkDbHealth()).ok;

let apiId: string;

async function seedIncident(opts: {
  failureType: string | null;
  moneyMoving?: boolean;
  endpointClass?: string;
  startedAt?: Date;
  resolved?: boolean;
}): Promise<string> {
  const startedAt = opts.startedAt ?? new Date(Date.now() - 20 * 60_000);
  const resolvedAt = opts.resolved ? new Date(startedAt.getTime() + 60_000) : null;
  const { rows } = await query<{ id: string }>(
    `INSERT INTO incidents
       (api_id, incident_number, incident_type, severity, endpoint_class_snapshot,
        is_money_moving_snapshot, status, started_at, resolved_at, failure_count, failure_type)
     VALUES ($1, $2, 'OUTAGE', 'CRITICAL', $3, $4, $7, $5, $8, 3, $6)
     RETURNING id`,
    [
      apiId,
      `INC-TEST-${Math.random().toString(36).slice(2, 8)}`,
      opts.endpointClass ?? 'payment_status',
      opts.moneyMoving ?? false,
      startedAt,
      opts.failureType,
      opts.resolved ? 'RESOLVED' : 'OPEN',
      resolvedAt,
    ],
  );
  return rows[0]!.id;
}

async function seedCheck(at: Date, status: string, httpStatus: number | null, ms: number, errorType?: string, errorMessage?: string): Promise<void> {
  await query(
    `INSERT INTO health_check_results (api_id, job_run_id, checked_at, status, http_status, response_time_ms, error_type, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [apiId, `${apiId}:${at.toISOString()}:${Math.random()}`, at, status, httpStatus, ms, errorType ?? null, errorMessage ?? null],
  );
}

describe.skipIf(!dbUp)('deterministic RCA (Phase 15)', () => {
  beforeAll(async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron, is_money_moving, allow_private_network)
       VALUES ('rca-t', 'payment_status', 'CRITICAL', 'https://203.0.113.91/x', '*/1 * * * *', true, true)
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
    await query(`DELETE FROM incidents WHERE api_id = $1`, [apiId]);
  });

  it('classifies a 503 outage as a DEPENDENCY failure with a recommendation and impact', async () => {
    const start = new Date(Date.now() - 15 * 60_000);
    // healthy baseline, then failures
    await seedCheck(new Date(start.getTime() - 10 * 60_000), 'UP', 200, 120);
    await seedCheck(new Date(start.getTime() + 60_000), 'DOWN', 503, 4200, 'HTTP_5XX', 'Unexpected response (HTTP 503)');
    await seedCheck(new Date(start.getTime() + 120_000), 'DOWN', 503, 4800, 'HTTP_5XX', 'Unexpected response (HTTP 503)');
    const incidentId = await seedIncident({ failureType: 'HTTP_5XX', moneyMoving: true, startedAt: start });

    const rca = await buildRootCauseAnalysis(incidentId);

    expect(rca.category).toBe('DEPENDENCY');
    expect(rca.method).toBe('deterministic');
    expect(rca.assistive).toBe(true);
    expect(rca.recommendation.recommendation).toMatch(/gateway|upstream|availability/i);
    expect(rca.impact).toMatch(/money-moving/i);
    expect(rca.evidence.some((e) => e.includes('503'))).toBe(true);
    expect(rca.latency).not.toBeNull();
    expect(rca.latency!.ratio).toBeGreaterThan(1);

    // persisted
    const stored = await getStoredRca(incidentId);
    expect(stored?.category).toBe('DEPENDENCY');
  });

  it('classifies an auth failure and counts recurrences in 24h', async () => {
    const start = new Date(Date.now() - 10 * 60_000);
    await seedCheck(new Date(start.getTime() + 60_000), 'DOWN', 401, 90, 'AUTHENTICATION_ERROR', 'token has expired');
    // an earlier incident with the same signature today
    await seedIncident({
      failureType: 'AUTHENTICATION_ERROR',
      startedAt: new Date(Date.now() - 5 * 3600_000),
      resolved: true,
    });
    const incidentId = await seedIncident({ failureType: 'AUTHENTICATION_ERROR', startedAt: start });

    const rca = await buildRootCauseAnalysis(incidentId);
    expect(rca.category).toBe('AUTHENTICATION');
    expect(rca.occurrences24h).toBeGreaterThanOrEqual(2);
    expect(rca.recommendation.recommendation).toMatch(/recurred within 24h|occurrence #/i);
  });
});
