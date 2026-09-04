import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getOAuth2Token, resetOAuth2TokenCache, type OAuth2Credentials } from './oauth2-token-cache.js';

let server: Server;
let baseUrl: string;
let requestCount = 0;
let lastAuthHeader: string | undefined;
let lastBody = '';
let respond: (n: number) => { status: number; body: string };

beforeAll(async () => {
  server = createServer((req, res) => {
    requestCount += 1;
    lastAuthHeader = req.headers.authorization;
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      lastBody = raw;
      const r = respond(requestCount);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(r.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no server address');
  baseUrl = `http://127.0.0.1:${addr.port}/`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

afterEach(() => {
  resetOAuth2TokenCache();
  requestCount = 0;
});

function creds(overrides: Partial<OAuth2Credentials> = {}): OAuth2Credentials {
  return {
    tokenUrl: baseUrl,
    tokenUsername: 'accesscode',
    tokenPassword: 'clientcode',
    ...overrides,
  };
}

describe('getOAuth2Token', () => {
  it('fetches, sends Basic auth, and returns the token from the default path', async () => {
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    respond = () => ({
      status: 200,
      body: JSON.stringify({ success: true, code: 0, data: { token: 'tok-1', expiry } }),
    });

    const token = await getOAuth2Token(creds());
    expect(token).toBe('tok-1');
    expect(requestCount).toBe(1);
    expect(lastAuthHeader).toBe(`Basic ${Buffer.from('accesscode:clientcode').toString('base64')}`);
  });

  it('caches the token and does not refetch while still fresh', async () => {
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    respond = () => ({
      status: 200,
      body: JSON.stringify({ data: { token: 'tok-cached', expiry } }),
    });

    const first = await getOAuth2Token(creds());
    const second = await getOAuth2Token(creds());
    expect(first).toBe('tok-cached');
    expect(second).toBe('tok-cached');
    expect(requestCount).toBe(1);
  });

  it('refreshes once the cached token is past its safety margin', async () => {
    let call = 0;
    respond = () => {
      call += 1;
      // First token already within the 60s safety margin of "now" — treated as expired.
      const expiry = call === 1 ? Math.floor(Date.now() / 1000) + 30 : Math.floor(Date.now() / 1000) + 3600;
      return { status: 200, body: JSON.stringify({ data: { token: `tok-${call}`, expiry } }) };
    };

    const first = await getOAuth2Token(creds());
    const second = await getOAuth2Token(creds());
    expect(first).toBe('tok-1');
    expect(second).toBe('tok-2');
    expect(requestCount).toBe(2);
  });

  it('substitutes {{uuid}} in a configured tokenBody', async () => {
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    respond = () => ({ status: 200, body: JSON.stringify({ data: { token: 'tok', expiry } }) });

    await getOAuth2Token(creds({ tokenBody: '{"trackid":"{{uuid}}"}' }));
    const parsed = JSON.parse(lastBody) as { trackid: string };
    expect(parsed.trackid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('respects a custom tokenPath/tokenExpiryPath', async () => {
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    respond = () => ({
      status: 200,
      body: JSON.stringify({ result: { access_token: 'custom-tok', expires_at: expiry } }),
    });

    const token = await getOAuth2Token(
      creds({ tokenPath: 'result.access_token', tokenExpiryPath: 'result.expires_at' }),
    );
    expect(token).toBe('custom-tok');
  });

  it('throws when the token is missing from the response', async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ data: {} }) });
    await expect(getOAuth2Token(creds())).rejects.toThrow(/not found/);
  });

  it('throws on a non-2xx response', async () => {
    respond = () => ({ status: 401, body: 'unauthorized' });
    await expect(getOAuth2Token(creds())).rejects.toThrow(/HTTP 401/);
  });
});
