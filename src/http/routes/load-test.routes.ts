import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { actorFromRequest } from '../actor.js';
import { env } from '../../config/index.js';
import { LOAD_AUTHORIZATION_STATUSES, LOAD_ENVIRONMENT_CLASSES } from '../../domain/enums.js';
import { validateDataSet } from '../../domain/load-test-data.js';
import {
  getKillSwitch,
  getTargetConfig,
  listAuthorizations,
} from '../../repositories/load-test-safety.repo.js';
import {
  engageKillSwitch,
  loadCeilings,
  loadHosts,
  proposeAuthorization,
  revoke,
  reviewProposal,
  runPreflight,
  setTargetConfig,
} from '../../services/loadtest/safety.service.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { LOAD_PROFILES, LOAD_RUN_STATUSES } from '../../domain/enums.js';
import { PlanConfigSchema, peakRps } from '../../domain/load-plan.js';
import * as runs from '../../repositories/load-test-runs.repo.js';
import { abortRun, createPlan, queueRun } from '../../services/loadtest/run.service.js';
import { effectiveRps } from '../../domain/load-plan.js';
import {
  buildLoadRunReport,
  buildReadinessReport,
  buildSuiteReport,
  listReports,
} from '../../services/loadtest/report/report.service.js';
import {
  REPORT_CONTENT_TYPES,
  renderCsv,
  renderHtml,
  renderPdf,
  renderXlsx,
} from '../../services/loadtest/report/exporters.js';
import type { AnyReport } from '../../services/loadtest/report/report.types.js';
import { CATALOG, catalogSummary } from '../../loadtest/contract/catalog.js';
import { CHECKS } from '../../loadtest/correctness/checks.js';
import { SECURITY_CHECKS } from '../../loadtest/correctness/security.js';
import * as correctness from '../../repositories/load-test-correctness.repo.js';
import { queueCorrectnessRun } from '../../services/loadtest/correctness.service.js';
import * as dataSets from '../../repositories/load-test-data-sets.repo.js';
import { createValidatedDataSet, removeDataSet } from '../../services/loadtest/data-set.service.js';
import { PACKS, packById, packSummary, planFromPack } from '../../loadtest/packs/packs.js';

/**
 * Load-testing safety surface (Phase 21). Nothing here generates traffic — it
 * classifies targets, manages four-eyes authorizations, exposes the kill switch
 * and answers "would this run be allowed, and if not why?".
 */
export const loadTestRouter: Router = Router();

const idParam = z.string().uuid();
const canPlan = requireRole('ADMIN', 'OPERATOR', 'DEVELOPER');
/** Read-only views of plans, runs, packs and the catalog — also for the roles that review results. */
const canView = requireRole('ADMIN', 'OPERATOR', 'DEVELOPER', 'COMPLIANCE', 'MANAGEMENT');
const adminOnly = requireRole('ADMIN');

loadTestRouter.get('/load-tests/safety/status', canPlan, async (_req, res: Response) => {
  const kill = await getKillSwitch();
  res.json({
    data: {
      enabled: env().LOAD_TEST_ENABLED,
      killSwitch: kill,
      ceilings: loadCeilings(),
      hostCounts: {
        production: loadHosts().production.length,
        sandbox: loadHosts().sandbox.length,
        mock: loadHosts().mock.length,
      },
      realSideEffectMaxRps: env().LOAD_TEST_REAL_SIDE_EFFECT_MAX_RPS,
    },
  });
});

/* ── Target classification ─────────────────────────────────────────────── */

loadTestRouter.get(
  '/load-tests/targets/:apiId/config',
  canPlan,
  async (req: Request, res: Response) => {
    const config = await getTargetConfig(idParam.parse(req.params.apiId));
    if (!config) throw new NotFoundError('Target has no load-test classification');
    res.json({ data: config });
  },
);

const configBody = z.object({
  environmentClass: z.enum(LOAD_ENVIRONMENT_CLASSES),
  hasRealSideEffects: z.boolean().default(false),
});

loadTestRouter.put(
  '/load-tests/targets/:apiId/config',
  adminOnly,
  async (req: Request, res: Response) => {
    const body = configBody.parse(req.body);
    const saved = await setTargetConfig(
      idParam.parse(req.params.apiId),
      body.environmentClass,
      body.hasRealSideEffects,
      actorFromRequest(req),
    );
    res.json({ data: saved });
  },
);

