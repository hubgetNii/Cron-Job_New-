import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { checkDbHealth, closePool, query } from '../lib/db.js';
import { resetEnvCache } from '../config/index.js';
import { resetRateLimiters } from './middleware/rate-limit.js';
import { hashPassword } from '../lib/crypto/passwords.js';
import { createUser } from '../repositories/users.repo.js';

const dbUp = (await checkDbHealth()).ok;

process.env['AUTH_ENABLED'] = 'true';
process.env['JWT_SECRET'] = 'e2e-jwt-secret-at-least-sixteen-chars';
resetEnvCache();
resetRateLimiters();

const { createApp } = await import('./app.js');
const app = createApp();

let devToken: string;
let adminToken: string;
let admin2Token: string;
let viewerToken: string;

async function seedUser(email: string, roles: string[]): Promise<void> {
  await createUser({
    email,
    fullName: email,
    passwordHash: await hashPassword('password123'),
    roles: roles as never,
  });
}

async function loginToken(email: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password: 'password123' });
  return res.body.data.accessToken as string;
}

describe.skipIf(!dbUp)('auth + RBAC + four-eyes (Phase 9)', () => {
  beforeAll(async () => {
    await query(`DELETE FROM config_change_requests`);
    await query(`DELETE FROM monitored_apis`);
    await query(`DELETE FROM refresh_tokens`);
    await query(`DELETE FROM users`);
    await seedUser('dev@test.local', ['DEVELOPER']);
    await seedUser('admin@test.local', ['ADMIN', 'DEVELOPER']);
    await seedUser('admin2@test.local', ['ADMIN']);
    await seedUser('viewer@test.local', ['VIEWER']);
    devToken = await loginToken('dev@test.local');
    adminToken = await loginToken('admin@test.local');
    admin2Token = await loginToken('admin2@test.local');
    viewerToken = await loginToken('viewer@test.local');
  });
  afterAll(async () => {
    await query(`DELETE FROM config_change_requests`);
    await query(`DELETE FROM monitored_apis`);
    await query(`DELETE FROM users`);
    await closePool();
    process.env['AUTH_ENABLED'] = 'false';
    resetEnvCache();
    resetRateLimiters();
  });

  it('rejects unauthenticated requests to the API', async () => {
    const res = await request(app).get('/api/v1/targets');
    expect(res.status).toBe(401);
  });

  it('rejects a bad password without leaking whether the account exists', async () => {
    const a = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'dev@test.local', password: 'wrong' });
    const b = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@test.local', password: 'wrong' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('lets an authenticated user read', async () => {
    const res = await request(app)
      .get('/api/v1/targets')
      .set('authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
  });

  it('enforces role on writes (VIEWER cannot create a target)', async () => {
    const res = await request(app)
      .post('/api/v1/targets')
      .set('authorization', `Bearer ${viewerToken}`)
      .send({
        name: 'x',
        endpointClass: 'internal',
        url: 'https://203.0.113.9/x',
        frequencyCron: '*/5 * * * *',
        allowPrivateNetwork: true,
      });
    expect(res.status).toBe(403);
  });

  it('rotates refresh tokens and detects reuse', async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'dev@test.local', password: 'password123' });
    const rt1 = login.body.data.refreshToken as string;

    const r1 = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: rt1 });
    expect(r1.status).toBe(200);
    const rt2 = r1.body.data.refreshToken as string;
    expect(rt2).not.toBe(rt1);

    // Replaying the old token invalidates the whole family.
    const reuse = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: rt1 });
    expect(reuse.status).toBe(401);
    const rt2Dead = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: rt2 });
    expect(rt2Dead.status).toBe(401);
  });

  describe('four-eyes for money-moving targets', () => {
    let requestId: string;

    it('a money-moving target create is queued, not applied', async () => {
      const res = await request(app)
        .post('/api/v1/targets')
        .set('authorization', `Bearer ${devToken}`)
        .send({
          name: 'MoMo Collection',
          endpointClass: 'payment_initiation',
          isMoneyMoving: true,
          url: 'https://203.0.113.11/collect',
          frequencyCron: '*/1 * * * *',
          allowPrivateNetwork: true,
        });
      expect(res.status).toBe(202);
      expect(res.body.data.status).toBe('PENDING');
      requestId = res.body.data.id;

      const targets = await request(app)
        .get('/api/v1/targets')
        .set('authorization', `Bearer ${devToken}`);
      expect(targets.body.data).toHaveLength(0);
    });

    it('the proposer cannot approve their own change', async () => {
      // admin@test also holds DEVELOPER — propose as admin, then try to self-approve.
      const proposed = await request(app)
        .post('/api/v1/targets')
        .set('authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Self approve attempt',
          endpointClass: 'settlement',
          isMoneyMoving: true,
          url: 'https://203.0.113.12/x',
          frequencyCron: '*/2 * * * *',
          allowPrivateNetwork: true,
        });
      const selfApprove = await request(app)
        .post(`/api/v1/config-requests/${proposed.body.data.id}/approve`)
        .set('authorization', `Bearer ${adminToken}`);
      expect(selfApprove.status).toBe(403);
    });

    it('a different ADMIN approves and the change applies', async () => {
      const res = await request(app)
        .post(`/api/v1/config-requests/${requestId}/approve`)
        .set('authorization', `Bearer ${admin2Token}`)
        .send({ note: 'sandbox confirmed' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('APPLIED');

      const targets = await request(app)
        .get('/api/v1/targets')
        .set('authorization', `Bearer ${devToken}`);
      const names = (targets.body.data as Array<{ name: string }>).map((t) => t.name);
      expect(names).toContain('MoMo Collection');
    });
  });
});
