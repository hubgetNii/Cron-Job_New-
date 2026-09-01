import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDbHealth, closePool, query } from '../../lib/db.js';
import { buildReport, reportToCsv } from './reports.service.js';

const dbUp = (await checkDbHealth()).ok;

let apiId: string;

async function seedCheck(at: Date, status: string, ms: number | null, errType?: string): Promise<void> {
  await query(
    `INSERT INTO health_check_results (api_id, job_run_id, checked_at, status, http_status, response_time_ms, error_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [apiId, `${apiId}:${at.toISOString()}:${Math.random()}`, at, status, status === 'DOWN' ? 503 : 200, ms, errType ?? null],
  );
}

describe.skipIf(!dbUp)('advanced reports (Phase 18)', () => {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 86_400_000);

  beforeAll(async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron, is_money_moving, allow_private_network)
       VALUES ('rep-t', 'payment_status', 'CRITICAL', 'https://203.0.113.97/x', '*/1 * * * *', true, true)
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

  it('api-performance report has per-target uptime + latency', async () => {
    const now = Date.now();
    for (let i = 0; i < 100; i += 1) {
      const down = i % 20 === 0;
      await seedCheck(new Date(now - i * 3_600_000), down ? 'DOWN' : 'UP', down ? null : 300, down ? 'HTTP_5XX' : undefined);
    }
    const r = await buildReport('api-performance', from, to);
    const data = r.data as Array<{ targetName: string; uptimePercent: number; p95Ms: number; errorRatePct: number }>;
    const mine = data.find((d) => d.targetName === 'rep-t')!;
    expect(mine.errorRatePct).toBeGreaterThan(0);
    expect(mine.p95Ms).toBeGreaterThan(0);
    expect(reportToCsv(r)).toContain('targetName');
  });

  it('failure report groups by taxonomy category', async () => {
    const now = Date.now();
    for (let i = 0; i < 10; i += 1) await seedCheck(new Date(now - i * 3_600_000), 'DOWN', null, 'AUTHENTICATION_ERROR');
    for (let i = 0; i < 5; i += 1) await seedCheck(new Date(now - i * 3_600_000), 'DOWN', null, 'DNS_ERROR');

    const r = await buildReport('failure', from, to);
    const d = r.data as { byCategory: Array<{ category: string; count: number }> };
    const cats = d.byCategory.map((c) => c.category);
    expect(cats).toContain('AUTHENTICATION');
    expect(cats).toContain('CONNECTIVITY');
  });

  it('executive report gives a plain-language status', async () => {
    const now = Date.now();
    for (let i = 0; i < 50; i += 1) await seedCheck(new Date(now - i * 3_600_000), 'UP', 250);
    const r = await buildReport('executive', from, to);
    const d = r.data as { headline: { status: string; platformAvailabilityPercent: number | null } };
    expect(typeof d.headline.status).toBe('string');
    expect(d.headline.platformAvailabilityPercent).toBeGreaterThan(90);
  });

  it('every report type builds without error', async () => {
    for (const t of [
      'system-health',
      'api-performance',
      'failure',
      'incident',
      'dependency',
      'latency',
      'security',
      'executive',
    ] as const) {
      const r = await buildReport(t, from, to);
      expect(r.type).toBe(t);
      expect(r.period.from).toBeTruthy();
    }
  });
});
