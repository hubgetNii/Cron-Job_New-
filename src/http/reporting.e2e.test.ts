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
process.env['STATUS_PAGE_ENABLED'] = 'true';
resetEnvCache();
resetRateLimiters();

const { createApp } = await import('./app.js');
const app = createApp();

async function loginToken(email: string, roles: string[]): Promise<string> {
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

let viewerToken: string;
let devToken: string;
let complianceToken: string;

describe.skipIf(!dbUp)('reporting + status page (Phase 11)', () => {
  beforeAll(async () => {
    await query(`DELETE FROM refresh_tokens`);
    await query(`DELETE FROM users`);
    viewerToken = await loginToken('viewer-rep@test.local', ['VIEWER']);
    devToken = await loginToken('dev-rep@test.local', ['DEVELOPER']);
    complianceToken = await loginToken('compliance-rep@test.local', ['COMPLIANCE']);
  });
  afterAll(async () => {
    await query(`DELETE FROM users`);
    await closePool();
    process.env['AUTH_ENABLED'] = 'false';
    resetEnvCache();
    resetRateLimiters();
  });

  it('serves the public status page with no auth and no sensitive fields', async () => {
    const res = await request(app).get('/api/v1/status');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('overall');
    expect(res.body.data).toHaveProperty('services');
    expect(JSON.stringify(res.body.data)).not.toMatch(/http:\/\/|https:\/\//);
  });

  it('lets any authenticated user read the SLA summary', async () => {
    const res = await request(app)
      .get('/api/v1/sla/summary')
      .set('authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('meeting');
    expect(res.body.data).toHaveProperty('breaching');
  });

  it('restricts the compliance report to COMPLIANCE/MANAGEMENT/ADMIN', async () => {
    const denied = await request(app)
      .get('/api/v1/reports/compliance')
      .set('authorization', `Bearer ${devToken}`);
    expect(denied.status).toBe(403);

    const ok = await request(app)
      .get('/api/v1/reports/compliance')
      .set('authorization', `Bearer ${complianceToken}`);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toHaveProperty('incidents');
    expect(ok.body.data).toHaveProperty('auditSummary');
  });

  it('exports the compliance incidents as CSV', async () => {
    const res = await request(app)
      .get('/api/v1/reports/compliance?format=csv')
      .set('authorization', `Bearer ${complianceToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\n')[0]).toContain('incident_number');
  });

  it('rejects an inverted date range', async () => {
    const res = await request(app)
      .get('/api/v1/reports/compliance?from=2026-08-01T00:00:00Z&to=2026-07-01T00:00:00Z')
      .set('authorization', `Bearer ${complianceToken}`);
    expect(res.status).toBe(422);
  });
});
