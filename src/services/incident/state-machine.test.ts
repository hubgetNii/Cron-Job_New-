import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDbHealth, closePool, query, withTransaction } from '../../lib/db.js';
import { makeMonitoredApi } from '../../tests/fixtures.js';
import type { MonitoredApi } from '../../domain/target.js';
import type { CheckFailureType, HealthStatus } from '../../domain/enums.js';
import type { HealthCheckOutcome } from '../../domain/health-check.js';
import { insertHealthCheckResult, recordRunOutcome } from '../../repositories/scheduler.repo.js';
import { findActiveIncident, listIncidents } from '../../repositories/incidents.repo.js';
import { processCheckOutcome, type IncidentTransition } from './state-machine.service.js';

const dbUp = (await checkDbHealth()).ok;

let target: MonitoredApi;
let slotCounter = 0;

const runStart = Date.now();

function outcome(
  status: HealthStatus,
  failureType: CheckFailureType | null,
  checkedAt: Date,
): HealthCheckOutcome {
  return {
    status,
    httpStatus: status === 'UP' ? 200 : status === 'DOWN' ? 503 : 200,
    responseTimeMs: 20,
    failureType,
    errorMessage: null,
    validation: null,
    attempts: 1,
    responseSample: null,
    checkedAt,
  };
}

/** Mirrors the job runner's success transaction for one check. */
async function runCheck(
  status: HealthStatus,
  failureType: CheckFailureType | null = status === 'DOWN' ? 'HTTP_5XX' : null,
): Promise<IncidentTransition> {
  slotCounter += 1;
  const slot = new Date(Date.UTC(2026, 0, 1, 0, slotCounter, 0));
  // Recent (inside the flapping window) and strictly ordered, so
  // countStatusTransitions walks the results in the order they happened.
  const checkedAt = new Date(runStart + slotCounter * 1000);
  const o = outcome(status, failureType, checkedAt);
  return withTransaction(async (client) => {
    const checkId = await insertHealthCheckResult(
      { apiId: target.id, jobRunId: `${target.id}:${slotCounter}`, outcome: o },
      client,
    );
    const counters = await recordRunOutcome(
      { targetId: target.id, scheduledSlot: slot, status },
      client,
    );
    return processCheckOutcome(
      {
        target,
        status,
        failureType,
        checkId,
        consecutiveSuccesses: counters.consecutiveSuccesses,
      },
      client,
    );
  });
}

describe.skipIf(!dbUp)('incident state machine (Phase 6)', () => {
  beforeAll(async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron, is_money_moving, allow_private_network)
       VALUES ('inc-sm', 'payment_status', 'CRITICAL', 'https://203.0.113.60/x', '*/1 * * * *', false, true)
       RETURNING id`,
    );
    target = makeMonitoredApi({
      id: rows[0]!.id,
      severityDefault: 'CRITICAL',
      endpointClass: 'payment_status',
    });
  });
  afterAll(async () => {
    await query(`DELETE FROM monitored_apis`);
    await closePool();
  });
  beforeEach(async () => {
    await query(`DELETE FROM alerts`);
    await query(`DELETE FROM incidents`);
    await query(`DELETE FROM health_check_results`);
    await query(
      `UPDATE target_schedule_state SET consecutive_successes = 0, consecutive_failures = 0 WHERE target_id = $1`,
      [target.id],
    );
    slotCounter = 0;
  });

  it('opens an OUTAGE incident on the first DOWN and alerts', async () => {
    const t = await runCheck('DOWN');
    expect(t.kind).toBe('opened');

    const active = await findActiveIncident(target.id);
    expect(active?.incidentType).toBe('OUTAGE');
    expect(active?.severity).toBe('CRITICAL');
    expect(active?.status).toBe('OPEN');

    const alerts = await query(
      `SELECT 1 FROM alerts WHERE api_id = $1 AND alert_type = 'API_DOWN'`,
      [target.id],
    );
    expect(alerts.rowCount).toBe(1);
  });

  it('increments failure_count without opening a second incident', async () => {
    await runCheck('DOWN');
    await runCheck('DOWN');
    await runCheck('DOWN');
    const list = await listIncidents({ apiId: target.id });
    expect(list).toHaveLength(1);
    expect(list[0]!.failureCount).toBe(3);
  });

  it('auto-resolves only after the recovery streak (default 2 clean UP)', async () => {
    await runCheck('DOWN');
    const afterOne = await runCheck('UP');
    expect(afterOne.kind).toBe('noop');
    expect((await findActiveIncident(target.id))?.status).toBe('OPEN');

    const afterTwo = await runCheck('UP');
    expect(afterTwo.kind).toBe('resolved');
    expect(await findActiveIncident(target.id)).toBeNull();

    const resolved = (await listIncidents({ apiId: target.id }))[0]!;
    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.durationSeconds).not.toBeNull();

    const recovered = await query(
      `SELECT 1 FROM alerts WHERE api_id = $1 AND alert_type = 'API_RECOVERED'`,
      [target.id],
    );
    expect(recovered.rowCount).toBe(1);
  });

  it('opens a lower-severity DEGRADATION incident, then promotes it on a DOWN', async () => {
    const degraded = await runCheck('DEGRADED');
    expect(degraded.kind).toBe('opened');
    let active = await findActiveIncident(target.id);
    expect(active?.incidentType).toBe('DEGRADATION');
    expect(active?.severity).toBe('HIGH'); // one below CRITICAL

    await runCheck('DOWN');
    active = await findActiveIncident(target.id);
    expect(active?.incidentType).toBe('OUTAGE');
    expect(active?.severity).toBe('CRITICAL');
  });

  it('does not auto-close a money-moving incident on a single success (Rule 18)', async () => {
    await query(`UPDATE monitored_apis SET is_money_moving = true WHERE id = $1`, [target.id]);
    const mm = makeMonitoredApi({ ...target, isMoneyMoving: true });
    const saved = target;
    target = mm;
    try {
      await runCheck('DOWN');
      const afterOne = await runCheck('UP');
      expect(afterOne.kind).toBe('noop');
      expect((await findActiveIncident(target.id))?.status).toBe('OPEN');
    } finally {
      target = saved;
      await query(`UPDATE monitored_apis SET is_money_moving = false WHERE id = $1`, [saved.id]);
    }
  });

  it('surfaces rapid oscillation as a FLAPPING incident, not an alert storm (Rule 23)', async () => {
    // 5 alternations inside the flapping window (default: 4 in 10 minutes).
    await runCheck('DOWN');
    await runCheck('UP');
    await runCheck('DOWN');
    await runCheck('UP');
    await runCheck('DOWN');
    const t = await runCheck('UP');
    // Whatever the final transition, the active/most-recent incident is FLAPPING.
    const list = await listIncidents({ apiId: target.id });
    expect(list.some((i) => i.incidentType === 'FLAPPING')).toBe(true);
    expect(['flapping_detected', 'resolved', 'noop']).toContain(t.kind);

    const flapAlert = await query(
      `SELECT 1 FROM alerts WHERE api_id = $1 AND alert_type = 'FLAPPING_DETECTED'`,
      [target.id],
    );
    expect(flapAlert.rowCount).toBe(1);
  });

  it('UNKNOWN never opens or closes an incident', async () => {
    expect((await runCheck('UNKNOWN', 'RATE_LIMITED')).kind).toBe('noop');
    expect(await findActiveIncident(target.id)).toBeNull();

    await runCheck('DOWN');
    expect((await runCheck('UNKNOWN', 'RATE_LIMITED')).kind).toBe('noop');
    expect((await findActiveIncident(target.id))?.status).toBe('OPEN');
  });
});
