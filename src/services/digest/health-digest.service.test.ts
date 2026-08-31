import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDbHealth, closePool, query } from '../../lib/db.js';
import { resetEnvCache } from '../../config/index.js';
import type { AffectedService } from '../../repositories/health-digests.repo.js';
import {
  buildDigest,
  composeEmail,
  composeMessage,
  evaluateDigest,
  rollUp,
  type ServiceStatus,
} from './health-digest.service.js';

const dbUp = (await checkDbHealth()).ok;

/* --- pure logic (no DB) --------------------------------------------------- */

describe('rollUp', () => {
  const svc = (
    status: string | null,
    over: Partial<{ isMoneyMoving: boolean; endpointClass: string }> = {},
  ) => ({
    status,
    isMoneyMoving: over.isMoneyMoving ?? false,
    endpointClass: over.endpointClass ?? 'internal',
  });

  it('HEALTHY when every service is UP', () => {
    expect(rollUp([svc('UP'), svc('UP'), svc('UP')])).toBe('HEALTHY');
  });
  it('DEGRADED for a non-critical DOWN or DEGRADED or UNKNOWN', () => {
    expect(rollUp([svc('UP'), svc('DOWN')])).toBe('DEGRADED');
    expect(rollUp([svc('UP'), svc('DEGRADED')])).toBe('DEGRADED');
    expect(rollUp([svc('UP'), svc('UNKNOWN')])).toBe('DEGRADED');
  });
  it('CRITICAL when a money-moving or payment_status service is DOWN', () => {
    expect(rollUp([svc('UP'), svc('DOWN', { isMoneyMoving: true })])).toBe('CRITICAL');
    expect(rollUp([svc('UP'), svc('DOWN', { endpointClass: 'payment_status' })])).toBe('CRITICAL');
  });
});

describe('composeMessage', () => {
  const base = {
    now: new Date('2026-08-31T10:00:00Z'),
    nextCheckAt: new Date('2026-08-31T10:30:00Z'),
    totalServices: 20,
    healthyServices: 18,
  };
  const affected: AffectedService[] = [
    { name: 'Payment API', status: 'DOWN', endpointClass: 'payment_status', isMoneyMoving: true },
    { name: 'SMS API', status: 'DEGRADED', endpointClass: 'notification', isMoneyMoving: false },
  ];

  it('formats a DEGRADED summary like the spec', () => {
    const msg = composeMessage({
      ...base,
      overallLevel: 'DEGRADED',
      previousLevel: 'HEALTHY',
      affected,
    });
    expect(msg).toContain('Status: ⚠️ DEGRADED');
    expect(msg).toContain('18/20 services healthy.');
    expect(msg).toContain('2 services need attention: Payment API, SMS API.');
    expect(msg).toContain('Next check:');
  });

  it('calls out the critical service by name when CRITICAL', () => {
    const msg = composeMessage({
      ...base,
      overallLevel: 'CRITICAL',
      previousLevel: 'DEGRADED',
      affected,
    });
    expect(msg).toContain('Status: 🔴 CRITICAL');
    expect(msg).toContain('Critical: Payment API DOWN.');
    expect(msg).toContain('Also degraded: SMS API.');
  });

  it('announces recovery on return to HEALTHY', () => {
    const msg = composeMessage({
      ...base,
      healthyServices: 20,
      overallLevel: 'HEALTHY',
      previousLevel: 'CRITICAL',
      affected: [],
    });
    expect(msg).toContain('Status: ✅ HEALTHY');
    expect(msg).toContain('All 20 services healthy.');
    expect(msg).toContain('Recovered from CRITICAL.');
  });
});

