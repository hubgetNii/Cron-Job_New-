import { ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { componentLogger } from '../../lib/logger.js';
import { recordAudit, type AuditActor } from '../audit/audit.service.js';
import { findTargetById } from '../../repositories/monitored-apis.repo.js';
import type { TargetWriteModel } from '../../repositories/monitored-apis.repo.js';
import {
  getConfigRequest,
  listConfigRequests,
  markApplied,
  markFailed,
  markReviewed,
  type ConfigChangeRequest,
  type ConfigRequestStatus,
} from '../../repositories/config-requests.repo.js';
import { persistTargetCreate, persistTargetUpdate } from './target.service.js';

const log = componentLogger('config-request');

export function listChangeRequests(status?: ConfigRequestStatus): Promise<ConfigChangeRequest[]> {
  return listConfigRequests(status);
}

export async function getChangeRequest(id: string): Promise<ConfigChangeRequest> {
  const req = await getConfigRequest(id);
  if (!req) throw new NotFoundError(`Config change request ${id} not found`);
  return req;
}

/**
 * Approves or rejects a proposed money-moving config change. The reviewer must
 * be a different user from the proposer (four-eyes — also a DB CHECK) and must
 * hold ADMIN (enforced at the route). On approval the change is applied
 * immediately and the request is marked APPLIED.
 */
export async function reviewChangeRequest(
  id: string,
  decision: 'APPROVED' | 'REJECTED',
  note: string | null,
  actor: AuditActor,
): Promise<ConfigChangeRequest> {
  const request = await getConfigRequest(id);
  if (!request) throw new NotFoundError(`Config change request ${id} not found`);
  if (request.status !== 'PENDING') {
    throw new ValidationError(`Request is already ${request.status}`);
  }
  if (!actor.userId) throw new ValidationError('A named reviewer is required');
  if (actor.userId === request.proposedBy) {
    throw new ForbiddenError('The proposer cannot approve their own change (four-eyes)');
  }

  const reviewed = await markReviewed(id, actor.userId, decision, note);
  if (!reviewed) throw new ValidationError('Request could not be reviewed (already actioned?)');

  await recordAudit({
    actor,
    action: decision === 'APPROVED' ? 'config_request.approved' : 'config_request.rejected',
    entityType: 'config_change_request',
    entityId: id,
    summary: `${decision} — ${reviewed.summary}${note ? ` (${note})` : ''}`,
  });

  if (decision === 'REJECTED') return reviewed;

  // Apply the approved change.
  try {
    const model = reviewed.payload as TargetWriteModel;
    const applyNote = `via approval ${reviewed.id} (proposed by ${reviewed.proposedBy})`;
    if (reviewed.kind === 'target_create') {
      await persistTargetCreate(model, actor, applyNote);
    } else {
      const existing = reviewed.targetId ? await findTargetById(reviewed.targetId) : null;
      if (!existing) throw new NotFoundError('Target no longer exists');
      await persistTargetUpdate(reviewed.targetId!, model, existing, actor, applyNote);
    }
    await markApplied(id);
    log.info({ requestId: id, kind: reviewed.kind }, 'approved config change applied');
    return (await getConfigRequest(id))!;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markFailed(id, message);
    log.error({ err, requestId: id }, 'failed to apply approved config change');
    await recordAudit({
      actor,
      action: 'config_request.apply_failed',
      entityType: 'config_change_request',
      entityId: id,
      summary: `Failed to apply: ${message}`,
    });
    return (await getConfigRequest(id))!;
  }
}
