import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { actorFromRequest, realUserId } from '../actor.js';
import { recordAudit } from '../../services/audit/audit.service.js';
import { allLatencyStats, latencyStats } from '../../services/observability/latency-stats.service.js';
import {
  deleteThresholds,
  getThresholds,
  upsertThresholds,
} from '../../repositories/latency-thresholds.repo.js';
import {
  getTraceByCheckId,
  revealRawTrace,
  searchTraces,
  type TraceRow,
} from '../../repositories/health-check-traces.repo.js';
import {
  getRunByHcId,
  listRuns,
  runServices,
} from '../../repositories/health-check-runs.repo.js';
import { rollUpRun } from '../../services/observability/health-check-run.service.js';
import { CHECK_FAILURE_TYPES, HEALTH_STATUSES } from '../../domain/enums.js';

/**
 * Observability — the searchable request/response trace log (spec §3–5, §16).
 *
 * Every response here is MASKED: Authorization, API keys, tokens, PINs, CVV and
 * card numbers are already `***MASKED***`. The true request/response is behind
 * `GET /observability/traces/:checkId/raw`, which is ADMIN-only and writes an
 * audit entry for every reveal.
 */
export const observabilityRouter: Router = Router();

const canView = requireRole('OPERATOR', 'ADMIN', 'DEVELOPER', 'COMPLIANCE');
const idParam = z.string().uuid();
const hcIdParam = z.string().regex(/^HC-\d{8}-\d{6}-\d{6}$/);

/* ── Latency intelligence (spec §6) ─────────────────────────────────────── */

const windowQuery = z.object({
  windowMinutes: z.coerce.number().int().min(5).max(10080).optional(),
});

observabilityRouter.get('/observability/latency', canView, async (req: Request, res: Response) => {
  const { windowMinutes } = windowQuery.parse(req.query);
  const stats = await allLatencyStats(windowMinutes);
  res.json({ data: stats, count: stats.length });
});

observabilityRouter.get(
  '/observability/latency/:apiId',
  canView,
  async (req: Request, res: Response) => {
    const { windowMinutes } = windowQuery.parse(req.query);
    res.json({ data: await latencyStats(idParam.parse(req.params.apiId), windowMinutes) });
  },
);

const thresholdBody = z.object({
  normalMs: z.number().int().positive(),
  degradedMs: z.number().int().positive(),
  criticalMs: z.number().int().positive(),
});

observabilityRouter.put(
  '/observability/latency/:apiId/thresholds',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const apiId = idParam.parse(req.params.apiId);
    const t = thresholdBody.parse(req.body);
    if (!(t.degradedMs > t.normalMs && t.criticalMs > t.degradedMs)) {
      res.status(422).json({
        error: { code: 'VALIDATION', message: 'need normalMs < degradedMs < criticalMs' },
      });
      return;
    }
    const before = await getThresholds(apiId);
    const row = await upsertThresholds(apiId, t, realUserId(req));
    await recordAudit({
      actor: actorFromRequest(req),
      action: 'latency_thresholds.set',
      entityType: 'monitored_api',
      entityId: apiId,
      summary: `Latency bands → ${t.normalMs}/${t.degradedMs}/${t.criticalMs} ms`,
      changes: { before, after: row },
    });
    res.json({ data: row });
  },
);

observabilityRouter.delete(
  '/observability/latency/:apiId/thresholds',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const apiId = idParam.parse(req.params.apiId);
    const removed = await deleteThresholds(apiId);
    if (removed) {
      await recordAudit({
        actor: actorFromRequest(req),
        action: 'latency_thresholds.cleared',
        entityType: 'monitored_api',
        entityId: apiId,
        summary: 'Reverted to class-default latency bands',
      });
    }
    res.status(removed ? 204 : 404).send();
  },
);

/* ── Health Check Runs (spec §2) ────────────────────────────────────────── */

observabilityRouter.get(
  '/observability/health-checks',
  canView,
  async (req: Request, res: Response) => {
    const limit = z.coerce.number().int().min(1).max(200).optional().parse(req.query.limit);
    const runs = await listRuns(limit ?? 50);
    res.json({ data: runs, count: runs.length });
  },
);

observabilityRouter.post(
  '/observability/health-checks/roll-up',
  requireRole('ADMIN', 'OPERATOR'),
  async (_req: Request, res: Response) => {
    const run = await rollUpRun();
    res.json({ data: run });
  },
);

