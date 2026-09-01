import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDbHealth, closePool, query } from '../../lib/db.js';
import { serviceHealthScore } from './health-score.service.js';

const dbUp = (await checkDbHealth()).ok;

let apiId: string;

async function seed(at: Date, status: string, ms: number | null): Promise<void> {
  await query(
    `INSERT INTO health_check_results (api_id, job_run_id, checked_at, status, http_status, response_time_ms)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [apiId, `${apiId}:${at.toISOString()}:${Math.random()}`, at, status, status === 'DOWN' ? 503 : 200, ms],
  );
}

describe.skipIf(!dbUp)('service health score (Phase 17)', () => {
  beforeAll(async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron, sla_target_percent, allow_private_network)
       VALUES ('hs-t', 'payment_status', 'CRITICAL', 'https://203.0.113.96/x', '*/1 * * * *', 99.9, true)
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

  it('scores a healthy fast service high', async () => {
    const now = Date.now();
    for (let i = 0; i < 100; i += 1) await seed(new Date(now - i * 12 * 60_000), 'UP', 200);

    const s = await serviceHealthScore(apiId, 24);
    expect(s.score).toBeGreaterThan(90);
    expect(s.band).toBe('HEALTHY');
    expect(s.subScores.availability).toBeGreaterThan(95);
    expect(s.subScores.latency).toBe(100);
  });

  it('drops the score for a slow, error-prone service and reports the yesterday delta', async () => {
    const now = Date.now();
    // today window: ~10% DOWN, slow (~2500ms)
    for (let i = 0; i < 100; i += 1) {
      const down = i % 10 === 0;
      await seed(new Date(now - i * 12 * 60_000), down ? 'DOWN' : 'UP', down ? null : 2500);
    }
    // same window yesterday: fast + clean
    for (let i = 0; i < 60; i += 1) {
      await seed(new Date(now - 86_400_000 - i * 12 * 60_000), 'UP', 400);
    }

    const s = await serviceHealthScore(apiId, 24);
    expect(s.score).toBeLessThan(75);
    expect(s.subScores.errorRate).toBeLessThan(60);
    expect(s.comparison.latency.deltaPercent).toBeGreaterThan(200); // ~2500 vs ~400
  });

  it('renders an occurrence note when incidents recur in 24h', async () => {
    const now = Date.now();
    for (let i = 0; i < 30; i += 1) await seed(new Date(now - i * 12 * 60_000), 'UP', 300);
    for (const h of [1, 5]) {
      await query(
        `INSERT INTO incidents (api_id, incident_number, incident_type, severity, endpoint_class_snapshot,
           is_money_moving_snapshot, status, started_at, resolved_at, failure_type)
         VALUES ($1, $2, 'OUTAGE', 'CRITICAL', 'payment_status', true, 'RESOLVED',
                 now() - ($3 || ' hours')::interval, now() - ($3 || ' hours')::interval + interval '5 min', 'HTTP_5XX')`,
        [apiId, `INC-HS-${h}-${Math.random().toString(36).slice(2, 6)}`, String(h)],
      );
    }
    const s = await serviceHealthScore(apiId, 24);
    expect(s.comparison.recurrence.count24h).toBe(2);
    expect(s.comparison.recurrence.note).toMatch(/2nd incident/);
  });
});
