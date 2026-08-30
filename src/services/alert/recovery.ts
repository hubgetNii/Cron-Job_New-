import type { SqlRunner } from '../../lib/db.js';
import { createAlert } from '../../repositories/alerts.repo.js';
import { notifiedTargetsForIncident } from '../../repositories/alerts.repo.js';

/**
 * Queues a recovery alert for every channel+recipient that was notified about
 * this incident, plus the default webhook, so "who heard it broke, hears it is
 * fixed" (see vault: "Alerting and Escalation").
 */
export async function queueRecoveryAlerts(
  incidentId: string,
  apiId: string,
  client: SqlRunner,
): Promise<void> {
  const notified = await notifiedTargetsForIncident(incidentId);
  const seen = new Set<string>();
  const dests = [{ channel: 'WEBHOOK' as const, recipient: 'ops' }, ...notified];

  for (const d of dests) {
    const key = `${d.channel}:${d.recipient}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await createAlert(
      {
        alertType: 'API_RECOVERED',
        channel: d.channel,
        recipient: d.recipient,
        incidentId,
        apiId,
      },
      client,
    );
  }
}
