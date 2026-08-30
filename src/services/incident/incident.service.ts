import { NotFoundError, ValidationError } from '../../lib/errors.js';
import type { Incident } from '../../domain/incident.js';
import {
  acknowledgeIncident as ackRow,
  getIncident,
  listIncidents as listRows,
  resolveIncident as resolveRow,
  setRootCause as setRootCauseRow,
  type ListIncidentFilters,
} from '../../repositories/incidents.repo.js';
import { recordAudit, type AuditActor } from '../audit/audit.service.js';

export function listIncidents(filters: ListIncidentFilters): Promise<Incident[]> {
  return listRows(filters);
}

export async function getIncidentById(id: string): Promise<Incident> {
  const incident = await getIncident(id);
  if (!incident) throw new NotFoundError(`Incident ${id} not found`);
  return incident;
}

export async function acknowledgeIncident(id: string, actor: AuditActor): Promise<Incident> {
  const existing = await getIncident(id);
  if (!existing) throw new NotFoundError(`Incident ${id} not found`);
  if (existing.status === 'RESOLVED') {
    throw new ValidationError('Incident is already resolved');
  }
  const updated = await ackRow(id, actor.userId ?? null);
  if (!updated) throw new NotFoundError(`Incident ${id} not found`);
  await recordAudit({
    actor,
    action: 'incident.acknowledged',
    entityType: 'incident',
    entityId: id,
    summary: `Acknowledged ${updated.incidentNumber} (by ${actor.label ?? actor.userId ?? 'unknown'})`,
  });
  return updated;
}

export async function resolveIncidentManually(
  id: string,
  resolution: string,
  actor: AuditActor,
): Promise<Incident> {
  if (!resolution.trim()) throw new ValidationError('A resolution note is required');
  const existing = await getIncident(id);
  if (!existing) throw new NotFoundError(`Incident ${id} not found`);
  if (existing.status === 'RESOLVED') throw new ValidationError('Incident is already resolved');

  const updated = await resolveRow(id, resolution);
  if (!updated) throw new NotFoundError(`Incident ${id} not found`);
  await recordAudit({
    actor,
    action: 'incident.resolved',
    entityType: 'incident',
    entityId: id,
    summary: `Manually resolved ${updated.incidentNumber} after ${updated.durationSeconds ?? '?'}s`,
    changes: { after: { resolution } },
  });
  return updated;
}

export async function setIncidentRootCause(
  id: string,
  rootCause: string,
  actor: AuditActor,
): Promise<Incident> {
  if (!rootCause.trim()) throw new ValidationError('Root cause text is required');
  const updated = await setRootCauseRow(id, rootCause);
  if (!updated) throw new NotFoundError(`Incident ${id} not found`);
  await recordAudit({
    actor,
    action: 'incident.root_cause_set',
    entityType: 'incident',
    entityId: id,
    summary: `Root cause recorded for ${updated.incidentNumber}`,
  });
  return updated;
}
