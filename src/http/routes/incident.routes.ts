import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { actorFromRequest } from '../actor.js';
import { requireRole } from '../middleware/auth.js';
import { pruneUndefined } from '../../lib/objects.js';
import { INCIDENT_STATUSES, INCIDENT_TYPES, SEVERITIES } from '../../domain/enums.js';
import {
  acknowledgeIncident,
  getIncidentById,
  listIncidents,
  resolveIncidentManually,
  setIncidentRootCause,
} from '../../services/incident/incident.service.js';
import { incidentTimeline } from '../../repositories/incident-events.repo.js';

export const incidentRouter: Router = Router();

const idParam = z.string().uuid();
const canOperate = requireRole('OPERATOR', 'ADMIN');

const listQuery = z.object({
  status: z.enum(INCIDENT_STATUSES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  incidentType: z.enum(INCIDENT_TYPES).optional(),
  apiId: z.string().uuid().optional(),
  isMoneyMoving: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

incidentRouter.get('/incidents', async (req: Request, res: Response) => {
  const incidents = await listIncidents(pruneUndefined(listQuery.parse(req.query)));
  res.json({ data: incidents, count: incidents.length });
});

incidentRouter.get('/incidents/:id', async (req: Request, res: Response) => {
  const incident = await getIncidentById(idParam.parse(req.params.id));
  res.json({ data: incident });
});

// The merged incident timeline (spec §12) — recorded events + alert rows +
// lifecycle timestamps, ordered.
incidentRouter.get('/incidents/:id/timeline', async (req: Request, res: Response) => {
  const timeline = await incidentTimeline(idParam.parse(req.params.id));
  res.json({ data: timeline, count: timeline.length });
});

incidentRouter.post(
  '/incidents/:id/acknowledge',
  canOperate,
  async (req: Request, res: Response) => {
    const incident = await acknowledgeIncident(idParam.parse(req.params.id), actorFromRequest(req));
    res.json({ data: incident });
  },
);

incidentRouter.post('/incidents/:id/resolve', canOperate, async (req: Request, res: Response) => {
  const body = z.object({ resolution: z.string().min(1).max(4000) }).parse(req.body);
  const incident = await resolveIncidentManually(
    idParam.parse(req.params.id),
    body.resolution,
    actorFromRequest(req),
  );
  res.json({ data: incident });
});

incidentRouter.patch(
  '/incidents/:id/root-cause',
  canOperate,
  async (req: Request, res: Response) => {
    const body = z.object({ rootCause: z.string().min(1).max(4000) }).parse(req.body);
    const incident = await setIncidentRootCause(
      idParam.parse(req.params.id),
      body.rootCause,
      actorFromRequest(req),
    );
    res.json({ data: incident });
  },
);