describe('composeEmail (full platform report)', () => {
  const svc = (over: Partial<ServiceStatus>): ServiceStatus => ({
    name: 'Svc',
    status: 'UP',
    endpointClass: 'internal',
    environment: 'production',
    isMoneyMoving: false,
    uptime24h: 99.9,
    lastResponseMs: 120,
    lastRunAt: new Date(),
    openIncident: false,
    ...over,
  });

  const report = composeEmail({
    now: new Date('2026-08-31T10:00:00Z'),
    nextCheckAt: new Date('2026-08-31T10:30:00Z'),
    overallLevel: 'DEGRADED',
    previousLevel: 'HEALTHY',
    healthyServices: 2,
    degradedServices: 0,
    downServices: 1,
    openIncidents: 1,
    services: [
      svc({
        name: 'Payments API',
        status: 'DOWN',
        isMoneyMoving: true,
        openIncident: true,
        uptime24h: 71.2,
      }),
      svc({ name: 'Ledger API', status: 'UP' }),
      svc({ name: 'SMS API', status: 'UP', uptime24h: 100 }),
    ],
  });

  it('lists every system with status, uptime and response time (text)', () => {
    expect(report.subject).toBe('[DEGRADED] iSmart Health — 2/3 systems healthy');
    expect(report.body).toContain('Payments API');
    expect(report.body).toContain('Ledger API');
    expect(report.body).toContain('up24h 71.20%');
    expect(report.body).toContain('INCIDENT OPEN');
    expect(report.body).toContain('Open incidents: 1');
    // money-moving / down service sorts first
    expect(report.body.indexOf('Payments API')).toBeLessThan(report.body.indexOf('Ledger API'));
  });

  it('produces safe HTML', () => {
    expect(report.html).toContain('<table');
    expect(report.html).toContain('Payments API');
    expect(report.html).toContain('incident open');
    expect(report.html).not.toContain('<script');
  });

  it('escapes system names in HTML', () => {
    const r = composeEmail({
      now: new Date(),
      nextCheckAt: new Date(),
      overallLevel: 'HEALTHY',
      previousLevel: 'HEALTHY',
      healthyServices: 1,
      degradedServices: 0,
      downServices: 0,
      openIncidents: 0,
      services: [svc({ name: '<b>x</b> & "y"' })],
    });
    expect(r.html).toContain('&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;');
  });
});

/* --- state machine (DB-backed) ----------------------------------------- */

let ids: Record<string, string> = {};

async function seedService(
  name: string,
  status: string,
  opts: { moneyMoving?: boolean; endpointClass?: string } = {},
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron, is_money_moving, allow_private_network, is_active)
     VALUES ($1, $2, 'HIGH', $3, '*/5 * * * *', $4, true, true) RETURNING id`,
    [
      name,
      opts.endpointClass ?? 'internal',
      `https://203.0.113.${Math.floor(Math.random() * 200) + 1}/x`,
      opts.moneyMoving ?? false,
    ],
  );
  const id = rows[0]!.id;
  await query(
    `INSERT INTO target_schedule_state (target_id, last_status, last_actual_run_at)
     VALUES ($1, $2::health_status, now())`,
    [id, status],
  );
  return id;
}

async function setStatus(id: string, status: string): Promise<void> {
  await query(
    `UPDATE target_schedule_state SET last_status = $2::health_status WHERE target_id = $1`,
    [id, status],
  );
}