/* ── Authorizations (four-eyes) ────────────────────────────────────────── */

const proposeBody = z.object({
  apiId: z.string().uuid(),
  reference: z.string().min(3).max(200),
  scope: z.string().min(3).max(2000),
  windowStart: z.coerce.date(),
  windowEnd: z.coerce.date(),
  maxRps: z.number().int().positive(),
  maxVus: z.number().int().positive(),
  maxDurationSeconds: z.number().int().positive(),
  allowRealSideEffects: z.boolean().default(false),
});

loadTestRouter.post(
  '/load-tests/authorizations',
  requireRole('ADMIN', 'OPERATOR'),
  async (req: Request, res: Response) => {
    const created = await proposeAuthorization(proposeBody.parse(req.body), actorFromRequest(req));
    res.status(201).json({ data: created });
  },
);

const listQuery = z.object({
  apiId: z.string().uuid().optional(),
  status: z.enum(LOAD_AUTHORIZATION_STATUSES).optional(),
});

loadTestRouter.get('/load-tests/authorizations', canPlan, async (req: Request, res: Response) => {
  res.json({ data: await listAuthorizations(listQuery.parse(req.query)) });
});

const reviewBody = z.object({ note: z.string().max(1000).optional() });

for (const [path, decision] of [
  ['approve', 'APPROVED'],
  ['reject', 'REJECTED'],
] as const) {
  loadTestRouter.post(
    `/load-tests/authorizations/:id/${path}`,
    adminOnly,
    async (req: Request, res: Response) => {
      const { note } = reviewBody.parse(req.body ?? {});
      res.json({
        data: await reviewProposal(
          idParam.parse(req.params.id),
          decision,
          note ?? null,
          actorFromRequest(req),
        ),
      });
    },
  );
}

loadTestRouter.post(
  '/load-tests/authorizations/:id/revoke',
  adminOnly,
  async (req: Request, res: Response) => {
    const { reason } = z.object({ reason: z.string().min(3).max(1000) }).parse(req.body);
    res.json({ data: await revoke(idParam.parse(req.params.id), reason, actorFromRequest(req)) });
  },
);

/* ── Preflight, kill switch, data validation ───────────────────────────── */

const preflightBody = z.object({
  apiId: z.string().uuid(),
  rps: z.number().positive(),
  vus: z.number().int().positive(),
  durationSeconds: z.number().int().positive(),
  mutating: z.boolean().default(true),
});

/** Dry-run of the safety gate. Never starts anything. */
loadTestRouter.post(
  '/load-tests/safety/preflight',
  canPlan,
  async (req: Request, res: Response) => {
    const body = preflightBody.parse(req.body);
    const decision = await runPreflight(body.apiId, {
      rps: body.rps,
      vus: body.vus,
      durationSeconds: body.durationSeconds,
      mutating: body.mutating,
    });
    res.json({ data: decision });
  },
);

loadTestRouter.post('/load-tests/kill-switch', adminOnly, async (req: Request, res: Response) => {
  const { reason } = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
  res.json({ data: await engageKillSwitch(true, reason, actorFromRequest(req)) });
});

loadTestRouter.delete('/load-tests/kill-switch', adminOnly, async (req: Request, res: Response) => {
  res.json({ data: await engageKillSwitch(false, null, actorFromRequest(req)) });
});

const dataSetBody = z.object({
  name: z.string().max(200).optional(),
  environment: z.string().optional(),
  records: z.array(z.unknown()).max(50_000),
});

loadTestRouter.post('/load-tests/data-sets/validate', canPlan, (req: Request, res: Response) => {
  const body = dataSetBody.parse(req.body);
  const approvedCardFixtures = env()
    .LOAD_TEST_APPROVED_CARD_FIXTURES.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  res.json({ data: validateDataSet(body, { approvedCardFixtures }) });
});

/* ── Plans & runs (Phase 23) ───────────────────────────────────────────── */

const canRun = requireRole('ADMIN', 'OPERATOR');

const planBody = z.object({
  apiId: z.string().uuid(),
  name: z.string().min(2).max(200),
  config: z.unknown(),
});

