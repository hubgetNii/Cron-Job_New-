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

async function tokenFor(email: string, roles: string[]): Promise<string> {
  await createUser({
    email,
    fullName: email,
    passwordHash: await hashPassword('password123'),
    roles: roles as never,
  });
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password: 'password123' });
  return res.body.data.accessToken as string;
}

let adminToken: string;
let viewerToken: string;

describe.skipIf(!dbUp)('POST /alerts/test', () => {
  beforeAll(async () => {
    await query(`DELETE FROM users`);
    adminToken = await tokenFor('alert-admin@test.local', ['ADMIN']);
    viewerToken = await tokenFor('alert-viewer@test.local', ['VIEWER']);
  });
  afterAll(async () => {
    await query(`DELETE FROM users`);
    await closePool();
    process.env['AUTH_ENABLED'] = 'false';
    resetEnvCache();
    resetRateLimiters();
  });

  it('is ADMIN-only', async () => {
    const res = await request(app)
      .post('/api/v1/alerts/test')
      .set('authorization', `Bearer ${viewerToken}`)
      .send({ channel: 'PUSH' });
    expect(res.status).toBe(403);
  });

  it('sends a synthetic alert through a channel and reports the outcome', async () => {
    const res = await request(app)
      .post('/api/v1/alerts/test')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ channel: 'PUSH', message: 'ping' });
    // No FCM service account in tests → the channel logs and reports success.
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ channel: 'PUSH', ok: true });
    expect(res.body.data.detail).toMatch(/logged only/);
  });

  it('rejects an unknown channel', async () => {
    const res = await request(app)
      .post('/api/v1/alerts/test')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ channel: 'CARRIER_PIGEON' });
    expect(res.status).toBe(422);
  });
});
