import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDbHealth, closePool, query } from '../../lib/db.js';
import { rollUpRun } from './health-check-run.service.js';
import { getRunByHcId, runServices } from '../../repositories/health-check-runs.repo.js';

const dbUp = (await checkDbHealth()).ok;

let moneyId: string;
let plainId: string;

async function seedCheck(apiId: string, at: Date, status: string, code: number | null): Promise<void> {
  await query(
    `INSERT INTO health_check_results (api_id, job_run_id, checked_at, status, http_status, response_time_ms)
     VALUES ($1, $2, $3, $4, $5, 120)`,
    [apiId, `${apiId}:${at.toISOString()}:${Math.random()}`, at, status, code],
  );
}

describe.skipIf(!dbUp)('health check run roll-up (Phase 13)', () => {
  beforeAll(async () => {
    const a = await query<{ id: string }>(
      `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron, is_money_moving, allow_private_network, environment)
       VALUES ('hcr-money', 'payment_status', 'CRITICAL', 'https://203.0.113.93/x', '*/1 * * * *', true, true, 'production')
       RETURNING id`,
    );
    moneyId = a.rows[0]!.id;
    const b = await query<{ id: string }>(
      `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron, is_money_moving, allow_private_network, environment)
       VALUES ('hcr-plain', 'reporting', 'LOW', 'https://203.0.113.94/x', '*/1 * * * *', false, true, 'production')
       RETURNING id`,
    );
    plainId = b.rows[0]!.id;
  });
  afterAll(async () => {
    await query(`DELETE FROM monitored_apis`);
    await closePool();
  });
  beforeEach(async () => {
    await query(`DELETE FROM health_check_runs`);
    await query(`DELETE FROM health_check_results WHERE api_id = ANY($1)`, [[moneyId, plainId]]);
  });

  it('rolls the window into one HC-ID record, links the checks, and reports counts', async () => {
    const now = new Date();
    const t = (mins: number): Date => new Date(now.getTime() - mins * 60_000);
    await seedCheck(moneyId, t(4), 'UP', 200);
    await seedCheck(moneyId, t(1), 'UP', 200); // latest for money = UP
    await seedCheck(plainId, t(3), 'UP', 200);
    await seedCheck(plainId, t(1), 'DEGRADED', 200); // latest for plain = DEGRADED

    const run = await rollUpRun(now);
    expect(run).not.toBeNull();
    expect(run!.hcId).toMatch(/^HC-\d{8}-\d{6}-\d{6}$/);
    expect(run!.servicesTested).toBe(2);
    expect(run!.healthy).toBe(1);
    expect(run!.degraded).toBe(1);
    expect(run!.overallStatus).toBe('DEGRADED');
    expect(run!.checksTotal).toBe(4);
    expect(run!.environment).toBe('production');

    const services = await runServices(run!.id);
    expect(services).toHaveLength(2);

    // every check in the window is now linked
    const linked = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM health_check_results
       WHERE api_id = ANY($1) AND hc_run_id = $2`,
      [[moneyId, plainId], run!.id],
    );
    expect(Number(linked.rows[0]!.n)).toBe(4);
  });

  it('escalates to CRITICAL when a money-moving service is DOWN', async () => {
    const now = new Date();
    await seedCheck(moneyId, new Date(now.getTime() - 60_000), 'DOWN', 503);
    await seedCheck(plainId, new Date(now.getTime() - 60_000), 'UP', 200);

    const run = await rollUpRun(now);
    expect(run!.overallStatus).toBe('CRITICAL');
    expect(run!.failed).toBe(1);
  });

  it('returns null for an empty window and does not create a run', async () => {
    const run = await rollUpRun(new Date());
    expect(run).toBeNull();
    const any = await getRunByHcId('HC-20260101-000000-000001');
    expect(any).toBeNull();
  });

  it('sequential runs cover disjoint windows', async () => {
    const now = new Date();
    await seedCheck(moneyId, new Date(now.getTime() - 60_000), 'UP', 200);
    await seedCheck(plainId, new Date(now.getTime() - 60_000), 'UP', 200);
    const first = await rollUpRun(now);
    expect(first!.overallStatus).toBe('HEALTHY');

    // a later check, later roll-up
    const later = new Date(now.getTime() + 60_000);
    await seedCheck(moneyId, new Date(now.getTime() + 30_000), 'UP', 200);
    const second = await rollUpRun(later);
    expect(second).not.toBeNull();
    expect(new Date(second!.windowStart).getTime()).toBe(new Date(first!.windowEnd).getTime());
  });
});