loadTestRouter.post('/load-tests/plans', canPlan, async (req: Request, res: Response) => {
  const body = planBody.parse(req.body);
  res
    .status(201)
    .json({ data: await createPlan({ ...body, config: body.config }, actorFromRequest(req)) });
});

loadTestRouter.get('/load-tests/plans', canView, async (req: Request, res: Response) => {
  const { apiId } = z.object({ apiId: z.string().uuid().optional() }).parse(req.query);
  const plans = await runs.listPlans(apiId);
  res.json({
    data: plans.map((p) => ({ ...p, peakRps: peakRps(PlanConfigSchema.parse(p.config)) })),
  });
});

loadTestRouter.get('/load-tests/plans/:id', canView, async (req: Request, res: Response) => {
  const plan = await runs.getPlan(idParam.parse(req.params.id));
  if (!plan) throw new NotFoundError('Plan not found');
  res.json({ data: { ...plan, peakRps: peakRps(PlanConfigSchema.parse(plan.config)) } });
});

/** Judges the plan's peak against the safety gate; queues the run only if allowed. */
loadTestRouter.post('/load-tests/plans/:id/runs', canRun, async (req: Request, res: Response) => {
  const run = await queueRun(idParam.parse(req.params.id), actorFromRequest(req));
  res.status(202).json({ data: run });
});

