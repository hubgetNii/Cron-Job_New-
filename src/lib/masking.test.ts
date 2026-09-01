import { describe, expect, it } from 'vitest';
import { MASK, maskBody, maskHeaders, maskJson, maskUrl } from './masking.js';

describe('maskHeaders', () => {
  it('masks Authorization and api-key, keeps content-type / request-id', () => {
    const h = maskHeaders({
      Authorization: 'Bearer abc.def.ghi',
      'X-API-Key': 'sk_live_1234567890',
      'Content-Type': 'application/json',
      'X-Request-ID': 'REQ-1',
      'X-Custom-Token': 'zzz',
    });
    expect(h['authorization']).toBe(MASK);
    expect(h['x-api-key']).toBe(MASK);
    expect(h['x-custom-token']).toBe(MASK); // fuzzy match on "token"
    expect(h['content-type']).toBe('application/json');
    expect(h['x-request-id']).toBe('REQ-1');
  });
});

describe('maskUrl', () => {
  it('masks sensitive query params only', () => {
    const out = maskUrl('https://api.example.com/send?api_password=hunter2&phone=233555&uid=ab12');
    expect(out).toContain(`api_password=${encodeURIComponent(MASK)}`);
    expect(out).toContain('phone=233555');
    expect(out).toContain('uid=ab12');
  });
});

describe('maskJson', () => {
  it('masks by key at any depth and scrubs PAN from string leaves', () => {
    const out = maskJson({
      merchantId: 'M123',
      amount: '500.00',
      auth: { token: 'secret', clientSecret: 'x' },
      note: 'card 4111 1111 1111 1111 used',
    }) as Record<string, unknown>;
    expect((out['auth'] as Record<string, unknown>)['token']).toBe(MASK);
    expect((out['auth'] as Record<string, unknown>)['clientSecret']).toBe(MASK);
    expect(out['merchantId']).toBe('M123');
    expect(String(out['note'])).not.toContain('4111');
  });
});

describe('maskBody', () => {
  it('masks a JSON body by key', () => {
    const out = maskBody('{"pin":"1234","reference":"HEALTH-1"}');
    expect(out).toContain(MASK);
    expect(out).toContain('HEALTH-1');
    expect(out).not.toContain('1234');
  });

  it('scrubs inline secrets in a non-JSON body', () => {
    const out = maskBody('login failed for token=abcdef123456 on host');
    expect(out).toMatch(/token=\*\*\*MASKED\*\*\*/);
  });

  it('truncates very large bodies', () => {
    const out = maskBody('x'.repeat(200_000), 1000);
    expect(out).toMatch(/…\[truncated]$/);
    expect(out!.length).toBeLessThan(1100);
  });

  it('passes null/empty through', () => {
    expect(maskBody(null)).toBeNull();
    expect(maskBody('')).toBeNull();
  });
});
