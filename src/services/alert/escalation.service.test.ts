import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDbHealth, closePool, query } from '../../lib/db.js';
import { openIncident, acknowledgeIncident } from '../../repositories/incidents.repo.js';
import { createEscalationPolicy } from '../../repositories/escalation-policies.repo.js';
import { runEscalationCycle } from './escalation.service.js';

const dbUp = (await checkDbHealth()).ok;

let policyId: string;
let targetId: string;
let mmTargetId: string;

const tiers = [
  {
    delayMinutes: 0,
    channel: 'EMAIL' as const,
    recipients: ['oncall'],
    condition: 'always' as const,
  },
  {
    delayMinutes: 5,
    channel: 'SMS' as const,
    recipients: ['oncall', 'lead'],
    condition: 'always' as const,
  },
  {
    delayMinutes: 15,
    channel: 'WEBHOOK' as const,
    recipients: ['bridge'],
    condition: 'always' as const,
  },
  {
    delayMinutes: 30,
    channel: 'SMS' as const,
    recipients: ['exec'],
    condition: 'is_money_moving' as const,
  },
];

async function makeTarget(moneyMoving: boolean): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron, is_money_moving, escalation_policy_id, allow_private_network)
     VALUES ($1, 'payment_status', 'CRITICAL', 'https://203.0.113.70/x', '*/1 * * * *', $2, $3, true)
     RETURNING id`,
    [`esc-${Math.random().toString(36).slice(2)}`, moneyMoving, policyId],
  );
  return rows[0]!.id;
}

async function openFor(
  id: string,
  moneyMoving: boolean,
  startedMinutesAgo: number,
): Promise<string> {
  const inc = await openIncident({
    apiId: id,
    incidentType: 'OUTAGE',
    severity: 'CRITICAL',
    endpointClassSnapshot: 'payment_status',
    isMoneyMovingSnapshot: moneyMoving,
    detectedByCheckId: null,
    failureType: 'HTTP_5XX',
  });
  await query(
    `UPDATE incidents SET started_at = now() - ($2::int * interval '1 minute') WHERE id = $1`,
    [inc.id, startedMinutesAgo],
  );
  return inc.id;
}

async function tierAlerts(incidentId: string): Promise<Array<{ tier: number; channel: string }>> {
  const { rows } = await query<{ escalation_tier: number; channel: string }>(
    `SELECT escalation_tier, channel FROM alerts
     WHERE incident_id = $1 AND alert_type = 'ESCALATION_TRIGGERED'
     ORDER BY escalation_tier, channel`,
    [incidentId],
  );
  return rows.map((r) => ({ tier: r.escalation_tier, channel: r.channel }));
}

describe.skipIf(!dbUp)('escalation engine (Phase 7)', () => {
  beforeAll(async () => {
    const policy = await createEscalationPolicy({ name: `esc-test-${Date.now()}`, tiers });
    policyId = policy.id;
    targetId = await makeTarget(false);
    mmTargetId = await makeTarget(true);
  });
  afterAll(async () => {
    await query(`DELETE FROM alerts`);
    await query(`DELETE FROM incidents`);
    await query(`DELETE FROM monitored_apis`);
    await query(`DELETE FROM escalation_policies`);
    await closePool();
  });
  beforeEach(async () => {
    await query(`DELETE FROM alerts`);
    await query(`DELETE FROM incidents`);
  });

  it('fires one due tier per cycle', async () => {
    const incidentId = await openFor(targetId, false, 0);

    await runEscalationCycle(); // tier 0 (delay 0) is due
    expect(await tierAlerts(incidentId)).toEqual([{ tier: 0, channel: 'EMAIL' }]);

    await runEscalationCycle(); // tier 1 not due yet (5 min)
    expect((await tierAlerts(incidentId)).map((a) => a.tier)).toEqual([0]);
  });

  it('advances tiers as their delay elapses', async () => {
    const incidentId = await openFor(targetId, false, 20); // 20 minutes in

    await runEscalationCycle(); // tier 0
    await runEscalationCycle(); // tier 1 (>=5m)
    await runEscalationCycle(); // tier 2 (>=15m)
    const fired = await tierAlerts(incidentId);
    expect(fired.map((a) => a.tier).sort()).toEqual([0, 1, 1, 2]); // tier 1 has 2 recipients
    expect(fired.filter((a) => a.tier === 1).map((a) => a.channel)).toEqual(['SMS', 'SMS']);
  });

  it('stops escalating once acknowledged', async () => {
    const incidentId = await openFor(targetId, false, 20);
    await runEscalationCycle(); // tier 0
    await acknowledgeIncident(incidentId, null);

    await runEscalationCycle();
    await runEscalationCycle();
    expect((await tierAlerts(incidentId)).map((a) => a.tier)).toEqual([0]);
  });

  it('skips the money-moving-only tier for a non-money-moving incident', async () => {
    const incidentId = await openFor(targetId, false, 60); // well past every delay
    for (let i = 0; i < 6; i += 1) await runEscalationCycle();
    const tiersFired = [...new Set((await tierAlerts(incidentId)).map((a) => a.tier))];
    expect(tiersFired).toEqual([0, 1, 2]); // tier 3 (is_money_moving) skipped
  });

  it('fires the executive tier for a money-moving incident', async () => {
    const incidentId = await openFor(mmTargetId, true, 60);
    for (let i = 0; i < 6; i += 1) await runEscalationCycle();
    const tiersFired = [...new Set((await tierAlerts(incidentId)).map((a) => a.tier))];
    expect(tiersFired).toContain(3);
  });
});