const runsQuery = z.object({
  planId: z.string().uuid().optional(),
  apiId: z.string().uuid().optional(),
  status: z.enum(LOAD_RUN_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

loadTestRouter.get('/load-tests/runs', canView, async (req: Request, res: Response) => {
  const q = runsQuery.parse(req.query);
  const list = await runs.listRuns({ planId: q.planId, apiId: q.apiId, limit: q.limit });
  res.json({ data: q.status ? list.filter((r) => r.status === q.status) : list });
});

loadTestRouter.get('/load-tests/runs/:id', canView, async (req: Request, res: Response) => {
  const run = await runs.getRun(idParam.parse(req.params.id));
  if (!run) throw new NotFoundError('Run not found');
  res.json({ data: run });
});

/** Time-bucketed (5s) throughput/latency series — poll this while a run is live. */
loadTestRouter.get('/load-tests/runs/:id/metrics', canView, async (req: Request, res: Response) => {
  const id = idParam.parse(req.params.id);
  if (!(await runs.getRun(id))) throw new NotFoundError('Run not found');
  res.json({ data: await runs.listMetrics(id) });
});

loadTestRouter.post('/load-tests/runs/:id/abort', canRun, async (req: Request, res: Response) => {
  const { reason } = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
  res.json({ data: await abortRun(idParam.parse(req.params.id), reason, actorFromRequest(req)) });
});

/* ── Data sets & scenario packs (Phase 24) ─────────────────────────────── */

const dataSetBodySchema = z.object({
  name: z.string().min(2).max(200),
  environment: z.enum(['mock', 'sandbox', 'staging']),
  description: z.string().max(1000).optional(),
  records: z.array(z.unknown()).min(1).max(50_000),
});

/** Validates against the test-data rules and stores ONLY if clean. */
loadTestRouter.post('/load-tests/data-sets', canPlan, async (req: Request, res: Response) => {
  const body = dataSetBodySchema.parse(req.body);
  res.status(201).json({ data: await createValidatedDataSet(body, actorFromRequest(req)) });
});

loadTestRouter.get('/load-tests/data-sets', canPlan, async (_req: Request, res: Response) => {
  res.json({ data: await dataSets.listDataSets() });
});

loadTestRouter.get('/load-tests/data-sets/:id', canPlan, async (req: Request, res: Response) => {
  const ds = await dataSets.getDataSet(idParam.parse(req.params.id));
  if (!ds) throw new NotFoundError('Data set not found');
  res.json({ data: ds });
});

loadTestRouter.delete('/load-tests/data-sets/:id', canRun, async (req: Request, res: Response) => {
  await removeDataSet(idParam.parse(req.params.id), actorFromRequest(req));
  res.status(204).end();
});

loadTestRouter.get('/load-tests/packs', canView, (_req: Request, res: Response) => {
  res.json({ data: PACKS.map(packSummary) });
});

loadTestRouter.get('/load-tests/packs/:id', canView, (req: Request, res: Response) => {
  const pack = packById(String(req.params.id));
  if (!pack) throw new NotFoundError('Pack not found');
  res.json({
    data: {
      ...packSummary(pack),
      // Full example records (to copy/edit) and the plan this pack would create with defaults.
      exampleDataSets: pack.exampleDataSets,
      planPreview: planFromPack(pack, {}),
    },
  });
});

/** Creates a ready-to-use data set from a pack's documented fixtures. */
loadTestRouter.post(
  '/load-tests/packs/:id/example-datasets/:name',
  canPlan,
  async (req: Request, res: Response) => {
    const pack = packById(String(req.params.id));
    if (!pack) throw new NotFoundError('Pack not found');
    const ex = pack.exampleDataSets.find((d) => d.name === String(req.params.name));
    if (!ex) throw new NotFoundError('Example data set not found');
    if (ex.needsEdit) {
      throw new ValidationError(
        'This example contains placeholders. Fetch the pack, edit the records, and POST /load-tests/data-sets.',
      );
    }
    const created = await createValidatedDataSet(
      {
        name: ex.name,
        environment: ex.environment,
        description: ex.description,
        records: ex.records,
      },
      actorFromRequest(req),
    );
    res.status(201).json({ data: created });
  },
);

const packPlanBody = z.object({
  apiId: z.string().uuid(),
  name: z.string().min(2).max(200).optional(),
  dataSetId: z.string().uuid().optional(),
  profile: z.enum(LOAD_PROFILES).optional(),
  targetRps: z.number().positive().optional(),
  durationSeconds: z.number().int().positive().optional(),
  maxVus: z.number().int().positive().optional(),
  batchSize: z.number().int().min(1).max(100).optional(),
});

/** Instantiates a pack into a plan (data-set fields and safety flags are checked). */
loadTestRouter.post('/load-tests/packs/:id/plans', canPlan, async (req: Request, res: Response) => {
  const pack = packById(String(req.params.id));
  if (!pack) throw new NotFoundError('Pack not found');
  const { apiId, name, ...params } = packPlanBody.parse(req.body);
  const config = planFromPack(pack, params);
  const plan = await createPlan({ apiId, name: name ?? pack.title, config }, actorFromRequest(req));
  res.status(201).json({ data: { ...plan, effectiveRps: effectiveRps(config) } });
});

/* ── API catalog & correctness suite (Phase 25) ────────────────────────── */

/** Every documented iSmartPay endpoint and whether/how it can be load tested. */
loadTestRouter.get('/load-tests/api-catalog', canView, (_req: Request, res: Response) => {
  res.json({ data: { summary: catalogSummary(), endpoints: CATALOG } });
});

loadTestRouter.get('/load-tests/correctness-checks', canView, (_req: Request, res: Response) => {
  res.json({
    data: CHECKS.map((c) => ({
      id: c.id,
      title: c.title,
      controls: c.controls,
      requires: c.requires,
    })),
  });
});

const correctnessBody = z.object({
  apiId: z.string().uuid(),
  checks: z.array(z.string()).max(50).optional(),
});

/** Queues a correctness suite; it goes through the same safety gate as a load run. */
loadTestRouter.post('/load-tests/correctness-runs', canRun, async (req: Request, res: Response) => {
  const body = correctnessBody.parse(req.body);
  const run = await queueCorrectnessRun(body.apiId, body.checks, actorFromRequest(req));
  res.status(202).json({ data: run });
});

loadTestRouter.get('/load-tests/correctness-runs', canView, async (req: Request, res: Response) => {
  const q = z
    .object({
      apiId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    })
    .parse(req.query);
  res.json({ data: await correctness.listCorrectnessRuns({ ...q, suite: 'correctness' }) });
});

loadTestRouter.get(
  '/load-tests/correctness-runs/:id',
  canView,
  async (req: Request, res: Response) => {
    const run = await correctness.getCorrectnessRun(idParam.parse(req.params.id));
    if (!run) throw new NotFoundError('Correctness run not found');
    res.json({ data: run });
  },
);

/* ── Security suite (Phase 26) ─────────────────────────────────────────── */

/** OWASP API Security Top 10 (2023) checks the suite runs. */
loadTestRouter.get('/load-tests/security-checks', canView, (_req: Request, res: Response) => {
  res.json({
    data: SECURITY_CHECKS.map((c) => ({
      id: c.id,
      title: c.title,
      owasp: c.owasp,
      controls: c.controls,
      requires: c.requires,
    })),
  });
});

/** Queues the security suite; same safety gate and worker as every other run. */
loadTestRouter.post('/load-tests/security-runs', canRun, async (req: Request, res: Response) => {
  const body = correctnessBody.parse(req.body);
  const run = await queueCorrectnessRun(body.apiId, body.checks, actorFromRequest(req), 'security');
  res.status(202).json({ data: run });
});

loadTestRouter.get('/load-tests/security-runs', canView, async (req: Request, res: Response) => {
  const q = z
    .object({
      apiId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    })
    .parse(req.query);
  res.json({ data: await correctness.listCorrectnessRuns({ ...q, suite: 'security' }) });
});

loadTestRouter.get(
  '/load-tests/security-runs/:id',
  canView,
  async (req: Request, res: Response) => {
    const run = await correctness.getCorrectnessRun(idParam.parse(req.params.id));
    if (!run || run.suite !== 'security') throw new NotFoundError('Security run not found');
    res.json({ data: run });
  },
);

/* ── Reports (Phase 27) ────────────────────────────────────────────────── */

/** Business teams (COMPLIANCE, MANAGEMENT) read reports; only operators start runs. */
const canReport = requireRole('ADMIN', 'OPERATOR', 'DEVELOPER', 'COMPLIANCE', 'MANAGEMENT');

const reportQuery = z.object({
  format: z.enum(['json', 'html', 'xlsx', 'csv', 'pdf']).default('json'),
  /** CSV only: which table to export (Objectives, Findings, Time series, Checks, Gates, …). */
  table: z.string().max(40).optional(),
});

/** Sends a report in the requested format. HTML is served as a download with a no-script CSP. */
async function sendReport(
  res: Response,
  report: AnyReport,
  q: z.infer<typeof reportQuery>,
): Promise<void> {
  const base = `${report.meta.kind}-report-${report.meta.id.slice(0, 8)}`;
  if (q.format === 'json') {
    res.json({ data: report });
    return;
  }
  const type = REPORT_CONTENT_TYPES[q.format];
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${base}.${q.format}"`);
  if (q.format === 'html') {
    // Inline styles only; never scripts. The report escapes every dynamic value as well.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    );
    res.send(renderHtml(report));
  } else if (q.format === 'csv') {
    res.send(renderCsv(report, q.table));
  } else if (q.format === 'xlsx') {
    res.send(await renderXlsx(report));
  } else {
    res.send(await renderPdf(report));
  }
}

/** Index of every load, correctness and security run with its verdict. */
loadTestRouter.get('/load-tests/reports', canReport, async (req: Request, res: Response) => {
  const q = z
    .object({
      apiId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(40),
    })
    .parse(req.query);
  res.json({ data: await listReports({ ...(q.apiId ? { apiId: q.apiId } : {}), limit: q.limit }) });
});

loadTestRouter.get(
  '/load-tests/runs/:id/report',
  canReport,
  async (req: Request, res: Response) => {
    await sendReport(
      res,
      await buildLoadRunReport(idParam.parse(req.params.id)),
      reportQuery.parse(req.query),
    );
  },
);

for (const suite of ['correctness', 'security'] as const) {
  loadTestRouter.get(
    `/load-tests/${suite}-runs/:id/report`,
    canReport,
    async (req: Request, res: Response) => {
      const report = await buildSuiteReport(idParam.parse(req.params.id));
      if (report.suite !== suite) throw new NotFoundError(`${suite} run not found`);
      await sendReport(res, report, reportQuery.parse(req.query));
    },
  );
}

/** Gate-based production-readiness for one target, from the latest evidence. */
loadTestRouter.get(
  '/load-tests/readiness/:apiId',
  canReport,
  async (req: Request, res: Response) => {
    await sendReport(
      res,
      await buildReadinessReport(idParam.parse(req.params.apiId)),
      reportQuery.parse(req.query),
    );
  },
);
