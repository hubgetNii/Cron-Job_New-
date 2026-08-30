import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDbHealth, closePool, query } from '../../lib/db.js';
import { detectAnomalies, scanAndRecordAnomalies } from './anomaly.service.js';

const dbUp = (await checkDbHealth()).ok;

let apiId: string;

async function seedBaseline(): Promise<void> {
  // 40 healthy checks, 2h–41h ago, ~100ms with small variance (non-zero stddev).
  await query(
    `INSERT INTO health_check_results (api_id, job_run_id, checked_at, status, http_status, response_time_ms)
     SELECT $1::uuid, $1::text || ':b:' || g,
            now() - (g || ' hours')::interval - interval '1 hour',
            'UP', 200, 100 + (g % 5)
     FROM generate_series(1, 40) g`,
    [apiId],
  );
}

async function seedRecent(rows: { ms: number | null; status: string }[]): Promise<void> {
  for (const [i, r] of rows.entries()) {
    await query(
      `INSERT INTO health_check_results (api_id, job_run_id, checked_at, status, http_status, response_time_ms)
       VALUES ($1, $2, now() - ($3 || ' minutes')::interval, $4, $5, $6)`,
      [apiId, `${apiId}:r:${i}`, i + 1, r.status, r.status === 'DOWN' ? 503 : 200, r.ms],
    );
  }
}

describe.skipIf(!dbUp)('anomaly detection (Phase 10)', () => {
  beforeAll(async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron, is_money_moving, allow_private_network, is_active)
       VALUES ('anomaly-t', 'payment_status', 'HIGH', 'https://203.0.113.80/x', '*/1 * * * *', false, true, true)
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
    await query(`DELETE FROM ai_insights WHERE entity_id = $1`, [apiId]);
  });
  afterEach(async () => {
    await query(`DELETE FROM ai_insights WHERE entity_id = $1`, [apiId]);
  });

  it('flags a latency spike against the rolling baseline', async () => {
    await seedBaseline();
    await seedRecent([
      { ms: 6000, status: 'UP' },
      { ms: 6100, status: 'UP' },
      { ms: 5900, status: 'UP' },
      { ms: 6050, status: 'UP' },
    ]);

    const anomalies = await detectAnomalies([apiId]);
    const latency = anomalies.find((a) => a.kind === 'latency');
    expect(latency).toBeDefined();
    expect(latency!.observed).toBeGreaterThan(latency!.baseline);
    expect(latency!.zScore).not.toBeNull();
    expect(latency!.zScore!).toBeGreaterThanOrEqual(3);
  });

  it('does not flag normal recent latency', async () => {
    await seedBaseline();
    await seedRecent([
      { ms: 101, status: 'UP' },
      { ms: 99, status: 'UP' },
      { ms: 100, status: 'UP' },
      { ms: 102, status: 'UP' },
    ]);

    const anomalies = await detectAnomalies([apiId]);
    expect(anomalies.find((a) => a.kind === 'latency')).toBeUndefined();
  });

  it('flags an error-rate spike', async () => {
    await seedBaseline();
    await seedRecent([
      { ms: null, status: 'DOWN' },
      { ms: null, status: 'DOWN' },
      { ms: null, status: 'DOWN' },
      { ms: null, status: 'DOWN' },
      { ms: null, status: 'DOWN' },
      { ms: 100, status: 'UP' },
    ]);

    const anomalies = await detectAnomalies([apiId]);
    const errRate = anomalies.find((a) => a.kind === 'error_rate');
    expect(errRate).toBeDefined();
    expect(errRate!.observed).toBeGreaterThan(50);
  });

  it('does nothing without enough baseline samples', async () => {
    await seedRecent([
      { ms: 9000, status: 'UP' },
      { ms: 9000, status: 'UP' },
      { ms: 9000, status: 'UP' },
    ]);
    const anomalies = await detectAnomalies([apiId]);
    expect(anomalies).toHaveLength(0);
  });

  it('scanAndRecordAnomalies persists a de-duped advisory insight', async () => {
    await seedBaseline();
    await seedRecent([
      { ms: 6000, status: 'UP' },
      { ms: 6100, status: 'UP' },
      { ms: 5900, status: 'UP' },
      { ms: 6050, status: 'UP' },
    ]);

    const first = await scanAndRecordAnomalies();
    expect(first).toBeGreaterThanOrEqual(1);

    const second = await scanAndRecordAnomalies();
    expect(second).toBe(0); // de-duped within the window

    const stored = await query<{ assistive: boolean; model: string; confidence: string | null }>(
      `SELECT assistive, model, confidence FROM ai_insights WHERE entity_id = $1 AND kind = 'latency_anomaly'`,
      [apiId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.assistive).toBe(true);
    expect(stored.rows[0]!.model).toBe('statistical');
    expect(stored.rows[0]!.confidence).toBeNull();
  });
});
