import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { checkDbHealth, closePool, query } from '../lib/db.js';
import { resetEnvCache } from '../config/index.js';
import { resetRateLimiters } from './middleware/rate-limit.js';
import { hashPassword } from '../lib/crypto/passwords.js';
import { createUser } from '../repositories/users.repo.js';
import { signWebhook } from '../loadtest/contract/ismartpay.js';

const dbUp = (await checkDbHealth()).ok;

process.env['AUTH_ENABLED'] = 'true';
process.env['JWT_SECRET'] = 'e2e-jwt-secret-at-least-sixteen-chars';
resetEnvCache();
resetRateLimiters();

const { createApp } = await import('./app.js');
const app = createApp();

async function login(email: string, roles: string[]): Promise<string> {
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
const auth = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });

const SECRET = 'whsec_test_value_123456';
const now = (): string => String(Math.floor(Date.now() / 1000));
const body = (id: string): string =>
  JSON.stringify({
    id,
    type: 'collection.settled',
    createdAt: new Date().toISOString(),
    data: { reference: `LT-abc-${id}`, payerMsisdn: '233000000001', amount: '1.00' },
  });

async function deliver(
  slug: string,
  id: string,
  raw: string,
  over: { secret?: string; timestamp?: string; omit?: boolean } = {},
): Promise<number> {
  const ts = over.timestamp ?? now();
  const sig = signWebhook(over.secret ?? SECRET, id, ts, raw);
  const r = request(app).post(`/hooks/loadtest/${slug}`).set('content-type', 'application/json');
  if (!over.omit)
    r.set('webhook-id', id).set('webhook-timestamp', ts).set('webhook-signature', sig);
  return (await r.send(raw)).status;
}

describe.skipIf(!dbUp)('webhook sink (public receiver + admin API)', () => {
  let admin: string;
  let viewer: string;
  let slug: string;
  let sinkId: string;

  beforeAll(async () => {
    await query(`DELETE FROM load_test_webhook_sinks`);
    await query(`DELETE FROM users WHERE email LIKE 'whs-%'`);
    admin = await login('whs-admin@test.local', ['ADMIN']);
    viewer = await login('whs-viewer@test.local', ['VIEWER']);
  });
  afterAll(async () => {
    await query(`DELETE FROM load_test_webhook_sinks`);
    await query(`DELETE FROM users WHERE email LIKE 'whs-%'`);
    await closePool();
  });

  it('is role-gated to manage, and a viewer cannot read it', async () => {
    expect(
      (
        await request(app)
          .post('/api/v1/load-tests/webhook-sinks')
          .set(auth(viewer))
          .send({ label: 'nope' })
      ).status,
    ).toBe(403);
    expect((await request(app).get('/api/v1/load-tests/webhook-sinks')).status).toBe(401);
    const res = await request(app)
      .post('/api/v1/load-tests/webhook-sinks')
      .set(auth(admin))
      .send({ label: 'sandbox load test' });
    expect(res.status).toBe(201);
    expect(res.body.data.slug).toHaveLength(48);
    expect(res.body.data.hasSecret).toBe(false);
    slug = res.body.data.slug as string;
    sinkId = res.body.data.id as string;
  });

  it('cannot verify before a secret exists: answers 503 (so the sender retries) and records why', async () => {
    expect(await deliver(slug, 'evt_0', body('evt_0'))).toBe(503);
    const d = await request(app)
      .get(`/api/v1/load-tests/webhook-sinks/${sinkId}/deliveries`)
      .set(auth(admin));
    expect(d.body.data[0].reason).toMatch(/no signing secret/);
    expect(d.body.data[0].signatureOk).toBe(false);
  });

  it('never returns or lists the secret', async () => {
    const put = await request(app)
      .put(`/api/v1/load-tests/webhook-sinks/${sinkId}/secret`)
      .set(auth(admin))
      .send({ secret: SECRET });
    expect(put.status).toBe(200);
    expect(put.body.data.hasSecret).toBe(true);
    const all = JSON.stringify([
      put.body,
      (await request(app).get('/api/v1/load-tests/webhook-sinks').set(auth(admin))).body,
    ]);
    expect(all).not.toContain(SECRET);
    const stored = await query(`SELECT encrypted_secret::text AS s FROM load_test_webhook_sinks`);
    expect(JSON.stringify(stored.rows)).not.toContain(SECRET);
  });

  it('accepts a correctly signed delivery, counts retries of the same event, and masks the body', async () => {
    const raw = body('evt_1');
    expect(await deliver(slug, 'evt_1', raw)).toBe(200);
    expect(await deliver(slug, 'evt_1', raw)).toBe(200); // retry / duplicate
    const d = (
      await request(app)
        .get(`/api/v1/load-tests/webhook-sinks/${sinkId}/deliveries`)
        .set(auth(admin))
    ).body.data as {
      eventId: string;
      attempt: number;
      signatureOk: boolean;
      bodyMasked: string;
      reference: string;
    }[];
    const mine = d
      .filter((x) => x.eventId === 'evt_1')
      .map((x) => x.attempt)
      .sort();
    expect(mine).toEqual([1, 2]);
    expect(d.find((x) => x.eventId === 'evt_1')!.signatureOk).toBe(true);
    expect(d.find((x) => x.eventId === 'evt_1')!.reference).toBe('LT-abc-evt_1');
    expect(d.find((x) => x.eventId === 'evt_1')!.bodyMasked).not.toContain('233000000001');
  });

  it('rejects forged, unsigned, tampered and stale deliveries with 401', async () => {
    expect(await deliver(slug, 'evt_2', body('evt_2'), { secret: 'wrong-secret-value' })).toBe(401);
    expect(await deliver(slug, 'evt_3', body('evt_3'), { omit: true })).toBe(401);
    const tampered = body('evt_4');
    const ts = now();
    const sig = signWebhook(SECRET, 'evt_4', ts, tampered);
    const t = await request(app)
      .post(`/hooks/loadtest/${slug}`)
      .set('content-type', 'application/json')
      .set('webhook-id', 'evt_4')
      .set('webhook-timestamp', ts)
      .set('webhook-signature', sig)
      .send(tampered.replace('1.00', '9999.00'));
    expect(t.status).toBe(401);
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    expect(await deliver(slug, 'evt_5', body('evt_5'), { timestamp: stale })).toBe(401);
  });

  it('hides unknown and disabled endpoints, and deleting a sink removes its deliveries', async () => {
    expect(await deliver('0'.repeat(48), 'evt_6', body('evt_6'))).toBe(404);
    const del = await request(app)
      .delete(`/api/v1/load-tests/webhook-sinks/${sinkId}`)
      .set(auth(admin));
    expect(del.status).toBe(204);
    expect(await deliver(slug, 'evt_7', body('evt_7'))).toBe(404);
    const left = await query(`SELECT 1 FROM load_test_webhook_deliveries`);
    expect(left.rowCount).toBe(0);
  });
});
