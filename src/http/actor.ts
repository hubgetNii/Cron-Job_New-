import type { Request } from 'express';
import type { AuditActor } from '../services/audit/audit.service.js';

/**
 * Derives the acting principal for audit logging. Real authentication (JWT +
 * RBAC) arrives in Phase 9; until then an optional `x-actor-id` header lets
 * callers attribute changes, defaulting to an anonymous API actor.
 */
export function actorFromRequest(req: Request): AuditActor {
  const actorId = req.header('x-actor-id');
  return {
    userId: null,
    label: actorId ? `user:${actorId}` : 'system:api',
    ip: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    requestId: req.requestId,
  };
}
