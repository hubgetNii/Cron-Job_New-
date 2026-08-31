import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { env } from '../../config/index.js';

/**
 * Minimal CORS for the split deployment: the dashboard is served from Vercel and
 * calls this API on a different origin. Allowed origins come from
 * `CORS_ALLOWED_ORIGINS` (comma list, or `*`). Auth is Bearer-token in a header,
 * so credentials mode is not needed.
 *
 * No allowlist configured → the middleware is a no-op (same-origin / reverse-proxy
 * deployments need nothing).
 */
export function cors(): RequestHandler {
  const raw = (env().CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const allowAll = raw.includes('*');
  const allowed = new Set(raw);

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (raw.length === 0 || !origin) {
      if (req.method === 'OPTIONS' && origin) {
        res.status(204).end();
        return;
      }
      next();
      return;
    }

    if (allowAll || allowed.has(origin)) {
      res.setHeader('access-control-allow-origin', allowAll ? '*' : origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('access-control-allow-headers', 'authorization,content-type');
      res.setHeader('access-control-max-age', '86400');
    }

    if (req.method === 'OPTIONS') {
      // Preflight — answer even for disallowed origins (the missing ACAO header
      // is what the browser blocks on).
      res.status(204).end();
      return;
    }
    next();
  };
}
