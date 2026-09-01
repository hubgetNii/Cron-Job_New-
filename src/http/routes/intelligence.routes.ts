import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { classifyFailure } from '../../domain/failure-taxonomy.js';
import { recommendationFor } from '../../domain/recommendations.js';
import { buildRootCauseAnalysis, getStoredRca } from '../../services/intelligence/rca.service.js';
import type { CheckFailureType } from '../../domain/enums.js';
import { CHECK_FAILURE_TYPES } from '../../domain/enums.js';

/**
 * Intelligence layer (spec §7–9). Deterministic failure taxonomy, root-cause
 * analysis and recommendations. Everything here is ADVISORY — it never mutates
 * an incident's status or lifecycle.
 */
export const intelligenceRouter: Router = Router();

const idParam = z.string().uuid();
const canOperate = requireRole('OPERATOR', 'ADMIN');

/** Stored deterministic RCA for an incident (null until first computed). */
intelligenceRouter.get('/incidents/:id/rca', async (req: Request, res: Response) => {
  const rca = await getStoredRca(idParam.parse(req.params.id));
  res.json({ data: rca, advisory: true });
});

/** Recompute + persist the deterministic RCA. */
intelligenceRouter.post(
  '/incidents/:id/rca/recompute',
  canOperate,
  async (req: Request, res: Response) => {
    const rca = await buildRootCauseAnalysis(idParam.parse(req.params.id));
    res.json({ data: rca, advisory: true });
  },
);

/** Classify an arbitrary failure signature — useful for tooling / what-if. */
const classifyQuery = z.object({
  failureType: z.enum(CHECK_FAILURE_TYPES).optional(),
  httpStatus: z.coerce.number().int().min(100).max(599).optional(),
  errorMessage: z.string().max(2000).optional(),
  occurrences24h: z.coerce.number().int().min(1).max(1000).optional(),
});

intelligenceRouter.get('/intelligence/classify', (req: Request, res: Response) => {
  const q = classifyQuery.parse(req.query);
  const failureType: CheckFailureType | null = q.failureType ?? null;
  const classification = classifyFailure({
    failureType,
    httpStatus: q.httpStatus ?? null,
    errorMessage: q.errorMessage ?? null,
  });
  const recommendation = recommendationFor({
    category: classification.category,
    failureType,
    httpStatus: q.httpStatus ?? null,
    occurrences24h: q.occurrences24h ?? 1,
  });
  res.json({ data: { classification, recommendation }, advisory: true });
});
