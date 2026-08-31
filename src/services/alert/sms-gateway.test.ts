import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '../../config/index.js';

const requestMock = vi.fn();
vi.mock('undici', () => ({
  request: (...args: unknown[]): unknown => requestMock(...args),
}));

const { normalizeMsisdn, newUid, smsConfigured, sendSms } = await import('./sms-gateway.js');

function configure(): void {
  process.env['SMS_GATEWAY_URL'] = 'http://157.180.53.137:5665/api/SendSms';
  process.env['SMS_API_ID'] = 'Test94687654';
  process.env['SMS_API_PASSWORD'] = 'secret-pw';
  resetEnvCache();
}

function res(statusCode: number, body: string) {
  return { statusCode, body: { text: () => Promise.resolve(body) } };
}

afterEach(() => {
  requestMock.mockReset();
  delete process.env['SMS_GATEWAY_URL'];
  delete process.env['SMS_API_ID'];
  delete process.env['SMS_API_PASSWORD'];
  resetEnvCache();
});

describe('normalizeMsisdn', () => {
  it('strips +, 00 and separators', () => {
    expect(normalizeMsisdn('+233 55 153 0764')).toBe('233551530764');
    expect(normalizeMsisdn('00233551530764')).toBe('233551530764');
    expect(normalizeMsisdn('233-551-530-764')).toBe('233551530764');
  });
});

describe('newUid', () => {
  it('is 8 hex chars', () => {
    expect(newUid()).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('smsConfigured', () => {
  it('needs url + id + password', () => {
    expect(smsConfigured()).toBe(false);
    configure();
    expect(smsConfigured()).toBe(true);
  });
});

describe('sendSms', () => {
  it('does not send when unconfigured', async () => {
    const r = await sendSms({ to: '+233551530764', message: 'hi' });
    expect(r.ok).toBe(false);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('builds a GET with credentials + params and normalises the number', async () => {
    configure();
    requestMock.mockResolvedValue(res(200, '{"status":"success","uid":"abc"}'));

    const r = await sendSms({
      to: '+233551530764',
      message: 'iSmart Health – 10:00 AM',
      uid: 'deadbeef',
    });

    expect(r.ok).toBe(true);
    const url = requestMock.mock.calls[0]![0] as URL;
    expect(url.searchParams.get('api_id')).toBe('Test94687654');
    expect(url.searchParams.get('api_password')).toBe('secret-pw');
    expect(url.searchParams.get('phonenumber')).toBe('233551530764');
    expect(url.searchParams.get('textmessage')).toBe('iSmart Health – 10:00 AM');
    expect(url.searchParams.get('uid')).toBe('deadbeef');
    expect(url.searchParams.get('isScheduled')).toBe('false');
    expect((requestMock.mock.calls[0]![1] as { method: string }).method).toBe('GET');
  });

  it('accepts the iSmartGhana success shape (status "S", "Message Submitted")', async () => {
    configure();
    requestMock.mockResolvedValue(
      res(
        200,
        '{"message_id":2026083116353908975,"status":"S","remarks":"Message Submitted","uid":"5bf9ba43","phonenumber":"233553476530"}',
      ),
    );
    const r = await sendSms({ to: '233553476530', message: 'hi' });
    expect(r.ok).toBe(true);
  });

  it('flags a non-success status or failure remark returned as HTTP 200', async () => {
    configure();
    requestMock.mockResolvedValue(res(200, '{"status":"F","remarks":"Invalid API credentials"}'));
    const r = await sendSms({ to: '233551530764', message: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/Invalid API credentials/);
  });

  it('fails on a non-2xx', async () => {
    configure();
    requestMock.mockResolvedValue(res(500, 'upstream error'));
    const r = await sendSms({ to: '233551530764', message: 'hi' });
    expect(r.ok).toBe(false);
  });

  it('treats an ambiguous 200 body as success (does not hide real sends)', async () => {
    configure();
    requestMock.mockResolvedValue(res(200, 'OK 12345'));
    const r = await sendSms({ to: '233551530764', message: 'hi' });
    expect(r.ok).toBe(true);
  });
});
