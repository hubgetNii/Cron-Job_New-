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
process.env['LOAD_TEST_ENABLED'] = 'true';
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

const auth = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });

async function seedTarget(name: string, url: string, moneyMoving: boolean, env: string) {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron, is_money_moving, environment)
     VALUES ($1, 'payment_initiation', 'CRITICAL', $2, '*/5 * * * *', $3, $4) RETURNING id`,
    [name, url, moneyMoving, env],
  );
  return rows[0]!.id;
}

const codesOf = (res: { body: unknown }): string[] =>
  (res.body as { data: { violations: { code: string }[] } }).data.violations.map((v) => v.code);

const plan = { rps: 20, vus: 50, durationSeconds: 300 };
const inHours = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString();

let admin1: string;
let admin2: string;
let operator: string;
let viewer: string;
let sandboxTarget: string;
let prodTarget: string;

describe.skipIf(!dbUp)('load-test safety foundation (Phase 21)', () => {
  beforeAll(async () => {
    await query(`DELETE FROM load_test_plans`);
    await query(`DELETE FROM load_test_data_sets`);
    await query(`DELETE FROM load_test_authorizations`);
    await query(`DELETE FROM refresh_tokens`);
    await query(`DELETE FROM users`);
    await query(`DELETE FROM monitored_apis WHERE name LIKE 'lt-e2e-%'`);
    admin1 = await loginToken('lt-admin1@test.local', ['ADMIN']);
    admin2 = await loginToken('lt-admin2@test.local', ['ADMIN']);
    operator = await loginToken('lt-op@test.local', ['OPERATOR']);
    viewer = await loginToken('lt-viewer@test.local', ['VIEWER']);
    sandboxTarget = await seedTarget(
      'lt-e2e-sandbox',
      'https://stgdeveloper-api.ismartghana.com/v1/collections',
      true,
      'sandbox',
    );
    prodTarget = await seedTarget(
      'lt-e2e-prod',
      'https://api.ismartghana.com/v1/payouts',
      true,
      'production',
    );
  });

  afterAll(async () => {
    await query(`UPDATE load_test_control SET kill_switch = false, reason = NULL`);
    await query(`DELETE FROM load_test_plans`);
    await query(`DELETE FROM load_test_data_sets`);
    await query(`DELETE FROM load_test_authorizations`);
    await query(`DELETE FROM monitored_apis WHERE name LIKE 'lt-e2e-%'`);
    await query(`DELETE FROM users`);
    await closePool();
    process.env['AUTH_ENABLED'] = 'false';
    delete process.env['LOAD_TEST_ENABLED'];
    resetEnvCache();
    resetRateLimiters();
  });

  it('denies by default and requires roles', async () => {
    const noConfig = await request(app)
      .post('/api/v1/load-tests/safety/preflight')
      .set(auth(operator))
      .send({ apiId: sandboxTarget, ...plan });
    expect(noConfig.status).toBe(200);
    expect(noConfig.body.data.allowed).toBe(false);
    expect(codesOf(noConfig)).toContain('NO_CONFIG');

    const viewerRes = await request(app)
      .post('/api/v1/load-tests/safety/preflight')
      .set(auth(viewer))
      .send({ apiId: sandboxTarget, ...plan });
    expect(viewerRes.status).toBe(403);
  });

  it('refuses to classify a production target as SANDBOX, and only ADMIN may classify', async () => {
    const asOperator = await request(app)
      .put(`/api/v1/load-tests/targets/${sandboxTarget}/config`)
      .set(auth(operator))
      .send({ environmentClass: 'SANDBOX' });
    expect(asOperator.status).toBe(403);

    const downgrade = await request(app)
      .put(`/api/v1/load-tests/targets/${prodTarget}/config`)
      .set(auth(admin1))
      .send({ environmentClass: 'SANDBOX' });
    expect(downgrade.status).toBe(422);
  });

  it('never authorizes money-moving load on PRODUCTION', async () => {
    await request(app)
      .put(`/api/v1/load-tests/targets/${prodTarget}/config`)
      .set(auth(admin1))
      .send({ environmentClass: 'PRODUCTION' })
      .expect(200);
    const res = await request(app)
      .post('/api/v1/load-tests/authorizations')
      .set(auth(operator))
      .send({
        apiId: prodTarget,
        reference: 'HOO-1',
        scope: 'prod payouts',
        windowStart: inHours(-1),
        windowEnd: inHours(2),
        maxRps: 1,
        maxVus: 1,
        maxDurationSeconds: 60,
      });
    expect(res.status).toBe(422);
  });

  it('runs the four-eyes authorization flow and unlocks preflight', async () => {
    await request(app)
      .put(`/api/v1/load-tests/targets/${sandboxTarget}/config`)
      .set(auth(admin1))
      .send({ environmentClass: 'SANDBOX', hasRealSideEffects: false })
      .expect(200);

    // Caps above the SANDBOX ceiling are refused at proposal time.
    const tooBig = await request(app)
      .post('/api/v1/load-tests/authorizations')
      .set(auth(operator))
      .send({
        apiId: sandboxTarget,
        reference: 'HOO-2',
        scope: 'sandbox collections',
        windowStart: inHours(-1),
        windowEnd: inHours(8),
        maxRps: 99999,
        maxVus: 10,
        maxDurationSeconds: 60,
      });
    expect(tooBig.status).toBe(422);

    const proposed = await request(app)
      .post('/api/v1/load-tests/authorizations')
      .set(auth(admin1))
      .send({
        apiId: sandboxTarget,
        reference: 'HOO-2',
        scope: 'sandbox collections',
        windowStart: inHours(-1),
        windowEnd: inHours(8),
        maxRps: 20,
        maxVus: 50,
        maxDurationSeconds: 600,
      });
    expect(proposed.status).toBe(201);
    const id = proposed.body.data.id as string;

    // PENDING does not unlock anything.
    let pre = await request(app)
      .post('/api/v1/load-tests/safety/preflight')
      .set(auth(operator))
      .send({ apiId: sandboxTarget, ...plan });
    expect(codesOf(pre)).toContain('AUTH_NOT_APPROVED');

    // The proposer cannot approve their own authorization.
    const self = await request(app)
      .post(`/api/v1/load-tests/authorizations/${id}/approve`)
      .set(auth(admin1))
      .send({});
    expect(self.status).toBe(403);

    await request(app)
      .post(`/api/v1/load-tests/authorizations/${id}/approve`)
      .set(auth(admin2))
      .send({ note: 'approved by Head of Operations' })
      .expect(200);

    pre = await request(app)
      .post('/api/v1/load-tests/safety/preflight')
      .set(auth(operator))
      .send({ apiId: sandboxTarget, ...plan });
    expect(pre.body.data).toMatchObject({ allowed: true, effectiveClass: 'SANDBOX' });

    // Over the authorized cap → refused again.
    const over = await request(app)
      .post('/api/v1/load-tests/safety/preflight')
      .set(auth(operator))
      .send({ apiId: sandboxTarget, ...plan, rps: 150 });
    expect(codesOf(over)).toContain('AUTH_CAP_RPS');

    // Revocation takes effect immediately.
    await request(app)
      .post(`/api/v1/load-tests/authorizations/${id}/revoke`)
      .set(auth(admin2))
      .send({ reason: 'window cancelled' })
      .expect(200);
    pre = await request(app)
      .post('/api/v1/load-tests/safety/preflight')
      .set(auth(operator))
      .send({ apiId: sandboxTarget, ...plan });
    expect(pre.body.data.allowed).toBe(false);
  });

  it('honours the DB kill switch', async () => {
    await request(app)
      .post('/api/v1/load-tests/kill-switch')
      .set(auth(admin1))
      .send({ reason: 'drill' })
      .expect(200);
    const pre = await request(app)
      .post('/api/v1/load-tests/safety/preflight')
      .set(auth(operator))
      .send({ apiId: sandboxTarget, ...plan });
    expect(codesOf(pre)).toContain('KILL_SWITCH');
    await request(app).delete('/api/v1/load-tests/kill-switch').set(auth(admin1)).expect(200);
  });

  it('plans and runs: validates plans, queues through the gate, aborts, never leaks credentials', async () => {
    const mockTarget = await seedTarget(
      'lt-e2e-mock',
      'http://127.0.0.1:4010/v1/wallet',
      false,
      'sandbox',
    );
    await request(app)
      .put(`/api/v1/load-tests/targets/${mockTarget}/config`)
      .set(auth(admin1))
      .send({ environmentClass: 'MOCK' })
      .expect(200);

    // Credential headers are refused at plan creation.
    const bad = await request(app)
      .post('/api/v1/load-tests/plans')
      .set(auth(operator))
      .send({
        apiId: mockTarget,
        name: 'bad',
        config: {
          profile: 'LOAD',
          targetRps: 10,
          durationSeconds: 30,
          maxVus: 20,
          headers: { Authorization: 'Bearer x' },
        },
      });
    expect(bad.status).toBe(422);

    const created = await request(app)
      .post('/api/v1/load-tests/plans')
      .set(auth(operator))
      .send({
        apiId: mockTarget,
        name: 'mock load',
        config: {
          profile: 'SPIKE',
          targetRps: 10,
          durationSeconds: 60,
          maxVus: 50,
          spikeMultiplier: 5,
        },
      });
    expect(created.status).toBe(201);
    expect(created.body.data.peakRps).toBe(50);
    const planId = created.body.data.id as string;

    // A viewer cannot start runs; an operator can.
    await request(app)
      .post(`/api/v1/load-tests/plans/${planId}/runs`)
      .set(auth(viewer))
      .expect(403);
    const queued = await request(app)
      .post(`/api/v1/load-tests/plans/${planId}/runs`)
      .set(auth(operator));
    expect(queued.status).toBe(202);
    expect(queued.body.data).toMatchObject({ status: 'QUEUED', effectiveClass: 'MOCK' });
    const runId = queued.body.data.id as string;

    // The sandbox target has no live authorization (revoked earlier) → refused with reasons.
    const sbPlan = await request(app)
      .post('/api/v1/load-tests/plans')
      .set(auth(operator))
      .send({
        apiId: sandboxTarget,
        name: 'sb',
        config: { profile: 'SMOKE', method: 'POST', targetRps: 1, durationSeconds: 10, maxVus: 2 },
      });
    const refused = await request(app)
      .post(`/api/v1/load-tests/plans/${sbPlan.body.data.id as string}/runs`)
      .set(auth(operator));
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('AUTH_');

    // Abort a queued run: closed immediately, listed, metrics endpoint answers.
    const aborted = await request(app)
      .post(`/api/v1/load-tests/runs/${runId}/abort`)
      .set(auth(operator))
      .send({ reason: 'changed my mind' });
    expect(aborted.status).toBe(200);
    expect(aborted.body.data.status).toBe('ABORTED');
    await request(app)
      .post(`/api/v1/load-tests/runs/${runId}/abort`)
      .set(auth(operator))
      .send({ reason: 'again' })
      .expect(409);
    const metrics = await request(app)
      .get(`/api/v1/load-tests/runs/${runId}/metrics`)
      .set(auth(viewer));
    expect(metrics.status).toBe(403);
    const list = await request(app)
      .get(`/api/v1/load-tests/runs?planId=${planId}`)
      .set(auth(operator));
    expect(list.body.data).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toMatch(/password|secret/i);
  });

  it('data sets and packs: validated on write, never echo values, feed plans through the gate', async () => {
    const tag = { test_data: true, test_case_id: 'E2E-1', environment: 'sandbox' };

    // A set with a real-looking PAN and a clear-text CVV is rejected and NOT stored.
    const bad = await request(app)
      .post('/api/v1/load-tests/data-sets')
      .set(auth(operator))
      .send({
        name: 'e2e-bad',
        environment: 'sandbox',
        records: [{ ...tag, pan: '5555555555554444', cvv: '123' }],
      });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).not.toContain('5555555555554444');
    expect(JSON.stringify(bad.body)).toContain('REAL_PAN_SUSPECTED');
    const listed = await request(app).get('/api/v1/load-tests/data-sets').set(auth(operator));
    expect(JSON.stringify(listed.body)).not.toContain('e2e-bad');

    // Packs: list, detail (with fixtures + plan preview), and a viewer is refused.
    const packs = await request(app).get('/api/v1/load-tests/packs').set(auth(operator));
    expect(packs.status).toBe(200);
    const packList = packs.body.data as { id: string; exampleDataSets: object[] }[];
    expect(packList.map((p) => p.id)).toContain('payout-batch-telecel');
    expect(packList[0]!.exampleDataSets[0]).not.toHaveProperty('records'); // records only in the detail view
    await request(app).get('/api/v1/load-tests/packs').set(auth(viewer)).expect(403);
    const detail = await request(app)
      .get('/api/v1/load-tests/packs/payouts-momo-telecel')
      .set(auth(operator));
    expect(detail.body.data.planPreview).toMatchObject({
      method: 'POST',
      path: '/v1/payouts',
      moneyMoving: true,
    });
    expect(detail.body.data.exampleDataSets[0].records[0].destinationMsisdn).toBe('233000000001');

    // Without a data set the pack refuses to become a plan.
    const target = await seedTarget('lt-e2e-packs', 'http://127.0.0.1:4010', false, 'sandbox');
    await request(app)
      .put(`/api/v1/load-tests/targets/${target}/config`)
      .set(auth(admin1))
      .send({ environmentClass: 'MOCK' })
      .expect(200);
    const noData = await request(app)
      .post('/api/v1/load-tests/packs/payouts-momo-telecel/plans')
      .set(auth(operator))
      .send({ apiId: target });
    expect(noData.status).toBe(422);

    // The documented-fixture data set can be created in one call, then used.
    const ds = await request(app)
      .post('/api/v1/load-tests/packs/payouts-momo-telecel/example-datasets/payouts-success')
      .set(auth(operator));
    expect(ds.status).toBe(201);
    const plan = await request(app)
      .post('/api/v1/load-tests/packs/payout-batch-telecel/plans')
      .set(auth(operator))
      .send({
        apiId: target,
        dataSetId: ds.body.data.id,
        batchSize: 20,
        targetRps: 2,
        durationSeconds: 60,
      });
    expect(plan.status).toBe(201);
    expect(plan.body.data).toMatchObject({ effectiveRps: 40 });
    expect(plan.body.data.config).toMatchObject({ fanout: 20, packId: 'payout-batch-telecel' });

    // Placeholder examples cannot be created blindly.
    const needsEdit = await request(app)
      .post('/api/v1/load-tests/packs/wallet-transfer/example-datasets/transfer-own-handle')
      .set(auth(operator));
    expect(needsEdit.status).toBe(422);

    // A data set in use cannot be deleted.
    const del = await request(app)
      .delete(`/api/v1/load-tests/data-sets/${ds.body.data.id}`)
      .set(auth(operator));
    expect(del.status).toBe(409);
  });

  it('API catalog and correctness endpoints: complete, role-gated, honest about risk', async () => {
    const cat = await request(app).get('/api/v1/load-tests/api-catalog').set(auth(operator));
    expect(cat.status).toBe(200);
    const eps = cat.body.data.endpoints as {
      method: string;
      path: string;
      loadTest: string;
      realSideEffects: boolean;
      moneyMoving: boolean;
    }[];
    expect(eps.length).toBeGreaterThan(35);
    const utility = eps.find((e) => e.method === 'POST' && e.path === '/v1/utility-purchases')!;
    expect([utility.loadTest, utility.realSideEffects]).toEqual(['caution', true]);
    const settle = eps.find((e) => e.method === 'POST' && e.path === '/v1/settlements')!;
    expect(settle.loadTest).toBe('excluded');
    expect(cat.body.data.summary.byStatus.ready).toBeGreaterThan(5);
    await request(app).get('/api/v1/load-tests/api-catalog').set(auth(viewer)).expect(403);

    const checks = await request(app)
      .get('/api/v1/load-tests/correctness-checks')
      .set(auth(operator));
    expect((checks.body.data as { id: string }[]).map((c) => c.id)).toContain(
      'idem.concurrent-twins',
    );

    // Unknown target / unclassified target are refused before anything runs.
    await request(app)
      .post('/api/v1/load-tests/correctness-runs')
      .set(auth(viewer))
      .send({ apiId: sandboxTarget })
      .expect(403);
    const refused = await request(app)
      .post('/api/v1/load-tests/correctness-runs')
      .set(auth(operator))
      .send({ apiId: sandboxTarget });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('AUTH_');
  });

  it('security suite endpoints: OWASP-labelled, role-gated, behind the safety gate', async () => {
    const checks = await request(app).get('/api/v1/load-tests/security-checks').set(auth(operator));
    expect(checks.status).toBe(200);
    const list = checks.body.data as { id: string; owasp: string }[];
    expect(list.length).toBeGreaterThanOrEqual(17);
    expect(list.every((c) => /^API\d{1,2}:2023/.test(c.owasp))).toBe(true);
    expect(list.map((c) => c.id)).toContain('bola.cross-account-access');
    await request(app).get('/api/v1/load-tests/security-checks').set(auth(viewer)).expect(403);

    await request(app)
      .post('/api/v1/load-tests/security-runs')
      .set(auth(viewer))
      .send({ apiId: sandboxTarget })
      .expect(403);
    const refused = await request(app)
      .post('/api/v1/load-tests/security-runs')
      .set(auth(operator))
      .send({ apiId: sandboxTarget });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('AUTH_');
    const runs = await request(app).get('/api/v1/load-tests/security-runs').set(auth(operator));
    expect(runs.status).toBe(200);
  });

  it('validates a data set without echoing offending values', async () => {
    const res = await request(app)
      .post('/api/v1/load-tests/data-sets/validate')
      .set(auth(operator))
      .send({
        environment: 'sandbox',
        records: [
          {
            test_data: true,
            test_case_id: 'CARD-001',
            environment: 'sandbox',
            pan: '5555555555554444',
            cvv: '123',
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(false);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('5555555555554444');
    expect(text).toContain('REAL_PAN_SUSPECTED');
    expect(text).toContain('SECRET_FIELD');
  });
});
