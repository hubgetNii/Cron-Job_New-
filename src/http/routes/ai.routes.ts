import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { requireAi, aiConfigured } from '../../services/ai/client.js';
import { analyzeIncident, getIncidentInsights } from '../../services/ai/analysis.service.js';
import { detectAnomalies, scanAndRecordAnomalies } from '../../services/ai/anomaly.service.js';
import { latestInsightsFor, recentAnomalyInsights } from '../../repositories/ai-insights.repo.js';

/**
 * AI intelligence endpoints. Everything here is ADVISORY — responses are labelled
 * assistive and carry a confidence score; none of these routes mutate an
 * incident, a health check or an alert (see vault: "AI Allowed Uses and Guardrails").
 */
export const aiRouter: Router = Router();

const idParam = z.string().uuid();
const canOperate = requireRole('OPERATOR', 'ADMIN');

aiRouter.get('/ai/status', (_req: Request, res: Response) => {
  res.json({ data: { configured: aiConfigured() } });
});

aiRouter.get('/incidents/:id/ai', async (req: Request, res: Response) => {
  const insights = await getIncidentInsights(idParam.parse(req.params.id));
  res.json({ data: insights, advisory: true });
});

aiRouter.post('/incidents/:id/ai/analyze', canOperate, async (req: Request, res: Response) => {
  requireAi();
  const analysis = await analyzeIncident(idParam.parse(req.params.id));
  res.json({ data: analysis, advisory: true });
});

aiRouter.get('/targets/:id/anomalies', async (req: Request, res: Response) => {
  const anomalies = await detectAnomalies([idParam.parse(req.params.id)]);
  res.json({ data: anomalies, advisory: true });
});

const anomalyQuery = z.object({
  hours: z.coerce.number().int().min(1).max(720).optional(),
});

aiRouter.get('/anomalies', async (req: Request, res: Response) => {
  const { hours } = anomalyQuery.parse(req.query);
  const insights = await recentAnomalyInsights(hours ?? 24);
  res.json({ data: insights, advisory: true });
});

aiRouter.get('/targets/:id/ai', async (req: Request, res: Response) => {
  const insights = await latestInsightsFor('target', idParam.parse(req.params.id));
  res.json({ data: insights, advisory: true });
});

aiRouter.post('/anomalies/scan', requireRole('ADMIN'), async (_req: Request, res: Response) => {
  const recorded = await scanAndRecordAnomalies();
  res.json({ data: { recorded }, advisory: true });
});
