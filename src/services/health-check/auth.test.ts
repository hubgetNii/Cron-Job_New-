import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildAuthMaterial } from './auth.js';
import { resetOAuth2TokenCache } from './oauth2-token-cache.js';

describe('buildAuthMaterial', () => {
  afterEach(() => resetOAuth2TokenCache());

  it('returns empty material for NONE or missing credentials', async () => {
    await expect(buildAuthMaterial('NONE', { token: 'x' })).resolves.toEqual({
      headers: {},
      query: {},
    });
    await expect(buildAuthMaterial('BEARER', null)).resolves.toEqual({ headers: {}, query: {} });
  });

  it('builds a Bearer header from a static token', async () => {
    const auth = await buildAuthMaterial('BEARER', { token: 'abc' });
    expect(auth.headers['Authorization']).toBe('Bearer abc');
  });

  it('builds a Basic auth header from username/password', async () => {
    const auth = await buildAuthMaterial('BASIC', { username: 'u', password: 'p' });
    expect(auth.headers['Authorization']).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('builds iSmartPay-style API_KEY headers from apiId/apiSecret', async () => {
    const auth = await buildAuthMaterial('API_KEY', { apiId: 'id', apiSecret: 'secret' });
    expect(auth.headers).toEqual({ apiId: 'id', apiSecret: 'secret' });
  });

  it('returns empty material for OAUTH2 when required credential fields are missing', async () => {
    const auth = await buildAuthMaterial('OAUTH2', { tokenUrl: 'http://x' });
    expect(auth).toEqual({ headers: {}, query: {} });
  });

  describe('OAUTH2 end-to-end', () => {
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ data: { token: 'fetched-tok', expiry: Math.floor(Date.now() / 1000) + 3600 } }),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no server address');
      baseUrl = `http://127.0.0.1:${addr.port}/`;
    });

    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it('fetches a token via the OAuth2 cache and returns it as a Bearer header', async () => {
      const auth = await buildAuthMaterial('OAUTH2', {
        tokenUrl: baseUrl,
        tokenUsername: 'accesscode',
        tokenPassword: 'clientcode',
      });
      expect(auth.headers['Authorization']).toBe('Bearer fetched-tok');
    });
  });
});
