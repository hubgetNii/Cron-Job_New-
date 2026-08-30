import { describe, expect, it, vi, beforeEach } from 'vitest';
import request from 'supertest';

const checkDbHealth = vi.fn();
const checkRedisHealth = vi.fn();

vi.mock('../lib/db.js', () => ({ checkDbHealth }));
vi.mock('../lib/redis.js', () => ({ checkRedisHealth }));

const { createApp } = await import('./app.js');
const app = createApp();

beforeEach(() => {
  checkDbHealth.mockResolvedValue({ ok: true, latencyMs: 3 });
  checkRedisHealth.mockResolvedValue({ ok: true, latencyMs: 1 });
});

describe('ops endpoints', () => {
  it('GET /live is always 200 and never touches dependencies', async () => {
    const res = await request(app).get('/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('alive');
    expect(checkDbHealth).not.toHaveBeenCalled();
  });

  it('GET /ready is 200 when all dependencies are healthy', async () => {
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ready', checks: { database: true, redis: true } });
  });

  it('GET /ready is 503 when a dependency is down', async () => {
    checkRedisHealth.mockResolvedValue({ ok: false, latencyMs: null, error: 'ECONNREFUSED' });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.checks.redis).toBe(false);
  });

  it('GET /health reports component detail', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.components.database).toMatchObject({ ok: true });
    expect(res.body).toHaveProperty('version');
  });

  it('GET /health/scheduler is a documented Phase 5 placeholder', async () => {
    const res = await request(app).get('/health/scheduler');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'not_implemented', phase: 5 });
  });

  it('sets a correlation id header and echoes an inbound one', async () => {
    const generated = await request(app).get('/live');
    expect(generated.headers['x-request-id']).toMatch(/[0-9a-f-]{36}/);

    const echoed = await request(app).get('/live').set('x-request-id', 'trace-abc');
    expect(echoed.headers['x-request-id']).toBe('trace-abc');
  });
});

describe('routing fallbacks', () => {
  it('unknown routes return a structured 404', async () => {
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('/api/v1 is reserved but not yet implemented', async () => {
    const res = await request(app).get('/api/v1/targets');
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
  });
});
