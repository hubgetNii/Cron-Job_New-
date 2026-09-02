import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDbHealth, closePool, query } from '../../lib/db.js';
import { resetEnvCache } from '../../config/index.js';
import { retentionStatus, runRetention } from './retention.service.js';

const dbUp = (await checkDbHealth()).ok;

let apiId: string;

describe.skipIf(!dbUp)('data retention (Phase 20)', () => {
  beforeAll(async () => {
    process.env['RETENTION_HEALTH_CHECK_DAYS'] = '30';
    process.env['RETENTION_HEARTBEAT_DAYS'] = '3';
    resetEnvCache();
    const { rows } = await query<{ id: string }>(
      `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron, allow_private_network)
       VALUES ('ret-t', 'reporting', 'LOW', 'https://203.0.113.98/x', '*/1 * * * *', true)
       RETURNING id`,
    );
    apiId = rows[0]!.id;
  });
  afterAll(async () => {
    delete process.env['RETENTION_HEALTH_CHECK_DAYS'];
    delete process.env['RETENTION_HEARTBEAT_DAYS'];
    resetEnvCache();
    await query(`DELETE FROM monitored_apis`);
    await query(`DELETE FROM scheduler_heartbeats`);
    await closePool();
  });
  beforeEach(async () => {
    await query(`DELETE FROM health_check_results WHERE api_id = $1`, [apiId]);
    await query(`DELETE FROM scheduler_heartbeats`);
  });

  it('prunes rows past the window and keeps recent ones', async () => {
    // old + fresh health checks
    for (const [days, tag] of [
      [40, 'old'],
      [1, 'fresh'],
    ] as const) {
      await query(
        `INSERT INTO health_check_results (api_id, job_run_id, checked_at, status, response_time_ms)
         VALUES ($1, $2, now() - ($3 || ' days')::interval, 'UP', 50)`,
        [apiId, `${apiId}:${tag}`, String(days)],
      );
    }
    await query(
      `INSERT INTO scheduler_heartbeats (instance_id, last_tick_at, created_at)
       VALUES ('old', now() - interval '10 days', now() - interval '10 days'),
              ('new', now(), now())`,
    );

    const result = await runRetention();
    const hc = result.pruned.find((p) => p.class === 'health_check_results')!;
    const hb = result.pruned.find((p) => p.class === 'scheduler_heartbeats')!;
    expect(hc.deleted).toBe(1);
    expect(hb.deleted).toBe(1);

    const left = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM health_check_results WHERE api_id = $1`,
      [apiId],
    );
    expect(Number(left.rows[0]!.n)).toBe(1);
  });

  it('never prunes PENDING alerts', async () => {
    // status defaults to PENDING
    await query(
      `INSERT INTO alerts (api_id, alert_type, channel, recipient, created_at)
       VALUES ($1, 'API_DOWN', 'SMS', 'x', now() - interval '400 days')`,
      [apiId],
    );
    const result = await runRetention();
    const a = result.pruned.find((p) => p.class === 'alerts')!;
    expect(a.deleted).toBe(0);
    await query(`DELETE FROM alerts WHERE api_id = $1`, [apiId]);
  });

  it('status lists pruneable + immutable classes', async () => {
    const rows = await retentionStatus();
    const names = rows.map((r) => r.class);
    expect(names).toContain('health_check_results');
    expect(names).toContain('audit_logs');
    const audit = rows.find((r) => r.class === 'audit_logs')!;
    expect(audit.retentionDays).toBeNull(); // never pruned
  });
});
