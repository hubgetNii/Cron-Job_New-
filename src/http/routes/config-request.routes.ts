import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { actorFromRequest } from '../actor.js';
import { requireRole } from '../middleware/auth.js';
import {
  getChangeRequest,
  listChangeRequests,
  reviewChangeRequest,
} from '../../services/target/config-request.service.js';

export const configRequestRouter: Router = Router();

const listQuery = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'APPLIED', 'FAILED']).optional(),
});

configRequestRouter.get('/config-requests', async (req: Request, res: Response) => {
  const { status } = listQuery.parse(req.query);
  const requests = await listChangeRequests(status);
  res.json({ data: requests, count: requests.length });
});

configRequestRouter.get('/config-requests/:id', async (req: Request, res: Response) => {
  res.json({ data: await getChangeRequest(z.string().uuid().parse(req.params.id)) });
});

const reviewBody = z.object({ note: z.string().max(2000).optional() });

configRequestRouter.post(
  '/config-requests/:id/approve',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { note } = reviewBody.parse(req.body ?? {});
    const request = await reviewChangeRequest(
      z.string().uuid().parse(req.params.id),
      'APPROVED',
      note ?? null,
      actorFromRequest(req),
    );
    res.json({ data: request });
  },
);

configRequestRouter.post(
  '/config-requests/:id/reject',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { note } = reviewBody.parse(req.body ?? {});
    const request = await reviewChangeRequest(
      z.string().uuid().parse(req.params.id),
      'REJECTED',
      note ?? null,
      actorFromRequest(req),
    );
    res.json({ data: request });
  },
);
