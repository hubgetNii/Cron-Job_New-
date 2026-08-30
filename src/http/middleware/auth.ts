import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { env } from '../../config/index.js';
import { ForbiddenError, UnauthorizedError } from '../../lib/errors.js';
import { verifyAccessToken } from '../../services/auth/jwt.js';
import type { RbacRole } from '../../domain/enums.js';

/** When auth is disabled (dev only), every request acts as a synthetic admin. */
const DEV_ACTOR: Express.AuthedUser = {
  id: '00000000-0000-0000-0000-000000000000',
  email: 'dev@local',
  roles: ['ADMIN', 'OPERATOR', 'DEVELOPER', 'COMPLIANCE', 'MANAGEMENT', 'VIEWER'],
};

/**
 * Verifies the Bearer access token and attaches `req.user`. With
 * `AUTH_ENABLED=false` it injects a dev admin and never rejects — that flag is
 * refused in production by the env layer.
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  if (!env().AUTH_ENABLED) {
    req.user = DEV_ACTOR;
    next();
    return;
  }
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    next(new UnauthorizedError('Missing bearer token'));
    return;
  }
  try {
    const claims = await verifyAccessToken(header.slice(7));
    req.user = { id: claims.sub, email: claims.email, roles: claims.roles };
    next();
  } catch {
    next(new UnauthorizedError('Invalid or expired access token'));
  }
}

/** Requires the authenticated user to hold at least one of the given roles. */
export function requireRole(...roles: RbacRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }
    if (roles.length > 0 && !roles.some((r) => req.user!.roles.includes(r))) {
      next(new ForbiddenError(`Requires one of: ${roles.join(', ')}`));
      return;
    }
    next();
  };
}
