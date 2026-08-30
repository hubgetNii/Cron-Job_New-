import { Router, type Request, type Response } from 'express';
import { env } from '../../config/index.js';
import { NotFoundError } from '../../lib/errors.js';
import { getPublicStatus } from '../../repositories/dashboard.repo.js';

/**
 * Public, unauthenticated status page data (see vault: Phase 11). Sanitised —
 * no URLs, ids or failure detail. Toggled by STATUS_PAGE_ENABLED.
 */
export const statusRouter: Router = Router();

statusRouter.get('/status', async (_req: Request, res: Response) => {
  if (!env().STATUS_PAGE_ENABLED) throw new NotFoundError('Status page is disabled');
  res.setHeader('cache-control', 'public, max-age=30');
  res.json({ data: await getPublicStatus() });
});
