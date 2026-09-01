import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { actorFromRequest } from '../actor.js';
import { recordAudit } from '../../services/audit/audit.service.js';
import { listDigests, latestDigest } from '../../repositories/health-digests.repo.js';
import {
  broadcastStatusSms,
  buildDigest,
  evaluateDigest,
  previewStatusSms,
} from '../../services/digest/health-digest.service.js';

/**
 * SMS health-digest endpoints. The digest is a periodic *summary* of overall
 * system health; an SMS goes out only when the overall level changes
 * (see vault: "SMS Health Digest Notifications").
 */
export const digestRouter: Router = Router();

digestRouter.get('/health-digests', async (req: Request, res: Response) => {
  const limit = z.coerce.number().int().min(1).max(200).optional().parse(req.query.limit);
  const digests = await listDigests(limit ?? 50);
  res.json({ data: digests, count: digests.length });
});

digestRouter.get('/health-digests/latest', async (_req: Request, res: Response) => {
  res.json({ data: await latestDigest() });
});

// Preview what the next digest would look like — does not persist or send.
digestRouter.get('/health-digests/preview', async (_req: Request, res: Response) => {
  res.json({ data: await buildDigest() });
});

// Preview the routine status SMS text + who it would go to — no send.
digestRouter.get('/health-digests/sms-preview', async (_req: Request, res: Response) => {
  res.json({ data: await previewStatusSms() });
});

// Send the routine platform-status SMS now, to every SMS contact.
digestRouter.post(
  '/health-digests/broadcast-sms',
  requireRole('ADMIN', 'OPERATOR'),
  async (req: Request, res: Response) => {
    const digest = await broadcastStatusSms();
    await recordAudit({
      actor: actorFromRequest(req),
      action: 'health_digest.sms_broadcast',
      entityType: 'health_digest',
      entityId: digest.id,
      summary: `Manual SMS status broadcast — ${digest.overallLevel} → ${digest.smsRecipients} recipient(s)`,
    });
    res.json({ data: digest });
  },
);

// Force an evaluation now (persists; sends an SMS only if the level changed).
digestRouter.post(
  '/health-digests/evaluate',
  requireRole('ADMIN', 'OPERATOR'),
  async (req: Request, res: Response) => {
    const digest = await evaluateDigest();
    await recordAudit({
      actor: actorFromRequest(req),
      action: 'health_digest.evaluated',
      entityType: 'health_digest',
      entityId: digest.id,
      summary: `Manual digest — ${digest.overallLevel}${digest.smsSent ? ' (SMS sent)' : ''}`,
    });
    res.json({ data: digest });
  },
);
