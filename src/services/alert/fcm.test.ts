import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '../../config/index.js';
import { resolveFcmTarget, setFcmClient, type FcmClient } from './fcm.js';
import { channelFor, setChannelRegistry, type Notification } from './channels.js';

function notif(over: Partial<Notification> = {}): Notification {
  return {
    alertType: 'API_DOWN',
    severity: 'CRITICAL',
    subject: '"Payments" is DOWN',
    body: 'Failure type: HTTP_5XX.',
    recipient: 'ops',
    incidentNumber: 'INC-2026-000001',
    targetName: 'Payments',
    payload: { incident_id: 'i-1', api_id: 'a-1' },
    ...over,
  };
}

describe('resolveFcmTarget', () => {
  it('routes /topics/ and topic: prefixes to a topic', () => {
    expect(resolveFcmTarget('/topics/cron-alerts', undefined)).toEqual({ topic: 'cron-alerts' });
    expect(resolveFcmTarget('topic:cron-alerts', undefined)).toEqual({ topic: 'cron-alerts' });
  });

  it('treats a long opaque string as a device registration token', () => {
    const deviceToken = `f${'A1b2C3'.repeat(30)}`;
    expect(resolveFcmTarget(deviceToken, 'ignored')).toEqual({ token: deviceToken });
  });

  it('falls back to the default topic for a plain recipient like "ops"', () => {
    expect(resolveFcmTarget('ops', 'cron-alerts')).toEqual({ topic: 'cron-alerts' });
  });

  it('throws for a plain recipient when no default topic is configured', () => {
    expect(() => resolveFcmTarget('ops', undefined)).toThrow(/FCM_DEFAULT_TOPIC/);
  });
});

describe('PUSH channel', () => {
  afterEach(() => {
    setChannelRegistry(undefined);
    setFcmClient(undefined);
    delete process.env['FCM_SERVICE_ACCOUNT_FILE'];
    resetEnvCache();
  });

  it('logs a fallback (does not fail the alert) when FCM is not configured', async () => {
    const result = await channelFor('PUSH').send(notif());
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/logged only/);
  });

  it('delegates to the FCM client and formats the notification when configured', async () => {
    process.env['FCM_SERVICE_ACCOUNT_FILE'] = '/tmp/does-not-need-to-exist.json';
    resetEnvCache();
    const send = vi.fn().mockResolvedValue({ name: 'projects/p/messages/0:1700000000%1234' });
    setFcmClient({ send } as unknown as FcmClient);
    setChannelRegistry(undefined);

    const result = await channelFor('PUSH').send(notif({ recipient: '/topics/cron-alerts' }));

    expect(send).toHaveBeenCalledOnce();
    const arg = send.mock.calls[0]![0] as {
      recipient: string;
      title: string;
      data: Record<string, string>;
    };
    expect(arg.recipient).toBe('/topics/cron-alerts');
    expect(arg.title).toContain('DOWN');
    expect(arg.data).toMatchObject({ alert_type: 'API_DOWN', incident_id: 'i-1', api_id: 'a-1' });
    expect(result.ok).toBe(true);
  });

  it('reports a failure (not a throw) when the FCM client errors', async () => {
    process.env['FCM_SERVICE_ACCOUNT_FILE'] = '/tmp/does-not-need-to-exist.json';
    resetEnvCache();
    setFcmClient({
      send: vi.fn().mockRejectedValue(new Error('FCM HTTP 404: token not registered')),
    } as unknown as FcmClient);
    setChannelRegistry(undefined);

    const result = await channelFor('PUSH').send(notif());
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/token not registered/);
  });
});
