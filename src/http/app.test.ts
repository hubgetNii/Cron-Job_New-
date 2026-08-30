import { describe, expect, it, vi, beforeEach } from 'vitest';
import request from 'supertest';

const checkDbHealth = vi.fn();
const checkRedisHealth = vi.fn();
const getSchedulerStatus = vi.fn();

vi.mock('../lib/db.js', () => ({ checkDbHealth }));
vi.mock('../lib/redis.js', () => ({ checkRedisHealth }));
vi.mock('../services/scheduler/scheduler-status.service.js', () => ({ getSchedulerStatus }));

const { createApp } = await import('./app.js');
const app = createApp();

beforeEach(() => {
  checkDbHealth.mockResolvedValue({ ok: true, latencyMs: 3 });
  checkRedisHealth.mockResolvedValue({ ok: true, latencyMs: 1 });
  getSchedulerStatus.mockResolvedValue({
    health: 'not_running',
    heartbeat: null,
    graceMs: 30_000,
    missedRunTotal: 0,
  });
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

  it('GET /health/scheduler reflects scheduler status (503 when not running)', async () => {
    const res = await request(app).get('/health/scheduler');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_running');
    expect(res.body).toHaveProperty('missedRunTotal', 0);
  });

  it('GET /health/scheduler is 200 when the scheduler is ticking', async () => {
    getSchedulerStatus.mockResolvedValue({
      health: 'ok',
      heartbeat: {
        instanceId: 's1',
        lastTickAt: new Date().toISOString(),
        activeJobCount: 2,
        queueDepth: 0,
        ageMs: 1200,
      },
      graceMs: 30_000,
      missedRunTotal: 0,
    });
    const res = await request(app).get('/health/scheduler');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', activeJobCount: 2 });
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

  it('unknown /api/v1 routes still return a structured 404', async () => {
    const res = await request(app).get('/api/v1/not-a-real-endpoint');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects a non-uuid target id before touching the database', async () => {
    const res = await request(app).get('/api/v1/targets/not-a-uuid');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
