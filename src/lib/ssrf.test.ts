import { describe, expect, it } from 'vitest';
import { assertUrlAllowed, isBlockedIp, SsrfBlockedError } from './ssrf.js';

describe('isBlockedIp', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '0.0.0.0',
    '::1',
  ])('blocks %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34'])('allows public %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

describe('assertUrlAllowed', () => {
  const publicResolve = (): Promise<string[]> => Promise.resolve(['93.184.216.34']);
  const privateResolve = (): Promise<string[]> => Promise.resolve(['10.0.0.5']);

  it('rejects non-http protocols', async () => {
    await expect(assertUrlAllowed('ftp://example.com')).rejects.toThrow(SsrfBlockedError);
  });

  it('rejects localhost by name', async () => {
    await expect(assertUrlAllowed('http://localhost:8080/x')).rejects.toThrow(/internal/);
  });

  it('rejects a hostname that resolves to a private address', async () => {
    await expect(
      assertUrlAllowed('https://sneaky.example.com', { resolve: privateResolve }),
    ).rejects.toThrow(/blocked address 10\.0\.0\.5/);
  });

  it('allows a public hostname', async () => {
    await expect(
      assertUrlAllowed('https://api.example.com/v1', { resolve: publicResolve }),
    ).resolves.toBeUndefined();
  });

  it('honours the allowPrivateNetwork override', async () => {
    await expect(
      assertUrlAllowed('http://10.0.0.5:9000', { allowPrivateNetwork: true }),
    ).resolves.toBeUndefined();
  });
});
