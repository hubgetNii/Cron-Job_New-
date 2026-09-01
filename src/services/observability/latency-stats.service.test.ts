import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDbHealth, closePool, query } from '../../lib/db.js';
import { allLatencyStats, latencyStats } from './latency-stats.service.js';
import { upsertThresholds } from '../../repositories/latency-thresholds.repo.js';

const dbUp = (await checkDbHealth()).ok;

let apiId: string;

async function seed(at: Date, ms: number, status = 'UP'): Promise<void> {
  await query(
    `INSERT INTO health_check_results (api_id, job_run_id, checked_at, status, http_status, response_time_ms)
     VALUES ($1, $2, $3, $4, 200, $5)`,
    [apiId, `${apiId}:${at.toISOString()}:${Math.random()}`, at, status, ms],
  );
}

describe.skipIf(!dbUp)('latency intelligence (Phase 14)', () => {
  beforeAll(async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron, allow_private_network)
       VALUES ('lat-t', 'payment_status', 'CRITICAL', 'https://203.0.113.95/x', '*/1 * * * *', true)
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
    await query(`DELETE FROM latency_thresholds WHERE api_id = $1`, [apiId]);
  });

  it('computes percentiles, current, deviation vs baseline and an assessment', async () => {
    const now = Date.now();
    // baseline: ~420ms average over the last few days (outside the 60-min window)
    for (let i = 0; i < 60; i += 1) {
      await seed(new Date(now - (2 * 86_400_000 + i * 60_000)), 400 + (i % 40));
    }
    // current window: a clear regression — mostly ~2800ms
    for (let i = 0; i < 20; i += 1) await seed(new Date(now - (i + 1) * 60_000), 2700 + i * 10);

    const s = await latencyStats(apiId, 60);
    expect(s.window.samples).toBe(20);
    expect(s.current).toBeGreaterThan(2500);
    expect(s.p95).toBeGreaterThan(s.p50!);
    expect(s.baseline.avgMs).toBeGreaterThan(390);
    expect(s.baseline.avgMs).toBeLessThan(460);
    expect(s.deviationPercent).toBeGreaterThan(400); // ~+570%
    expect(s.thresholds.source).toBe('default');
    expect(s.assessment).toBe('CRITICAL'); // payment_status critical band is 1500ms
  });

  it('honours a custom threshold row', async () => {
    const now = Date.now();
    for (let i = 0; i < 10; i += 1) await seed(new Date(now - (i + 1) * 60_000), 600);
    await upsertThresholds(apiId, { normalMs: 2000, degradedMs: 4000, criticalMs: 8000 }, null);

    const s = await latencyStats(apiId, 60);
    expect(s.thresholds.source).toBe('custom');
    expect(s.assessment).toBe('NORMAL'); // 600ms < 2000ms custom normal band
  });

  it('reports NO_DATA when the window is empty', async () => {
    const s = await latencyStats(apiId, 60);
    expect(s.assessment).toBe('NO_DATA');
    expect(s.p95).toBeNull();
  });

  it('allLatencyStats sorts worst assessment first', async () => {
    const now = Date.now();
    for (let i = 0; i < 10; i += 1) await seed(new Date(now - (i + 1) * 60_000), 3000);
    const all = await allLatencyStats(60);
    const mine = all.find((x) => x.apiId === apiId);
    expect(mine).toBeDefined();
    expect(all[0]!.assessment === 'CRITICAL' || all[0]!.assessment === 'HIGH').toBe(true);
  });
});
