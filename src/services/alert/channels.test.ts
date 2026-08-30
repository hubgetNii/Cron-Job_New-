import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../../config/index.js';
import { channelFor, setChannelRegistry, type Notification } from './channels.js';

let server: Server;
let received: { body: string; signature: string | undefined } | null = null;

const notification: Notification = {
  alertType: 'API_DOWN',
  severity: 'CRITICAL',
  subject: '"iSmartPay Status Checker" is DOWN',
  body: 'Failure type: HTTP_5XX',
  recipient: 'oncall-payments',
  incidentNumber: 'INC-2026-000001',
  targetName: 'iSmartPay Status Checker',
  payload: { incident_id: 'x' },
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received = { body, signature: req.headers['x-signature'] as string | undefined };
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  process.env['ALERT_WEBHOOK_URL'] = `http://127.0.0.1:${addr.port}/hook`;
  process.env['WEBHOOK_SIGNING_SECRET'] = 'test-secret';
  resetEnvCache();
  setChannelRegistry(undefined); // rebuild with the env just set
});

afterAll(() => {
  delete process.env['ALERT_WEBHOOK_URL'];
  delete process.env['WEBHOOK_SIGNING_SECRET'];
  resetEnvCache();
  setChannelRegistry(undefined);
  return new Promise<void>((r) => server.close(() => r()));
});

describe('WebhookChannel', () => {
  it('POSTs a signed JSON payload', async () => {
    const result = await channelFor('WEBHOOK').send(notification);
    expect(result.ok).toBe(true);
    expect(received).not.toBeNull();

    const parsed = JSON.parse(received!.body) as Record<string, unknown>;
    expect(parsed['alert_type']).toBe('API_DOWN');
    expect(parsed['incident_number']).toBe('INC-2026-000001');

    const expected = `sha256=${createHmac('sha256', 'test-secret').update(received!.body).digest('hex')}`;
    expect(received!.signature).toBe(expected);
  });
});

describe('log-only channels', () => {
  it('return ok without a transport', async () => {
    const r = await channelFor('PUSH').send(notification);
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/logged/);
  });
});
