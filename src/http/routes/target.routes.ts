import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { actorFromRequest } from '../actor.js';
import { requireRole } from '../middleware/auth.js';
import { pruneUndefined } from '../../lib/objects.js';
import {
  createTarget,
  deleteTarget,
  getTarget,
  listTargets,
  setTargetEnabled,
  testTarget,
  updateTarget,
  type TargetMutationResult,
} from '../../services/target/target.service.js';
import { ENDPOINT_CLASSES, ENVIRONMENTS } from '../../domain/enums.js';

export const targetRouter: Router = Router();

const canWrite = requireRole('DEVELOPER', 'ADMIN');
const canOperate = requireRole('OPERATOR', 'DEVELOPER', 'ADMIN');

function sendMutation(res: Response, result: TargetMutationResult, appliedStatus: number): void {
  if (result.status === 'pending_approval') {
    res.status(202).json({
      data: result.request,
      message: 'Money-moving change queued for four-eyes approval',
    });
  } else {
    res.status(appliedStatus).json({ data: result.target });
  }
}

const idParam = z.string().uuid();

const listQuery = z.object({
  environment: z.enum(ENVIRONMENTS).optional(),
  endpointClass: z.enum(ENDPOINT_CLASSES).optional(),
  isActive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  isMoneyMoving: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  teamId: z.string().uuid().optional(),
  tag: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

targetRouter.post('/targets', canWrite, async (req: Request, res: Response) => {
  sendMutation(res, await createTarget(req.body, actorFromRequest(req)), 201);
});

targetRouter.get('/targets', async (req: Request, res: Response) => {
  const filters = pruneUndefined(listQuery.parse(req.query));
  const targets = await listTargets(filters);
  res.json({ data: targets, count: targets.length });
});

targetRouter.get('/targets/:id', async (req: Request, res: Response) => {
  const target = await getTarget(idParam.parse(req.params.id));
  res.json({ data: target });
});

targetRouter.put('/targets/:id', canWrite, async (req: Request, res: Response) => {
  sendMutation(
    res,
    await updateTarget(idParam.parse(req.params.id), req.body, actorFromRequest(req)),
    200,
  );
});

targetRouter.delete('/targets/:id', requireRole('ADMIN'), async (req: Request, res: Response) => {
  await deleteTarget(idParam.parse(req.params.id), actorFromRequest(req));
  res.status(204).send();
});

targetRouter.post('/targets/:id/enable', canOperate, async (req: Request, res: Response) => {
  const target = await setTargetEnabled(idParam.parse(req.params.id), true, actorFromRequest(req));
  res.json({ data: target });
});

targetRouter.post('/targets/:id/disable', canOperate, async (req: Request, res: Response) => {
  const target = await setTargetEnabled(idParam.parse(req.params.id), false, actorFromRequest(req));
  res.json({ data: target });
});

targetRouter.post('/targets/:id/test', canOperate, async (req: Request, res: Response) => {
  const outcome = await testTarget(idParam.parse(req.params.id), actorFromRequest(req));
  res.json({ data: outcome });
});
