import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { actorFromRequest } from '../actor.js';
import { requireRole } from '../middleware/auth.js';
import { pruneUndefined } from '../../lib/objects.js';
import { ALERT_CHANNELS, ALERT_STATUSES, ALERT_TYPES } from '../../domain/enums.js';
import { listAlerts } from '../../repositories/alerts.repo.js';
import { channelFor } from '../../services/alert/channels.js';
import { FcmClient, getFcmClient } from '../../services/alert/fcm.js';
import { env } from '../../config/index.js';
import { ServiceUnavailableError } from '../../lib/errors.js';
import { recordAudit } from '../../services/audit/audit.service.js';
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

/* --- send a synthetic alert through a channel (ADMIN, for wiring up transports) */

const testAlertBody = z.object({
  channel: z.enum(ALERT_CHANNELS),
  recipient: z.string().min(1).max(4096).optional(),
  message: z.string().max(500).optional(),
});

alertRouter.post('/alerts/test', admin, async (req: Request, res: Response) => {
  const body = testAlertBody.parse(req.body ?? {});
  const outcome = await channelFor(body.channel).send({
    alertType: 'API_DOWN',
    severity: 'INFO',
    subject: body.message ?? `Test alert via ${body.channel}`,
    body: 'This is a test notification from the FinTech Cron Monitor. No incident is open.',
    recipient: body.recipient ?? 'ops',
    incidentNumber: null,
    targetName: null,
    payload: { test: true },
  });
  await recordAudit({
    actor: actorFromRequest(req),
    action: 'alert.test_sent',
    entityType: 'alert',
    summary: `Test alert via ${body.channel} → ${outcome.ok ? 'ok' : 'failed'} (${outcome.detail})`,
  });
  res.status(outcome.ok ? 200 : 502).json({ data: { channel: body.channel, ...outcome } });
});

/* --- FCM topic subscription (ADMIN) --------------------------------------- */

const topicBody = z.object({
  token: z.string().min(1).max(4096),
  topic: z.string().min(1).max(200).optional(),
});

alertRouter.post('/alerts/push/subscribe', admin, async (req: Request, res: Response) => {
  if (!FcmClient.configured()) throw new ServiceUnavailableError('FCM is not configured');
  const { token, topic } = topicBody.parse(req.body);
  const t = topic ?? env().FCM_DEFAULT_TOPIC;
  if (!t) throw new ServiceUnavailableError('No topic given and FCM_DEFAULT_TOPIC is unset');
  const result = await getFcmClient().manageTopic('add', t, [token]);
  await recordAudit({
    actor: actorFromRequest(req),
    action: 'push.subscribed',
    entityType: 'alert',
    summary: `Subscribed a device token to FCM topic "${t}"`,
  });
  res.json({ data: { topic: t, ...result } });
});

alertRouter.post('/alerts/push/unsubscribe', admin, async (req: Request, res: Response) => {
  if (!FcmClient.configured()) throw new ServiceUnavailableError('FCM is not configured');
  const { token, topic } = topicBody.parse(req.body);
  const t = topic ?? env().FCM_DEFAULT_TOPIC;
  if (!t) throw new ServiceUnavailableError('No topic given and FCM_DEFAULT_TOPIC is unset');
  const result = await getFcmClient().manageTopic('remove', t, [token]);
  res.json({ data: { topic: t, ...result } });
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
