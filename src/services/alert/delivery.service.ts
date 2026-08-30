import { componentLogger } from '../../lib/logger.js';
import { listPendingAlerts, markAlert, type Alert } from '../../repositories/alerts.repo.js';
import { getIncident } from '../../repositories/incidents.repo.js';
import { findTargetById } from '../../repositories/monitored-apis.repo.js';
import { activeWindowForTarget } from '../../repositories/maintenance-windows.repo.js';
import { channelFor, type Notification } from './channels.js';

const log = componentLogger('alert-delivery');

export interface DeliveryResult {
  delivered: number;
  suppressed: number;
  failed: number;
}

function subjectFor(
  alert: Alert,
  incidentNumber: string | null,
  targetName: string | null,
): string {
  const who = targetName ? `"${targetName}"` : 'a target';
  switch (alert.alertType) {
    case 'API_DOWN':
      return `${who} is DOWN${incidentNumber ? ` (${incidentNumber})` : ''}`;
    case 'API_DEGRADED':
      return `${who} is DEGRADED${incidentNumber ? ` (${incidentNumber})` : ''}`;
    case 'API_RECOVERED':
      return `${who} has RECOVERED${incidentNumber ? ` (${incidentNumber})` : ''}`;
    case 'FLAPPING_DETECTED':
      return `${who} is FLAPPING${incidentNumber ? ` (${incidentNumber})` : ''}`;
    case 'ESCALATION_TRIGGERED':
      return `Escalation tier ${alert.escalationTier ?? '?'} for ${incidentNumber ?? who}`;
    case 'SCHEDULER_HEARTBEAT_MISSED':
      return 'Scheduler missed a run';
    case 'JOB_EXECUTION_FAILURE':
      return `Health check failed to execute for ${who}`;
    default:
      return `${alert.alertType} — ${who}`;
  }
}

/**
 * Sends every PENDING alert through its channel. Alerts for a target inside an
 * active maintenance window are marked SUPPRESSED, not delivered — but the
 * check that produced them still ran and is recorded (see vault: "Maintenance
 * Windows").
 */
export async function runDeliveryCycle(): Promise<DeliveryResult> {
  const pending = await listPendingAlerts(200);
  const result: DeliveryResult = { delivered: 0, suppressed: 0, failed: 0 };

  for (const alert of pending) {
    const incident = alert.incidentId ? await getIncident(alert.incidentId) : null;
    const target = alert.apiId ? await findTargetById(alert.apiId) : null;

    if (alert.apiId && alert.alertType !== 'API_RECOVERED') {
      const window = await activeWindowForTarget(alert.apiId);
      if (window) {
        await markAlert(alert.id, 'SUPPRESSED', `maintenance window: ${window.reason}`);
        result.suppressed += 1;
        continue;
      }
    }

    const severity = incident?.severity ?? (alert.alertType === 'API_RECOVERED' ? 'INFO' : 'HIGH');
    const notification: Notification = {
      alertType: alert.alertType,
      severity,
      subject: subjectFor(alert, incident?.incidentNumber ?? null, target?.name ?? null),
      body:
        incident?.failureType != null
          ? `Failure type: ${incident.failureType}. Failures so far: ${incident.failureCount}.`
          : 'See the dashboard for detail.',
      recipient: alert.recipient,
      incidentNumber: incident?.incidentNumber ?? null,
      targetName: target?.name ?? null,
      payload: {
        incident_id: alert.incidentId,
        api_id: alert.apiId,
        escalation_tier: alert.escalationTier,
      },
    };

    const outcome = await channelFor(alert.channel).send(notification);
    if (outcome.ok) {
      await markAlert(alert.id, 'SENT', outcome.detail);
      result.delivered += 1;
    } else {
      await markAlert(alert.id, 'FAILED', outcome.detail);
      result.failed += 1;
      log.warn(
        { alertId: alert.id, channel: alert.channel, detail: outcome.detail },
        'alert delivery failed',
      );
    }
  }

  return result;
}
