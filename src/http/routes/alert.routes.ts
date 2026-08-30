import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { actorFromRequest } from '../actor.js';
import { requireRole } from '../middleware/auth.js';
import { pruneUndefined } from '../../lib/objects.js';
import { ALERT_STATUSES, ALERT_TYPES } from '../../domain/enums.js';
import { listAlerts } from '../../repositories/alerts.repo.js';
import { listOnCallSchedules } from '../../repositories/escalation-policies.repo.js';
import {
  createEscalationPolicy,
  createMaintenanceWindow,
  deleteMaintenanceWindow,
  getEscalationPolicyById,
  listEscalationPolicies,
  listMaintenanceWindows,
  updateEscalationPolicy,
} from '../../services/alert/policy.service.js';

export const alertRouter: Router = Router();

const idParam = z.string().uuid();
const admin = requireRole('ADMIN');
const canOperate = requireRole('OPERATOR', 'ADMIN');

/* --- alerts (read) ----------------------------------------------------- */

const alertQuery = z.object({
  incidentId: z.string().uuid().optional(),
  apiId: z.string().uuid().optional(),
  status: z.enum(ALERT_STATUSES).optional(),
  alertType: z.enum(ALERT_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

alertRouter.get('/alerts', async (req: Request, res: Response) => {
  const alerts = await listAlerts(pruneUndefined(alertQuery.parse(req.query)));
  res.json({ data: alerts, count: alerts.length });
});

/* --- escalation policies --------------------------------------------- */

const policyBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  tiers: z.array(z.unknown()),
});

alertRouter.get('/escalation-policies', async (_req: Request, res: Response) => {
  res.json({ data: await listEscalationPolicies() });
});

alertRouter.get('/escalation-policies/:id', async (req: Request, res: Response) => {
  res.json({ data: await getEscalationPolicyById(idParam.parse(req.params.id)) });
});

alertRouter.post('/escalation-policies', admin, async (req: Request, res: Response) => {
  const body = policyBody.parse(req.body);
  const policy = await createEscalationPolicy(body, actorFromRequest(req));
  res.status(201).json({ data: policy });
});

alertRouter.put('/escalation-policies/:id', admin, async (req: Request, res: Response) => {
  const body = policyBody.partial().parse(req.body);
  const policy = await updateEscalationPolicy(
    idParam.parse(req.params.id),
    body,
    actorFromRequest(req),
  );
  res.json({ data: policy });
});

/* --- on-call schedules (read) --------------------------------------- */

alertRouter.get('/on-call-schedules', async (req: Request, res: Response) => {
  const teamId = z.string().uuid().optional().parse(req.query.teamId);
  res.json({ data: await listOnCallSchedules(teamId) });
});

/* --- maintenance windows ------------------------------------------- */

const windowBody = z.object({
  targetId: z.string().uuid().nullish(),
  startsAt: z.string(),
  endsAt: z.string(),
  reason: z.string().min(1).max(1000),
  ticketRef: z.string().max(200).nullish(),
});

alertRouter.get('/maintenance-windows', async (req: Request, res: Response) => {
  const includeExpired = req.query.includeExpired === 'true';
  res.json({ data: await listMaintenanceWindows(includeExpired) });
});

alertRouter.post('/maintenance-windows', canOperate, async (req: Request, res: Response) => {
  const body = windowBody.parse(req.body);
  const window = await createMaintenanceWindow(
    { ...body, targetId: body.targetId ?? null },
    actorFromRequest(req),
  );
  res.status(201).json({ data: window });
});

alertRouter.delete('/maintenance-windows/:id', canOperate, async (req: Request, res: Response) => {
  await deleteMaintenanceWindow(idParam.parse(req.params.id), actorFromRequest(req));
  res.status(204).send();
});