observabilityRouter.get(
  '/observability/health-checks/:hcId',
  canView,
  async (req: Request, res: Response) => {
    const run = await getRunByHcId(hcIdParam.parse(req.params.hcId));
    if (!run) {
      res.status(404).json({ error: { message: 'No such health check run', code: 'NOT_FOUND' } });
      return;
    }
    const services = await runServices(run.id);
    res.json({ data: { ...run, services } });
  },
);

const searchQuery = z.object({
  apiId: z.string().uuid().optional(),
  healthStatus: z.enum(HEALTH_STATUSES).optional(),
  httpStatus: z.coerce.number().int().min(100).max(599).optional(),
  statusClass: z.enum(['2xx', '3xx', '4xx', '5xx']).optional(),
  failureType: z.enum(CHECK_FAILURE_TYPES).optional(),
  requestId: z.string().max(64).optional(),
  correlationId: z.string().max(128).optional(),
  q: z.string().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

function toFilters(q: z.infer<typeof searchQuery>) {
  return {
    ...(q.apiId ? { apiId: q.apiId } : {}),
    ...(q.healthStatus ? { healthStatus: q.healthStatus } : {}),
    ...(q.httpStatus != null ? { httpStatus: q.httpStatus } : {}),
    ...(q.statusClass ? { statusClass: q.statusClass } : {}),
    ...(q.failureType ? { failureType: q.failureType } : {}),
    ...(q.requestId ? { requestId: q.requestId } : {}),
    ...(q.correlationId ? { correlationId: q.correlationId } : {}),
    ...(q.q ? { q: q.q } : {}),
    ...(q.from ? { from: q.from } : {}),
    ...(q.to ? { to: q.to } : {}),
  };
}

observabilityRouter.get('/observability/traces', canView, async (req: Request, res: Response) => {
  const q = searchQuery.parse(req.query);
  const { rows, total } = await searchTraces({
    ...toFilters(q),
    limit: q.limit ?? 50,
    offset: q.offset ?? 0,
  });
  res.json({ data: rows, count: rows.length, total });
});

const csvCell = (v: string | number | null): string => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function tracesToCsv(rows: TraceRow[]): string {
  const header = [
    'checked_at',
    'request_id',
    'correlation_id',
    'service',
    'method',
    'url_masked',
    'http_status',
    'health_status',
    'failure_type',
    'response_time_ms',
    'response_bytes',
    'attempts',
  ];
  const lines = rows.map((r) =>
    [
      r.checkedAt,
      r.requestId,
      r.correlationId,
      r.targetName ?? r.apiId,
      r.requestMethod,
      r.requestUrlMasked,
      r.responseStatus,
      r.healthStatus,
      r.failureType,
      r.responseTimeMs,
      r.responseBytes,
      r.attempts,
    ]
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...lines].join('\n');
}

observabilityRouter.get(
  '/observability/traces/export',
  canView,
  async (req: Request, res: Response) => {
    const q = searchQuery.parse(req.query);
    const { rows } = await searchTraces({ ...toFilters(q), limit: 5000, offset: 0 });
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader(
      'content-disposition',
      `attachment; filename="observability-traces-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(tracesToCsv(rows));
  },
);

observabilityRouter.get(
  '/observability/traces/:checkId',
  canView,
  async (req: Request, res: Response) => {
    const trace = await getTraceByCheckId(idParam.parse(req.params.checkId));
    if (!trace) {
      res.status(404).json({ error: { message: 'No trace for that check', code: 'NOT_FOUND' } });
      return;
    }
    res.json({ data: trace });
  },
);

/** ADMIN-only reveal of the true (unmasked) request/response. Audited on every call. */
observabilityRouter.get(
  '/observability/traces/:checkId/raw',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const checkId = idParam.parse(req.params.checkId);
    const raw = await revealRawTrace(checkId);
    if (!raw) {
      res.status(404).json({ error: { message: 'No raw trace stored', code: 'NOT_FOUND' } });
      return;
    }
    await recordAudit({
      actor: actorFromRequest(req),
      action: 'observability.trace.reveal',
      entityType: 'health_check_trace',
      entityId: checkId,
      summary: `Revealed unmasked request/response for check ${checkId}`,
    });
    res.json({ data: raw, revealed: true });
  },
);
