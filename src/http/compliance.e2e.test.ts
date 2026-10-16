import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { checkDbHealth, closePool, query } from '../lib/db.js';
import { resetEnvCache } from '../config/index.js';
import { resetRateLimiters } from './middleware/rate-limit.js';
import { hashPassword } from '../lib/crypto/passwords.js';
import { createUser } from '../repositories/users.repo.js';
import { PlanConfigSchema } from '../domain/load-plan.js';
import { expectedRequests } from '../domain/load-slo.js';
import { CHECK_IDS } from '../loadtest/correctness/checks.js';
import { SECURITY_CHECK_IDS } from '../loadtest/correctness/security.js';
import { assemblePack, verifyPack } from '../loadtest/compliance/pack.js';

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
const bin = (res: request.Response, cb: (e: Error | null, b: Buffer) => void): void => {
  const c: Buffer[] = [];
  res.on('data', (d: Buffer) => c.push(d));
  res.on('end', () => cb(null, Buffer.concat(c)));
};

const summary = (over: Record<string, unknown> = {}) => ({
  totalRequests: 900,
  failedRequests: 0,
  errorRate: 0,
  statusCounts: { '202': 900 },
  errorClasses: {
    server5xx: 0,
    rateLimited429: 0,
    client4xx: 0,
    networkOrTimeout: 0,
    unexpectedOther: 0,
  },
  latencyMs: { avg: 300, p50: 250, p90: 500, p95: 640, p99: 900, max: 1500 },
  achievedAvgRps: 9,
  peakRps: 11,
  maxSustainedRps: 11,
  droppedIterations: 0,
  generatorSaturated: false,
  authRequests: 2,
  activeSeconds: 100,
  ...over,
});
const cfg = (over: Record<string, unknown> = {}) =>
  PlanConfigSchema.parse({
    profile: 'LOAD',
    method: 'POST',
    path: '/v1/payouts',
    moneyMoving: true,
    targetRps: 10,
    durationSeconds: 100,
    maxVus: 50,
    ...over,
  });

async function addLoad(
  apiId: string,
  profile: 'LOAD' | 'SOAK' | 'SPIKE' | 'BREAKPOINT',
  cls: string,
): Promise<void> {
  const c = cfg({ profile, durationSeconds: profile === 'LOAD' || profile === 'SOAK' ? 100 : 60 });
  const plan = await query<{ id: string }>(
    `INSERT INTO load_test_plans (api_id, name, profile, config) VALUES ($1,$2,$3,$4) RETURNING id`,
    [apiId, `${profile} plan`, profile, JSON.stringify(c)],
  );
  const total = profile === 'SPIKE' ? expectedRequests(c) : 900;
  const fin = new Date(Date.now() - 3_600_000);
  await query(
    `INSERT INTO load_test_runs (plan_id, api_id, status, plan_snapshot, effective_class, summary, finished_reason, queued_at, started_at, finished_at)
     VALUES ($1,$2,'COMPLETED',$3,$4,$5,'completed',$6,$6,$6)`,
    [
      plan.rows[0]!.id,
      apiId,
      JSON.stringify({
        config: c,
        target: {
          name: 'T',
          url: 'https://stg.example',
          isMoneyMoving: false,
          environment: 'sandbox',
        },
        peakRps: 10,
      }),
      cls,
      JSON.stringify(summary({ totalRequests: total })),
      fin,
    ],
  );
}

const result = (id: string, status: 'PASS' | 'SKIPPED') => ({
  id,
  title: id,
  controls: ['idempotency'],
  status,
  assertions: status === 'PASS' ? [{ name: 'a fact held', pass: true }] : [],
  warnings: 0,
  durationMs: 4,
  note: status === 'SKIPPED' ? 'not run here' : undefined,
  evidence:
    status === 'PASS'
      ? [
          {
            at: new Date().toISOString(),
            method: 'GET',
            path: '/v1/wallet',
            status: 200,
            ms: 5,
            requestId: 'req_abc',
            idempotencyKey: null,
          },
        ]
      : [],
});

