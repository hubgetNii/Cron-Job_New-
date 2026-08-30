import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  getDashboardSummary,
  getPerformanceSeries,
  getRecentHealthChecks,
  getTargetStatusBoard,
} from '../../repositories/dashboard.repo.js';
import { getSchedulerStatus } from '../../services/scheduler/scheduler-status.service.js';

export const dashboardRouter: Router = Router();

dashboardRouter.get('/dashboard/summary', async (_req: Request, res: Response) => {
  const [summary, scheduler] = await Promise.all([getDashboardSummary(), getSchedulerStatus()]);
  res.json({ data: { ...summary, scheduler } });
});

dashboardRouter.get('/dashboard/performance', async (req: Request, res: Response) => {
  const hours = z.coerce.number().int().min(1).max(72).default(6).parse(req.query.hours);
  res.json({ data: await getPerformanceSeries(hours) });
});

dashboardRouter.get('/dashboard/targets', async (_req: Request, res: Response) => {
  res.json({ data: await getTargetStatusBoard() });
});

dashboardRouter.get('/health-checks/:targetId', async (req: Request, res: Response) => {
  const targetId = z.string().uuid().parse(req.params.targetId);
  const limit = z.coerce.number().int().min(1).max(500).default(120).parse(req.query.limit);
  res.json({ data: await getRecentHealthChecks(targetId, limit) });
});
