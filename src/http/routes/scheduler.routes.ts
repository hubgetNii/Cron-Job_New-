import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pruneUndefined } from '../../lib/objects.js';
import {
  getJobRuns,
  getMissedRuns,
  getSchedulerStatus,
} from '../../services/scheduler/scheduler-status.service.js';

export const schedulerRouter: Router = Router();

const runsQuery = z.object({
  targetId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

schedulerRouter.get('/scheduler/status', async (_req: Request, res: Response) => {
  const status = await getSchedulerStatus();
  res.status(status.health === 'ok' ? 200 : 503).json({ data: status });
});

schedulerRouter.get('/scheduler/jobs', async (req: Request, res: Response) => {
  const runs = await getJobRuns(pruneUndefined(runsQuery.parse(req.query)));
  res.json({ data: runs, count: runs.length });
});

schedulerRouter.get('/scheduler/jobs/:targetId/runs', async (req: Request, res: Response) => {
  const targetId = z.string().uuid().parse(req.params.targetId);
  const runs = await getJobRuns({ targetId, limit: 200 });
  res.json({ data: runs, count: runs.length });
});

schedulerRouter.get('/scheduler/missed-runs', async (_req: Request, res: Response) => {
  const missed = await getMissedRuns();
  res.json({ data: missed, count: missed.length });
});