async function addSuite(
  apiId: string,
  suite: 'correctness' | 'security',
  cls: string,
  skip: (id: string) => boolean,
): Promise<string> {
  const ids = suite === 'security' ? SECURITY_CHECK_IDS : CHECK_IDS;
  const results = ids.map((id) => result(id, skip(id) ? 'SKIPPED' : 'PASS'));
  const passed = results.filter((r) => r.status === 'PASS').length;
  const sum = {
    total: ids.length,
    passed,
    failed: 0,
    errored: 0,
    skipped: ids.length - passed,
    warnings: 0,
    assertions: { total: passed, failed: 0 },
    verdict: 'PASS',
  };
  const fin = new Date(Date.now() - 1_800_000);
  const r = await query<{ id: string }>(
    `INSERT INTO load_test_correctness_runs (api_id, status, suite, mode, effective_class, results, summary, queued_at, started_at, finished_at)
     VALUES ($1,'COMPLETED',$2,$3,$4,$5,$6,$7,$7,$7) RETURNING id`,
    [
      apiId,
      suite,
      cls === 'MOCK' ? 'simulator' : 'live',
      cls,
      JSON.stringify(results),
      JSON.stringify(sum),
      fin,
    ],
  );
  return r.rows[0]!.id;
}

let target: string;
let admin: string;
let compliance: string;
let management: string;
let operator: string;
let viewer: string;

type A = {
  controls: {
    control: { id: string };
    status: string;
    review: { status: string; reviewer?: string };
  }[];
  basis: string;
  frameworks: { framework: string; reviewedApproved: number }[];
};

