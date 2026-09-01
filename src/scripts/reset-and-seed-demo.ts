import 'dotenv/config';
import { query, withTransaction, closePool } from '../lib/db.js';
import { isProduction } from '../config/index.js';
import { runSlaReports } from '../services/reporting/sla.service.js';
import { rollUpRun } from '../services/observability/health-check-run.service.js';

/* eslint-disable no-console */

/**
 * DEV/DEMO ONLY. Wipes all operational history (health checks, traces, runs,
 * incidents, alerts, SLA reports, digests, AI insights, scheduler runtime) while
 * keeping identity + configuration (users, teams, targets, contacts, escalation
 * policies, maintenance windows, audit log).
 *
 * Then backfills ~48h of synthetic health-check history for every active target,
 * tuned so overall uptime lands around 98% — money-moving endpoints a little
 * better, everything else a little worse — so the dashboard, SLA page and
 * Health Check Runs have realistic data immediately.
 *
 *   npm run demo:reset
 */

const HOURS = 48;
const STEP_MIN = 5;

// Per-step failure probability. Actual down-rate ≈ this × ~1.4 (short bursts),
// Exact down-fraction per class; the weighted mean across targets is ~2%.
function downRateFor(isMoneyMoving: boolean, endpointClass: string): number {
  if (isMoneyMoving || endpointClass === 'payment_status') return 0.008;
  if (endpointClass === 'reporting' || endpointClass === 'internal') return 0.03;
  return 0.019;
}

function latencyFor(isMoneyMoving: boolean): number {
  const base = isMoneyMoving ? 180 : 320;
  const jitter = Math.round((Math.random() - 0.3) * base);
  return Math.max(40, base + jitter);
}

interface Row {
  id: string;
  name: string;
  is_money_moving: boolean;
  endpoint_class: string;
}

async function wipe(): Promise<void> {
  await withTransaction(async (c) => {
    await c.query(`
      TRUNCATE
        health_check_traces,
        health_check_runs,
        health_check_results,
        cron_job_runs,
        job_locks,
        target_schedule_state,
        scheduler_heartbeats,
        alerts,
        incidents,
        sla_reports,
        ai_insights,
        health_digests
      RESTART IDENTITY CASCADE
    `);
    await c.query(`ALTER SEQUENCE IF EXISTS incident_number_seq RESTART WITH 1`);
    await c.query(`ALTER SEQUENCE IF EXISTS health_check_run_seq RESTART WITH 1`);
  });
  console.log('  ✓ wiped operational history (kept users, targets, contacts, audit log)');
}

async function backfill(targets: Row[], now: Date): Promise<number> {
  const start = new Date(now.getTime() - HOURS * 3_600_000);
  const stepMs = STEP_MIN * 60_000;
  let inserted = 0;

  for (const t of targets) {
    const slots = Math.floor((now.getTime() - start.getTime()) / stepMs);
    // Exact number of DOWN checks, placed as a few short outage bursts.
    const downTotal = Math.round(slots * downRateFor(t.is_money_moving, t.endpoint_class));
    const down = new Set<number>();
    // Stratified: spread the outage bursts evenly across the timeline so any
    // sub-window (last 24h, last 7d) sees roughly the same rate.
    const bursts = Math.max(1, Math.round(downTotal / 2));
    const segment = slots / bursts;
    for (let s = 0; s < bursts && down.size < downTotal; s += 1) {
      const len = 1 + Math.floor(Math.random() * 3); // 1–3 consecutive
      const at = Math.floor(s * segment + Math.random() * Math.max(1, segment - len));
      for (let k = 0; k < len && down.size < downTotal; k += 1) down.add(at + k);
    }
    // top up if rounding left us short
    let cursor = 0;
    while (down.size < downTotal && cursor < slots) {
      if (!down.has(cursor)) down.add(cursor);
      cursor += Math.max(1, Math.floor(slots / downTotal));
    }

    const tuples: unknown[][] = [];
    for (let i = 0; i < slots; i += 1) {
      const at = start.getTime() + i * stepMs;
      const isDown = down.has(i);
      const degraded = !isDown && Math.random() < 0.03;
      const status = isDown ? 'DOWN' : degraded ? 'DEGRADED' : 'UP';
      const http = isDown ? (Math.random() < 0.5 ? 503 : 500) : 200;
      const ms = isDown
        ? null
        : degraded
          ? latencyFor(t.is_money_moving) * 3
          : latencyFor(t.is_money_moving);
      const errType = isDown ? 'HTTP_5XX' : null;
      tuples.push([t.id, `${t.id}:${at}`, new Date(at).toISOString(), status, http, ms, errType]);
    }

    const CHUNK = 400;
    for (let i = 0; i < tuples.length; i += CHUNK) {
      const chunk = tuples.slice(i, i + CHUNK);
      const params: unknown[] = [];
      const rows = chunk.map((tuple) => {
        const b = params.length;
        params.push(...tuple);
        return `($${b + 1},$${b + 2},$${b + 3}::timestamptz,$${b + 4}::health_status,$${b + 5}::int,$${b + 6}::int,$${b + 7}::check_failure_type)`;
      });
      await query(
        `INSERT INTO health_check_results
           (api_id, job_run_id, checked_at, status, http_status, response_time_ms, error_type)
         VALUES ${rows.join(',')}`,
        params,
      );
      inserted += chunk.length;
    }
  }
  return inserted;
}

async function main(): Promise<void> {
  if (isProduction()) {
    console.error('Refusing to run in production.');
    process.exit(1);
  }

  const { rows } = await query<Row>(
    `SELECT id, name, is_money_moving, endpoint_class
     FROM monitored_apis WHERE is_active = true ORDER BY name`,
  );
  if (rows.length === 0) {
    console.error('No active targets — register some first, then re-run.');
    process.exit(1);
  }

  console.log(`Reset + demo seed for ${rows.length} active target(s):`);
  for (const r of rows) console.log(`  · ${r.name}${r.is_money_moving ? ' (money-moving)' : ''}`);

  await wipe();

  const now = new Date();
  const inserted = await backfill(rows, now);
  console.log(`  ✓ inserted ${inserted} synthetic checks over the last ${HOURS}h`);

  // Roll up the last ~2h into Health Check Run records.
  for (let i = 24; i >= 1; i -= 1) {
    await rollUpRun(new Date(now.getTime() - i * STEP_MIN * 60_000));
  }
  await rollUpRun(now);
  console.log('  ✓ rolled recent windows into Health Check Run records');

  const sla = await runSlaReports(now);
  console.log(`  ✓ refreshed SLA reports for ${sla.targets} target(s)`);

  const { rows: summary } = await query<{ up: string; total: string }>(
    `SELECT count(*) FILTER (WHERE status IN ('UP','DEGRADED'))::text AS up, count(*)::text AS total
     FROM health_check_results`,
  );
  const pct = (Number(summary[0]!.up) / Number(summary[0]!.total)) * 100;
  console.log(`\nOverall uptime now: ${pct.toFixed(2)}%  (${summary[0]!.up}/${summary[0]!.total} checks)`);

  await closePool();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
