import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDbHealth, closePool, query } from '../../lib/db.js';
import { createAlert } from '../../repositories/alerts.repo.js';
import { openIncident } from '../../repositories/incidents.repo.js';
import { createMaintenanceWindow } from '../../repositories/maintenance-windows.repo.js';
import type { Channel, Notification } from './channels.js';
import { setChannelRegistry } from './channels.js';
import { runDeliveryCycle } from './delivery.service.js';

const dbUp = (await checkDbHealth()).ok;

let targetId: string;
let incidentId: string;
const sent: Notification[] = [];

const okChannel: Channel = {
  kind: 'WEBHOOK',
  send: (n) => {
    sent.push(n);
    return Promise.resolve({ ok: true, detail: 'test-ok' });
  },
};
const failChannel: Channel = {
  kind: 'SMS',
  send: () => Promise.resolve({ ok: false, detail: 'test-fail' }),
};

async function status(alertId: string): Promise<string> {
  const { rows } = await query<{ status: string }>(`SELECT status FROM alerts WHERE id = $1`, [
    alertId,
  ]);
  return rows[0]!.status;
}

describe.skipIf(!dbUp)('alert delivery (Phase 7)', () => {
  beforeAll(async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron, allow_private_network)
       VALUES ('deliv', 'payment_status', 'CRITICAL', 'https://203.0.113.80/x', '*/1 * * * *', true)
       RETURNING id`,
    );
    targetId = rows[0]!.id;
    const inc = await openIncident({
      apiId: targetId,
      incidentType: 'OUTAGE',
      severity: 'CRITICAL',
      endpointClassSnapshot: 'payment_status',
      isMoneyMovingSnapshot: false,
      detectedByCheckId: null,
      failureType: 'HTTP_5XX',
    });
    incidentId = inc.id;
  });
  afterAll(async () => {
    await query(`DELETE FROM alerts`);
    await query(`DELETE FROM incidents`);
    await query(`DELETE FROM maintenance_windows`);
    await query(`DELETE FROM monitored_apis`);
    await closePool();
  });
  beforeEach(() => {
    sent.length = 0;
    setChannelRegistry(
      new Map<Channel['kind'], Channel>([
        ['WEBHOOK', okChannel],
        ['SMS', failChannel],
      ]),
    );
  });
  afterEach(async () => {
    setChannelRegistry(undefined);
    await query(`DELETE FROM alerts`);
    await query(`DELETE FROM maintenance_windows`);
  });

  it('delivers a pending alert and marks it SENT', async () => {
    const a = await createAlert({
      alertType: 'API_DOWN',
      channel: 'WEBHOOK',
      recipient: 'ops',
      incidentId,
      apiId: targetId,
    });
    const res = await runDeliveryCycle();
    expect(res.delivered).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toMatch(/DOWN/);
    expect(await status(a.id)).toBe('SENT');
  });

  it('marks a failed delivery FAILED', async () => {
    const a = await createAlert({
      alertType: 'ESCALATION_TRIGGERED',
      channel: 'SMS',
      recipient: 'oncall',
      incidentId,
      apiId: targetId,
      escalationTier: 1,
    });
    await runDeliveryCycle();
    expect(await status(a.id)).toBe('FAILED');
  });

  it('suppresses alerts for a target inside a maintenance window', async () => {
    await createMaintenanceWindow({
      targetId,
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 3_600_000),
      reason: 'planned PSP upgrade',
    });
    const a = await createAlert({
      alertType: 'API_DOWN',
      channel: 'WEBHOOK',
      recipient: 'ops',
      incidentId,
      apiId: targetId,
    });
    const res = await runDeliveryCycle();
    expect(res.suppressed).toBe(1);
    expect(sent).toHaveLength(0);
    expect(await status(a.id)).toBe('SUPPRESSED');
  });

  it('still delivers a recovery alert during a maintenance window', async () => {
    await createMaintenanceWindow({
      targetId,
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 3_600_000),
      reason: 'planned',
    });
    const a = await createAlert({
      alertType: 'API_RECOVERED',
      channel: 'WEBHOOK',
      recipient: 'ops',
      incidentId,
      apiId: targetId,
    });
    await runDeliveryCycle();
    expect(await status(a.id)).toBe('SENT');
  });

  it('a global maintenance window suppresses too', async () => {
    await createMaintenanceWindow({
      targetId: null,
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 3_600_000),
      reason: 'org-wide freeze',
    });
    const a = await createAlert({
      alertType: 'API_DEGRADED',
      channel: 'WEBHOOK',
      recipient: 'ops',
      incidentId,
      apiId: targetId,
    });
    await runDeliveryCycle();
    expect(await status(a.id)).toBe('SUPPRESSED');
  });
});
