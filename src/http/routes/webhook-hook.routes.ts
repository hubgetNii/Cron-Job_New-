import express, { Router, type Request, type Response } from 'express';
import { MAX_BODY_BYTES, receiveHook } from '../../services/loadtest/webhook-sink.service.js';

/**
 * Public endpoint iSmart delivers webhooks to: POST /hooks/loadtest/:slug
 * Deliberately outside /api/v1 and outside auth — iSmart cannot log in. The slug is
 * unguessable and every request must carry a valid signature.
 */
export const webhookHookRouter: Router = Router();

const h = (req: Request, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

webhookHookRouter.post(
  '/:slug',
  express.raw({ type: () => true, limit: MAX_BODY_BYTES }),
  async (req: Request, res: Response) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const status = await receiveHook({
      slug: String(req.params['slug'] ?? ''),
      rawBody: raw,
      headers: {
        id: h(req, 'webhook-id'),
        timestamp: h(req, 'webhook-timestamp'),
        signature: h(req, 'webhook-signature'),
      },
    });
    res.status(status).end();
  },
);
