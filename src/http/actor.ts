import type { Request } from 'express';
import type { AuditActor } from '../services/audit/audit.service.js';

const DEV_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Derives the acting principal for audit logging from the authenticated user
 * (`authenticate` middleware). The synthetic dev actor (auth disabled) has a
 * zero UUID, which is treated as "no user" for audit and four-eyes.
 */
export function actorFromRequest(req: Request): AuditActor {
  const user = req.user;
  const realUserId = user && user.id !== DEV_ACTOR_ID ? user.id : null;
  return {
    userId: realUserId,
    label: user ? `user:${user.email}` : 'system:api',
    ip: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    requestId: req.requestId,
  };
}

/** The authenticated user's id, or null when running with auth disabled. */
export function realUserId(req: Request): string | null {
  return req.user && req.user.id !== DEV_ACTOR_ID ? req.user.id : null;
}