describe.skipIf(!dbUp)('evaluateDigest — Rule A (overall state change)', () => {
  beforeAll(() => {
    process.env['SMS_DIGEST_ENABLED'] = 'true';
    process.env['SMS_DIGEST_RECIPIENTS'] = '+233200000000';
    resetEnvCache();
  });
  afterAll(async () => {
    delete process.env['SMS_DIGEST_RECIPIENTS'];
    resetEnvCache();
    await query(`DELETE FROM monitored_apis`);
    await query(`DELETE FROM health_digests`);
    await query(`DELETE FROM notification_contacts`);
    await closePool();
  });
  beforeEach(async () => {
    await query(`DELETE FROM health_digests`);
    await query(`DELETE FROM monitored_apis`);
    await query(`DELETE FROM notification_contacts`);
    ids = {
      a: await seedService('Ledger API', 'UP'),
      b: await seedService('Notification API', 'UP'),
      pay: await seedService('Payment API', 'UP', {
        moneyMoving: true,
        endpointClass: 'payment_status',
      }),
    };
  });
  afterEach(async () => {
    await query(`DELETE FROM health_digests`);
  });

  it('records HEALTHY on a clean system and does NOT send a routine SMS', async () => {
    const d = await evaluateDigest();
    expect(d.overallLevel).toBe('HEALTHY');
    expect(d.smsSent).toBe(false);
    expect(d.reason).toMatch(/no routine SMS/);
  });

  it('sends once on HEALTHY → DEGRADED, then suppresses while still DEGRADED', async () => {
    await evaluateDigest(); // baseline HEALTHY
    await setStatus(ids.b!, 'DOWN');

    const degraded = await evaluateDigest();
    expect(degraded.overallLevel).toBe('DEGRADED');
    expect(degraded.smsSent).toBe(true);
    expect(degraded.previousLevel).toBe('HEALTHY');
    expect(degraded.affected.map((a) => a.name)).toContain('Notification API');

    const stillDegraded = await evaluateDigest();
    expect(stillDegraded.smsSent).toBe(false);
    expect(stillDegraded.reason).toMatch(/no change \(still DEGRADED\)/);
  });

  it('escalates DEGRADED → CRITICAL when a money-moving service drops', async () => {
    await evaluateDigest();
    await setStatus(ids.b!, 'DEGRADED');
    await evaluateDigest(); // now DEGRADED
    await setStatus(ids.pay!, 'DOWN');

    const critical = await evaluateDigest();
    expect(critical.overallLevel).toBe('CRITICAL');
    expect(critical.smsSent).toBe(true);
    expect(critical.reason).toContain('DEGRADED → CRITICAL');
  });

  it('sends a recovery SMS on CRITICAL → HEALTHY', async () => {
    await setStatus(ids.pay!, 'DOWN');
    await evaluateDigest(); // CRITICAL
    await setStatus(ids.pay!, 'UP');

    const recovered = await evaluateDigest();
    expect(recovered.overallLevel).toBe('HEALTHY');
    expect(recovered.smsSent).toBe(true);
    expect(recovered.previousLevel).toBe('CRITICAL');
  });

  it('preview does not persist or change state', async () => {
    const before = await query(`SELECT count(*)::int n FROM health_digests`);
    const preview = await buildDigest();
    const after = await query(`SELECT count(*)::int n FROM health_digests`);
    expect(preview.overallLevel).toBe('HEALTHY');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('an every-run EMAIL contact gets the full-status email even when nothing changed', async () => {
    await query(
      `INSERT INTO notification_contacts (name, channel, address, digest, digest_every_run)
       VALUES ('Ibrahim', 'EMAIL', 'ibrahim@ismartghana.com', true, true)`,
    );
    await evaluateDigest(); // baseline HEALTHY
    const second = await evaluateDigest(); // still HEALTHY — no state change
    expect(second.overallLevel).toBe('HEALTHY');
    expect(second.emailSent).toBe(true); // logged-fallback counts as ok
    expect(second.emailRecipients).toBe(1);
    expect(second.reason).toMatch(/Email → 1\/1/);
  });

  it('a state-change-only EMAIL contact only gets email on a transition', async () => {
    await query(
      `INSERT INTO notification_contacts (name, channel, address, digest, digest_every_run)
       VALUES ('Ops', 'EMAIL', 'ops@ismartghana.com', true, false)`,
    );
    const first = await evaluateDigest(); // HEALTHY first digest — no send
    expect(first.emailSent).toBe(false);

    await setStatus(ids.b!, 'DOWN');
    const changed = await evaluateDigest(); // HEALTHY → DEGRADED
    expect(changed.emailSent).toBe(true);
  });
});
