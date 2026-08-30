import { env } from '../../config/index.js';
import { componentLogger } from '../../lib/logger.js';
import type { SqlRunner } from '../../lib/db.js';
import type { MonitoredApi } from '../../domain/target.js';
import type { Incident } from '../../domain/incident.js';
import type { AlertType, CheckFailureType, HealthStatus, Severity } from '../../domain/enums.js';
import {
  countStatusTransitions,
  escalateIncident,
  findActiveIncident,
  incrementFailureCount,
  markIncidentFlapping,
  openIncident,
  resolveIncident,
} from '../../repositories/incidents.repo.js';
import { recordAlert } from '../../repositories/scheduler.repo.js';
import { queueRecoveryAlerts } from '../alert/recovery.js';

const log = componentLogger('incident');

/**
 * Queues one automatic alert per configured default channel (ALERT_DEFAULT_CHANNELS,
 * e.g. "WEBHOOK,PUSH") to the default recipient. The delivery cycle then routes
 * each to its transport.
 */
async function recordDefaultAlerts(
  input: {
    alertType: AlertType;
    apiId: string;
    incidentId: string;
    errorMessage: string;
  },
  client: SqlRunner,
): Promise<void> {
  const recipient = env().ALERT_DEFAULT_RECIPIENT;
  for (const channel of env().ALERT_DEFAULT_CHANNELS) {
    await recordAlert({ ...input, channel, recipient }, client);
  }
}

export interface CheckContext {
  target: MonitoredApi;
  status: HealthStatus;
  failureType: CheckFailureType | null;
  checkId: string | null;
  /** Recovery counters after this check was recorded. */
  consecutiveSuccesses: number;
}

export type IncidentTransition =
  | { kind: 'opened'; incident: Incident }
  | { kind: 'failure_recorded'; incident: Incident }
  | { kind: 'flapping_detected'; incident: Incident }
  | { kind: 'resolved'; incident: Incident }
  | { kind: 'noop' };

const DEGRADE: Record<Severity, Severity> = {
  CRITICAL: 'HIGH',
  HIGH: 'MEDIUM',
  MEDIUM: 'LOW',
  LOW: 'LOW',
};

async function checkFlapping(
  target: MonitoredApi,
  active: Incident | null,
  client: SqlRunner,
): Promise<Incident | null> {
  const transitions = await countStatusTransitions(
    target.id,
    env().FLAPPING_WINDOW_MINUTES,
    client,
  );
  if (transitions < env().FLAPPING_THRESHOLD) return null;
  if (active && active.incidentType !== 'FLAPPING') {
    await markIncidentFlapping(active.id, client);
    await recordDefaultAlerts(
      {
        alertType: 'FLAPPING_DETECTED',
        apiId: target.id,
        incidentId: active.id,
        errorMessage: `"${target.name}" changed state ${transitions}× in ${env().FLAPPING_WINDOW_MINUTES}m`,
      },
      client,
    );
    return { ...active, incidentType: 'FLAPPING' };
  }
  return active;
}

/**
 * Drives the incident state machine for one recorded check result (see vault:
 * "Incident Lifecycle"). Runs inside the job runner's transaction so a result
 * and the incident change it causes commit together.
 *
 * - UP → DOWN: opens an OUTAGE incident (the DB's partial unique index makes
 *   "never duplicate" a hard guarantee, not a race).
 * - UP → DEGRADED: opens a lower-severity DEGRADATION incident.
 * - DOWN → UP: auto-resolves only after `INCIDENT_RECOVERY_STREAK` consecutive
 *   clean UP checks — deterministic, and applied uniformly to money-moving
 *   targets (Rule 18).
 * - Rapid oscillation is surfaced as a distinct FLAPPING incident type rather
 *   than a storm of open/close alerts (Rule 23).
 */
export async function processCheckOutcome(
  ctx: CheckContext,
  client: SqlRunner,
): Promise<IncidentTransition> {
  const { target, status, failureType, checkId } = ctx;
  let active = await findActiveIncident(target.id, client);

  if (status === 'UNKNOWN') {
    // Ambiguous — never opens, never closes. A degraded/down streak is unaffected.
    return { kind: 'noop' };
  }

  if (status === 'UP') {
    if (!active) return { kind: 'noop' };
    if (ctx.consecutiveSuccesses >= env().INCIDENT_RECOVERY_STREAK) {
      const resolved = await resolveIncident(active.id, null, client);
      if (!resolved) return { kind: 'noop' };
      await queueRecoveryAlerts(resolved.id, target.id, client);
      log.info(
        {
          incident: resolved.incidentNumber,
          targetId: target.id,
          durationSeconds: resolved.durationSeconds,
        },
        'incident auto-resolved',
      );
      return { kind: 'resolved', incident: resolved };
    }
    return { kind: 'noop' }; // waiting for the streak to complete
  }

  // status is DOWN or DEGRADED from here.
  const isDown = status === 'DOWN';

  if (!active) {
    const incident = await openIncident(
      {
        apiId: target.id,
        incidentType: isDown ? 'OUTAGE' : 'DEGRADATION',
        severity: isDown ? target.severityDefault : DEGRADE[target.severityDefault],
        endpointClassSnapshot: target.endpointClass,
        isMoneyMovingSnapshot: target.isMoneyMoving,
        detectedByCheckId: checkId,
        failureType,
      },
      client,
    );
    await recordDefaultAlerts(
      {
        alertType: isDown ? 'API_DOWN' : 'API_DEGRADED',
        apiId: target.id,
        incidentId: incident.id,
        errorMessage: `${incident.incidentNumber} opened (${status}, ${failureType ?? 'n/a'})`,
      },
      client,
    );
    log.warn(
      {
        incident: incident.incidentNumber,
        targetId: target.id,
        status,
        severity: incident.severity,
      },
      'incident opened',
    );
    const flapped = await checkFlapping(target, incident, client);
    return flapped && flapped.incidentType === 'FLAPPING' && incident.incidentType !== 'FLAPPING'
      ? { kind: 'flapping_detected', incident: flapped }
      : { kind: 'opened', incident };
  }

  await incrementFailureCount(active.id, failureType, client);

  // A DOWN check while a DEGRADATION incident is open promotes it to a full
  // outage at the target's real severity.
  if (isDown && active.incidentType === 'DEGRADATION') {
    await escalateIncident(active.id, 0, client);
    await client.query(
      `UPDATE incidents SET incident_type = 'OUTAGE', severity = $2 WHERE id = $1`,
      [active.id, target.severityDefault],
    );
    active = { ...active, incidentType: 'OUTAGE', severity: target.severityDefault };
  }

  const flapped = await checkFlapping(target, active, client);
  if (flapped && flapped.incidentType === 'FLAPPING' && active.incidentType !== 'FLAPPING') {
    return { kind: 'flapping_detected', incident: flapped };
  }
  return { kind: 'failure_recorded', incident: flapped ?? active };
}
