import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { resetEnvCache } from '../config/index.js';

const ORIGIN = 'https://dashboard.example.vercel.app';

process.env['CORS_ALLOWED_ORIGINS'] = `${ORIGIN}, http://localhost:5173`;
resetEnvCache();

const { createApp } = await import('./app.js');
const app = createApp();

describe('CORS', () => {
  afterAll(() => {
    delete process.env['CORS_ALLOWED_ORIGINS'];
    resetEnvCache();
  });

  it('answers a preflight from an allowed origin', async () => {
    const res = await request(app)
      .options('/api/v1/status')
      .set('origin', ORIGIN)
      .set('access-control-request-method', 'GET');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-headers']).toMatch(/authorization/i);
  });

  it('adds the ACAO header to an actual request from an allowed origin', async () => {
    const res = await request(app).get('/api/v1/status').set('origin', ORIGIN);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['vary']).toMatch(/Origin/);
  });

  it('omits the ACAO header for a disallowed origin', async () => {
    const res = await request(app).get('/api/v1/status').set('origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('is a no-op for same-origin (no Origin header) requests', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('CORS disabled (no allowlist)', () => {
  it('adds no headers when CORS_ALLOWED_ORIGINS is unset', async () => {
    delete process.env['CORS_ALLOWED_ORIGINS'];
    resetEnvCache();
    // A fresh app instance re-reads the (now empty) allowlist.
    const res = await request(createApp()).get('/api/v1/status').set('origin', ORIGIN);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
