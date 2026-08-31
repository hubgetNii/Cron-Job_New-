import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { actorFromRequest } from '../actor.js';
import { NotFoundError } from '../../lib/errors.js';
import { pruneUndefined } from '../../lib/objects.js';
import { recordAudit } from '../../services/audit/audit.service.js';
import {
  deleteContact,
  getContact,
  listContacts,
  updateContact,
  upsertContact,
} from '../../repositories/notification-contacts.repo.js';

/**
 * The standing list of email addresses and phone numbers that receive
 * notifications — the digest (system-health summary) and, later, per-incident
 * alerts. See vault: "SMS Health Digest Notifications".
 */
export const notificationContactsRouter: Router = Router();

const idParam = z.string().uuid();
const admin = requireRole('ADMIN');

const contactBody = z.object({
  name: z.string().max(200).nullish(),
  channel: z.enum(['EMAIL', 'SMS']),
  address: z.string().min(1).max(320),
  digest: z.boolean().optional(),
  digestEveryRun: z.boolean().optional(),
  incidentAlerts: z.boolean().optional(),
  isActive: z.boolean().optional(),
  note: z.string().max(1000).nullish(),
});

notificationContactsRouter.get('/notification-contacts', async (req: Request, res: Response) => {
  const includeInactive = req.query.includeInactive !== 'false';
  const contacts = await listContacts(includeInactive);
  res.json({ data: contacts, count: contacts.length });
});

notificationContactsRouter.post(
  '/notification-contacts',
  admin,
  async (req: Request, res: Response) => {
    const body = contactBody.parse(req.body);
    if (body.channel === 'EMAIL' && !z.string().email().safeParse(body.address).success) {
      res.status(422).json({ error: { code: 'VALIDATION', message: 'address must be an email' } });
      return;
    }
    const contact = await upsertContact({
      channel: body.channel,
      address: body.address,
      ...pruneUndefined({
        name: body.name ?? undefined,
        digest: body.digest,
        digestEveryRun: body.digestEveryRun,
        incidentAlerts: body.incidentAlerts,
        isActive: body.isActive,
        note: body.note ?? undefined,
      }),
    });
    await recordAudit({
      actor: actorFromRequest(req),
      action: 'notification_contact.upserted',
      entityType: 'notification_contact',
      entityId: contact.id,
      summary: `${contact.channel} contact ${contact.address}`,
    });
    res.status(201).json({ data: contact });
  },
);

notificationContactsRouter.put(
  '/notification-contacts/:id',
  admin,
  async (req: Request, res: Response) => {
    const patch = contactBody
      .omit({ channel: true, address: true })
      .partial()
      .parse(req.body ?? {});
    const contact = await updateContact(idParam.parse(req.params.id), pruneUndefined(patch));
    if (!contact) throw new NotFoundError('Contact not found');
    await recordAudit({
      actor: actorFromRequest(req),
      action: 'notification_contact.updated',
      entityType: 'notification_contact',
      entityId: contact.id,
      summary: `${contact.channel} contact ${contact.address}`,
    });
    res.json({ data: contact });
  },
);

notificationContactsRouter.delete(
  '/notification-contacts/:id',
  admin,
  async (req: Request, res: Response) => {
    const id = idParam.parse(req.params.id);
    const existing = await getContact(id);
    if (!existing || !(await deleteContact(id))) throw new NotFoundError('Contact not found');
    await recordAudit({
      actor: actorFromRequest(req),
      action: 'notification_contact.deleted',
      entityType: 'notification_contact',
      entityId: id,
      summary: `${existing.channel} contact ${existing.address}`,
    });
    res.status(204).send();
  },
);