describe.skipIf(!dbUp)('compliance evidence (Phase 28)', () => {
  beforeAll(async () => {
    await query(`TRUNCATE compliance_reviews, compliance_evidence_packs`);
    await query(`DELETE FROM load_test_plans`);
    await query(`DELETE FROM load_test_correctness_runs`);
    await query(`DELETE FROM refresh_tokens`);
    await query(`DELETE FROM users`);
    await query(`DELETE FROM monitored_apis WHERE name LIKE 'cmp-e2e-%'`);
    admin = await login('cmp-admin@test.local', ['ADMIN']);
    compliance = await login('cmp-comp@test.local', ['COMPLIANCE']);
    management = await login('cmp-mgmt@test.local', ['MANAGEMENT']);
    operator = await login('cmp-op@test.local', ['OPERATOR']);
    viewer = await login('cmp-view@test.local', ['VIEWER']);
    target = (
      await query<{ id: string }>(
        `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron, environment) VALUES ('cmp-e2e-sandbox','internal','LOW','https://stgdeveloper-api.ismartghana.com','*/5 * * * *','sandbox') RETURNING id`,
      )
    ).rows[0]!.id;

    // Realistic evidence: real sandbox runs skip what needs a simulator / a second account; a simulator run covered everything.
    for (const p of ['LOAD', 'SOAK', 'SPIKE', 'BREAKPOINT'] as const)
      await addLoad(target, p, 'SANDBOX');
    const simOnly = (id: string): boolean => id.startsWith('sim.') || id.startsWith('webhook.');
    await addSuite(target, 'correctness', 'SANDBOX', simOnly);
    await addSuite(target, 'security', 'SANDBOX', (id) =>
      [
        'auth.token-expiry-enforced',
        'authz.permission-enforced',
        'bola.cross-account-access',
      ].includes(id),
    );
    await addSuite(target, 'correctness', 'MOCK', () => false);
    await addSuite(target, 'security', 'MOCK', () => false);
  }, 60_000);

  afterAll(async () => {
    await query(`TRUNCATE compliance_reviews, compliance_evidence_packs`);
    await query(`DELETE FROM load_test_plans`);
    await query(`DELETE FROM load_test_correctness_runs`);
    await query(`DELETE FROM monitored_apis WHERE name LIKE 'cmp-e2e-%'`);
    await query(`DELETE FROM users`);
    await closePool();
    process.env['AUTH_ENABLED'] = 'false';
    resetEnvCache();
    resetRateLimiters();
  });

  it('serves the draft control library to readers only', async () => {
    const r = await request(app).get('/api/v1/compliance/library').set(auth(management));
    expect(r.status).toBe(200);
    expect(r.body.data.libraryVersion).toMatch(/draft/);
    expect(r.body.data.controls.length).toBeGreaterThan(30);
    expect(r.body.data.disclaimer).toContain('not a certification');
    await request(app).get('/api/v1/compliance/library').set(auth(viewer)).expect(403);
  });

  it('assesses honestly: real evidence counts, simulator-only is labelled, gaps are gaps', async () => {
    const r = await request(app).get(`/api/v1/compliance/assessment/${target}`).set(auth(operator));
    expect(r.status).toBe(200);
    const a = r.body.data.assessment as A;
    const st = (id: string): string => a.controls.find((c) => c.control.id === id)!.status;
    expect(a.basis).toBe('mixed');
    expect(st('OWASP-API3')).toBe('EVIDENCED'); // passed on the real sandbox
    expect(st('OWASP-API1')).toBe('SIMULATOR_ONLY'); // real run skipped it; only the simulator proved it
    expect(st('OWASP-API5')).toBe('SIMULATOR_ONLY');
    expect(st('BOG-DUPLICATE')).toBe('PARTIAL'); // real checks pass; the timeout case is simulator-only
    expect(st('BOG-RESILIENCE')).toBe('EVIDENCED'); // LOAD + SPIKE passed on the sandbox
    expect(st('PCI-11.4')).toBe('OUT_OF_SCOPE'); // a pen test is not something this programme provides
    expect(a.controls.every((c) => c.review.status === 'DRAFT')).toBe(true);
    await request(app).get(`/api/v1/compliance/assessment/${target}`).set(auth(viewer)).expect(403);
    await request(app)
      .get('/api/v1/compliance/assessment/00000000-0000-4000-8000-000000000000')
      .set(auth(operator))
      .expect(404);
  });

  it('exports the matrix as HTML, XLSX, CSV and PDF', async () => {
    const base = `/api/v1/compliance/assessment/${target}`;
    const html = await request(app).get(`${base}?format=html`).set(auth(management));
    expect(html.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    );
    expect(html.text).toContain('Compliance evidence matrix');
    expect(html.text).toContain('not a certification');
    expect(html.text).toContain('unverified reference'); // Bank of Ghana references are flagged
    expect(html.text).toContain('Not covered by this evidence');
    expect(html.text).not.toMatch(/<script/i);
    const csv = await request(app).get(`${base}?format=csv`).set(auth(management));
    expect(csv.text.split('\n')[0]).toContain(
      'framework,id,reference,referenceVerified,control,status',
    );
    const xlsx = await request(app)
      .get(`${base}?format=xlsx`)
      .set(auth(management))
      .buffer(true)
      .parse(bin);
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    const pdf = await request(app)
      .get(`${base}?format=pdf`)
      .set(auth(management))
      .buffer(true)
      .parse(bin);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('separation of duties: only COMPLIANCE can sign off; reviews are append-only and versioned', async () => {
    const url = '/api/v1/compliance/controls/OWASP-API3/review';
    const body = {
      decision: 'APPROVED',
      note: 'Mapping confirmed against the OWASP API3:2023 text.',
    };
    await request(app).post(url).set(auth(admin)).send(body).expect(403); // ADMIN may not approve
    await request(app).post(url).set(auth(operator)).send(body).expect(403);
    await request(app).post(url).set(auth(management)).send(body).expect(403);
    await request(app)
      .post('/api/v1/compliance/controls/NOPE-1/review')
      .set(auth(compliance))
      .send(body)
      .expect(404);
    expect(
      (
        await request(app)
          .post(url)
          .set(auth(compliance))
          .send({ ...body, note: 'short' })
      ).status,
    ).toBe(422);

    const ok = await request(app).post(url).set(auth(compliance)).send(body);
    expect(ok.status).toBe(201);
    let a = (await request(app).get(`/api/v1/compliance/assessment/${target}`).set(auth(operator)))
      .body.data.assessment as A;
    expect(a.controls.find((c) => c.control.id === 'OWASP-API3')!.review).toMatchObject({
      status: 'APPROVED',
      reviewer: 'user:cmp-comp@test.local',
    });
    expect(a.frameworks.find((f) => f.framework === 'OWASP_API_2023')!.reviewedApproved).toBe(1);

    // The newest decision wins.
    await request(app)
      .post(url)
      .set(auth(compliance))
      .send({ decision: 'NEEDS_CHANGE', note: 'Add the payout-batch endpoint to the evidence.' })
      .expect(201);
    a = (await request(app).get(`/api/v1/compliance/assessment/${target}`).set(auth(operator))).body
      .data.assessment as A;
    expect(a.controls.find((c) => c.control.id === 'OWASP-API3')!.review.status).toBe(
      'NEEDS_CHANGE',
    );

    // A review made against an OLDER library version no longer counts.
    await query(
      `INSERT INTO compliance_reviews (control_id, library_version, decision, note, reviewer_id, reviewer_label) VALUES ('OWASP-API8','2025.01-old','APPROVED','Approved against the old mapping.', gen_random_uuid(), 'user:old@x.test')`,
    );
    a = (await request(app).get(`/api/v1/compliance/assessment/${target}`).set(auth(operator))).body
      .data.assessment as A;
    expect(a.controls.find((c) => c.control.id === 'OWASP-API8')!.review.status).toBe(
      'STALE_REVIEW',
    );

    const list = await request(app)
      .get('/api/v1/compliance/reviews?controlId=OWASP-API3')
      .set(auth(management));
    expect(list.body.data).toHaveLength(2);

    // The database itself refuses to rewrite or erase a sign-off.
    await expect(query(`UPDATE compliance_reviews SET note = 'rewritten history'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(query(`DELETE FROM compliance_reviews`)).rejects.toThrow(/append-only/);
  });

  it('issues a tamper-evident evidence pack, and verifies it', async () => {
    await request(app)
      .post('/api/v1/compliance/packs')
      .set(auth(management))
      .send({ apiId: target })
      .expect(403);
    await request(app)
      .post('/api/v1/compliance/packs')
      .set(auth(operator))
      .send({ apiId: target })
      .expect(403);
    const made = await request(app)
      .post('/api/v1/compliance/packs')
      .set(auth(admin))
      .send({ apiId: target });
    expect(made.status).toBe(201);
    const meta = made.body.data as {
      id: string;
      manifestSha256: string;
      zipSha256: string;
      fileCount: number;
      basis: string;
    };
    expect(meta).toMatchObject({ basis: 'mixed' });
    expect(meta.fileCount).toBeGreaterThan(12);

    const list = await request(app).get('/api/v1/compliance/packs').set(auth(management));
    expect((list.body.data as { id: string }[]).map((p) => p.id)).toContain(meta.id);
    expect(JSON.stringify(list.body)).not.toContain('"zip"'); // metadata only; the bytes come from /download

    const dl = await request(app)
      .get(`/api/v1/compliance/packs/${meta.id}/download`)
      .set(auth(management))
      .buffer(true)
      .parse(bin);
    expect(dl.headers['content-type']).toBe('application/zip');
    expect(dl.headers['x-manifest-sha256']).toBe(meta.manifestSha256);
    const zip = new Uint8Array(dl.body as Buffer);

    const local = verifyPack(zip);
    expect(local).toMatchObject({ ok: true, problems: [], manifestSha256: meta.manifestSha256 });
    const names = Object.keys(unzipSync(zip));
    for (const n of [
      'README.txt',
      'manifest.json',
      'SHA256SUMS',
      'assessment/compliance-matrix.html',
      'assessment/compliance-matrix.xlsx',
      'assessment/compliance-matrix.csv',
      'assessment/controls-library.json',
      'assessment/reviews.json',
      'reports/readiness.html',
    ]) {
      expect(names, n).toContain(n);
    }
    expect(names.some((n) => n.startsWith('evidence/security-') && n.endsWith('-calls.csv'))).toBe(
      true,
    );
    expect(names.some((n) => /^reports\/load-spike-/.test(n))).toBe(true);
    expect(local.manifest!.sourceRuns.map((s) => s.kind)).toEqual(
      expect.arrayContaining(['security', 'correctness', 'load/LOAD', 'load/BREAKPOINT']),
    );
    // TRACEABILITY: every run the matrix cites is in the pack, and the simulator runs are labelled as such.
    const matrix = JSON.parse(
      new TextDecoder().decode(unzipSync(zip)['assessment/compliance-matrix.json']),
    ) as { assessment: { controls: { items: { runId?: string }[] }[] } };
    const cited = new Set(
      matrix.assessment.controls.flatMap((c) => c.items.map((i) => i.runId).filter(Boolean)),
    );
    const inPack = new Set(local.manifest!.sourceRuns.map((s) => s.id));
    expect(cited.size).toBeGreaterThan(3);
    for (const id of cited)
      expect(inPack.has(id as string), `cited run ${id} is missing from the pack`).toBe(true);
    expect(local.manifest!.sourceRuns.some((s) => !s.isReal)).toBe(true); // simulator evidence is cited…
    expect(names.some((n) => n.includes('-simulator'))).toBe(true); // …and its files say so
    const reviewsJson = JSON.parse(
      new TextDecoder().decode(unzipSync(zip)['assessment/reviews.json']),
    ) as unknown[];
    expect(reviewsJson.length).toBeGreaterThanOrEqual(2); // sign-offs travel with the pack

    const send = (bytes: Uint8Array) =>
      request(app)
        .post('/api/v1/compliance/packs/verify')
        .set(auth(operator))
        .set('Content-Type', 'application/zip')
        .send(Buffer.from(bytes));

    // 1. Untouched → AUTHENTIC (intact AND recorded when issued).
    const good = await send(zip);
    expect(good.body.data).toMatchObject({
      verdict: 'AUTHENTIC',
      ok: true,
      issued: { id: meta.id, targetName: 'cmp-e2e-sandbox' },
    });

    // 2. Edited after issue → TAMPERED.
    const files = unzipSync(zip);
    const victim = Object.keys(files).find(
      (n) => n.startsWith('reports/security-') && n.endsWith('.json'),
    )!;
    files[victim] = strToU8(new TextDecoder().decode(files[victim]).replace('PASS', 'FAIL'));
    const bad = await send(zipSync(files));
    expect(bad.body.data.verdict).toBe('TAMPERED');
    expect((bad.body.data.problems as string[]).join('\n')).toContain(`Content changed: ${victim}`);

    // 3. A well-formed pack this system never issued → intact, but NOT issued here.
    const foreign = assemblePack({
      packId: '22222222-2222-4222-8222-222222222222',
      generatedAt: new Date(),
      generatedBy: 'someone else',
      toolVersion: '9',
      libraryVersion: 'x',
      target: { id: 't', name: 'T', host: 'h' },
      basis: 'real',
      disclaimer: 'd',
      sourceRuns: [],
      coverage: {},
      files: [{ path: 'a.txt', data: 'hello' }],
    });
    expect((await send(foreign.zip)).body.data.verdict).toBe('INTACT_BUT_NOT_ISSUED_HERE');

    // 4. Garbage / empty.
    expect((await send(strToU8('this is not a zip'))).body.data.verdict).toBe('INVALID');
    await request(app)
      .post('/api/v1/compliance/packs/verify')
      .set(auth(operator))
      .set('Content-Type', 'application/zip')
      .send(Buffer.alloc(0))
      .expect(422);
    await request(app)
      .post('/api/v1/compliance/packs/verify')
      .set(auth(viewer))
      .set('Content-Type', 'application/zip')
      .send(Buffer.from(zip))
      .expect(403);

    // The issued record cannot be edited or erased.
    await expect(
      query(`UPDATE compliance_evidence_packs SET manifest_sha256 = 'forged'`),
    ).rejects.toThrow(/append-only/);
    await expect(query(`DELETE FROM compliance_evidence_packs`)).rejects.toThrow(/append-only/);
  }, 120_000);

  it('an empty target yields an honest pack of gaps, not a fake clean one', async () => {
    const empty = (
      await query<{ id: string }>(
        `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron, environment) VALUES ('cmp-e2e-empty','internal','LOW','https://stg.example','*/5 * * * *','sandbox') RETURNING id`,
      )
    ).rows[0]!.id;
    const a = (await request(app).get(`/api/v1/compliance/assessment/${empty}`).set(auth(operator)))
      .body.data.assessment as A;
    expect(a.basis).toBe('none');
    expect(a.controls.filter((c) => c.status === 'EVIDENCED')).toHaveLength(0);
    expect(a.controls.filter((c) => c.status === 'NOT_TESTED').length).toBeGreaterThan(20);
    const made = await request(app)
      .post('/api/v1/compliance/packs')
      .set(auth(compliance))
      .send({ apiId: empty });
    expect(made.status).toBe(201);
    expect(made.body.data.basis).toBe('none');
  });
});
