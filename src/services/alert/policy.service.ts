import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { recordAudit, type AuditActor } from '../audit/audit.service.js';
import {
  createEscalationPolicy as createPolicyRow,
  getEscalationPolicy,
  listEscalationPolicies as listPolicyRows,
  updateEscalationPolicy as updatePolicyRow,
  escalationTiersSchema,
  type EscalationPolicy,
} from '../../repositories/escalation-policies.repo.js';
import {
  activeWindowForTarget,
  createMaintenanceWindow as createWindowRow,
  deleteMaintenanceWindow as deleteWindowRow,
  listMaintenanceWindows as listWindowRows,
  type MaintenanceWindow,
} from '../../repositories/maintenance-windows.repo.js';
import { findTargetById } from '../../repositories/monitored-apis.repo.js';

/* --- escalation policies -------------------------------------------------- */

export function listEscalationPolicies(): Promise<EscalationPolicy[]> {
  return listPolicyRows();
}

export async function getEscalationPolicyById(id: string): Promise<EscalationPolicy> {
  const policy = await getEscalationPolicy(id);
  if (!policy) throw new NotFoundError(`Escalation policy ${id} not found`);
  return policy;
}

export async function createEscalationPolicy(
  input: { name: string; description?: string | null | undefined; tiers: unknown },
  actor: AuditActor,
): Promise<EscalationPolicy> {
  const tiers = escalationTiersSchema.parse(input.tiers);
  const policy = await createPolicyRow({
    name: input.name,
    description: input.description ?? null,
    tiers,
  });
  await recordAudit({
    actor,
    action: 'escalation_policy.created',
    entityType: 'escalation_policy',
    entityId: policy.id,
    summary: `Created escalation policy "${policy.name}" (${tiers.length} tiers)`,
  });
  return policy;
}

export async function updateEscalationPolicy(
  id: string,
  input: {
    name?: string | undefined;
    description?: string | null | undefined;
    tiers?: unknown;
  },
  actor: AuditActor,
): Promise<EscalationPolicy> {
  const tiers = input.tiers === undefined ? undefined : escalationTiersSchema.parse(input.tiers);
  const updated = await updatePolicyRow(id, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(tiers !== undefined ? { tiers } : {}),
  });
  if (!updated) throw new NotFoundError(`Escalation policy ${id} not found`);
  await recordAudit({
    actor,
    action: 'escalation_policy.updated',
    entityType: 'escalation_policy',
    entityId: id,
    summary: `Updated escalation policy "${updated.name}"`,
  });
  return updated;
}

/* --- maintenance windows ------------------------------------------------- */

export function listMaintenanceWindows(includeExpired: boolean): Promise<MaintenanceWindow[]> {
  return listWindowRows(includeExpired);
}

export async function createMaintenanceWindow(
  input: {
    targetId: string | null;
    startsAt: string;
    endsAt: string;
    reason: string;
    ticketRef?: string | null | undefined;
  },
  actor: AuditActor,
): Promise<MaintenanceWindow> {
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    throw new ValidationError('startsAt and endsAt must be valid timestamps');
  }
  if (endsAt <= startsAt) throw new ValidationError('endsAt must be after startsAt');
  if (endsAt.getTime() - startsAt.getTime() > 30 * 24 * 60 * 60 * 1000) {
    throw new ValidationError('A maintenance window may not exceed 30 days — it must expire');
  }
  if (input.targetId) {
    const target = await findTargetById(input.targetId);
    if (!target) throw new NotFoundError(`Target ${input.targetId} not found`);
  }

  const window = await createWindowRow({
    targetId: input.targetId,
    startsAt,
    endsAt,
    reason: input.reason,
    ticketRef: input.ticketRef ?? null,
    createdBy: actor.userId ?? null,
  });
  await recordAudit({
    actor,
    action: 'maintenance_window.created',
    entityType: 'maintenance_window',
    entityId: window.id,
    summary: `Maintenance window ${window.targetId ? 'for a target' : '(global)'}: ${window.reason}`,
    changes: { after: { startsAt, endsAt, reason: window.reason, ticketRef: window.ticketRef } },
  });
  return window;
}

export async function deleteMaintenanceWindow(id: string, actor: AuditActor): Promise<void> {
  const removed = await deleteWindowRow(id);
  if (!removed) throw new NotFoundError(`Maintenance window ${id} not found`);
  await recordAudit({
    actor,
    action: 'maintenance_window.deleted',
    entityType: 'maintenance_window',
    entityId: id,
    summary: 'Maintenance window ended early',
  });
}

export { activeWindowForTarget };
