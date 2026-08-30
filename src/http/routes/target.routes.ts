import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { actorFromRequest } from '../actor.js';
import { pruneUndefined } from '../../lib/objects.js';
import {
  createTarget,
  deleteTarget,
  getTarget,
  listTargets,
  setTargetEnabled,
  testTarget,
  updateTarget,
} from '../../services/target/target.service.js';
import { ENDPOINT_CLASSES, ENVIRONMENTS } from '../../domain/enums.js';

export const targetRouter: Router = Router();

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

targetRouter.post('/targets', async (req: Request, res: Response) => {
  const target = await createTarget(req.body, actorFromRequest(req));
  res.status(201).json({ data: target });
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

targetRouter.put('/targets/:id', async (req: Request, res: Response) => {
  const target = await updateTarget(idParam.parse(req.params.id), req.body, actorFromRequest(req));
  res.json({ data: target });
});

targetRouter.delete('/targets/:id', async (req: Request, res: Response) => {
  await deleteTarget(idParam.parse(req.params.id), actorFromRequest(req));
  res.status(204).send();
});

targetRouter.post('/targets/:id/enable', async (req: Request, res: Response) => {
  const target = await setTargetEnabled(idParam.parse(req.params.id), true, actorFromRequest(req));
  res.json({ data: target });
});

targetRouter.post('/targets/:id/disable', async (req: Request, res: Response) => {
  const target = await setTargetEnabled(idParam.parse(req.params.id), false, actorFromRequest(req));
  res.json({ data: target });
});

targetRouter.post('/targets/:id/test', async (req: Request, res: Response) => {
  const outcome = await testTarget(idParam.parse(req.params.id), actorFromRequest(req));
  res.json({ data: outcome });
});
