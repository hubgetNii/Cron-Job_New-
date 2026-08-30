import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDbHealth, closePool, query } from '../../lib/db.js';
import { computeSla, runSlaReports } from './sla.service.js';
import { slaSummary, reportsForTarget } from '../../repositories/sla-reports.repo.js';

const dbUp = (await checkDbHealth()).ok;

let apiId: string;

/** Seed `n` checks evenly across [from, to); every `downEvery`-th one is DOWN. */
async function seedChecks(from: Date, to: Date, n: number, downEvery: number): Promise<void> {
  const step = (to.getTime() - from.getTime()) / n;
  for (let i = 0; i < n; i += 1) {
    const at = new Date(from.getTime() + i * step);
    const down = downEvery > 0 && i % downEvery === 0;
    await query(
      `INSERT INTO health_check_results (api_id, job_run_id, checked_at, status, http_status, response_time_ms)
       VALUES ($1, $2, $3, $4, $5, 50)`,
      [apiId, `${apiId}:${at.toISOString()}`, at, down ? 'DOWN' : 'UP', down ? 503 : 200],
    );
  }
}

describe.skipIf(!dbUp)('SLA reporting (Phase 11)', () => {
  beforeAll(async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron, sla_target_percent, is_money_moving, allow_private_network)
       VALUES ('sla-t', 'payment_status', 'CRITICAL', 'https://203.0.113.90/x', '*/1 * * * *', 99.0, true, true)
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
    await query(`DELETE FROM sla_reports WHERE api_id = $1`, [apiId]);
    await query(`DELETE FROM maintenance_windows WHERE target_id = $1`, [apiId]);
  });

  it('computes count-based uptime over a window', async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
    await seedChecks(from, to, 100, 10); // 10 of 100 DOWN → 90% uptime

    const r = await computeSla(apiId, from, to, 99.0);
    expect(r.uptimePercent).toBeCloseTo(90, 5);
    expect(r.slaMet).toBe(false);
    expect(r.totalChecks).toBe(100);
    expect(r.failedChecks).toBe(10);
    expect(r.downtimeSeconds).toBeGreaterThan(0);
  });

  it('excludes maintenance-window downtime from the SLA-breach math but still records it', async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
    // Every check in the first half is DOWN; second half all UP.
    const mid = new Date((from.getTime() + to.getTime()) / 2);
    await seedChecks(from, mid, 50, 1); // 50 DOWN
    await seedChecks(mid, to, 50, 0); // 50 UP

    // Cover the whole failing first half with an approved maintenance window.
    await query(
      `INSERT INTO maintenance_windows (target_id, starts_at, ends_at, reason)
       VALUES ($1, $2, $3, 'planned migration')`,
      [apiId, from, mid],
    );

    const r = await computeSla(apiId, from, to, 99.0);
    // All 50 failures are inside maintenance → SLA sees only the 50 clean checks.
    expect(r.uptimePercent).toBeCloseTo(100, 5);
    expect(r.slaMet).toBe(true);
    // ...but the downtime is still on the record.
    expect(r.failedChecks).toBe(50);
    expect(r.excludedSeconds).toBeGreaterThan(0);
  });

  it('runSlaReports upserts one rolling + one monthly row per target, idempotently', async () => {
    const now = new Date();
    await seedChecks(new Date(now.getTime() - 10 * 24 * 3600 * 1000), now, 200, 50);

    await runSlaReports(now);
    await runSlaReports(now); // second run must not duplicate

    const reports = await reportsForTarget(apiId);
    const kinds = reports.map((r) => r.periodKind).sort();
    expect(kinds).toEqual(['calendar_month', 'rolling_30d']);

    const summary = await slaSummary();
    const mine = summary.find((s) => s.apiId === apiId);
    expect(mine).toBeDefined();
    expect(mine!.uptimePercent).not.toBeNull();
  });

  it('reports 100% / met when there is no data yet', async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 3600 * 1000);
    const r = await computeSla(apiId, from, to, 99.95);
    expect(r.uptimePercent).toBeNull();
    expect(r.slaMet).toBe(true);
    expect(r.downtimeSeconds).toBe(0);
  });
});
