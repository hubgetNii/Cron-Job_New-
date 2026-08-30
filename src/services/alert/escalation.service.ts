import { componentLogger } from '../../lib/logger.js';
import {
  escalateIncident,
  listOpenIncidentsForEscalation,
} from '../../repositories/incidents.repo.js';
import { createAlert, highestTierFired } from '../../repositories/alerts.repo.js';
import {
  getEscalationPolicy,
  type EscalationPolicy,
} from '../../repositories/escalation-policies.repo.js';

const log = componentLogger('escalation');

export interface EscalationResult {
  incidentsScanned: number;
  tiersFired: number;
}

function tierIsDue(startedAt: Date, delayMinutes: number, now: Date): boolean {
  return now.getTime() - startedAt.getTime() >= delayMinutes * 60_000;
}

/**
 * One escalation pass. For every OPEN incident whose target has a policy, fires
 * the next tier that is both due and not yet actioned. Escalation stops the
 * moment an incident is ACKNOWLEDGED or RESOLVED (those leave the work list).
 * Tier 4's `is_money_moving` condition is honoured (spec 8.9).
 */
export async function runEscalationCycle(now: Date = new Date()): Promise<EscalationResult> {
  const work = await listOpenIncidentsForEscalation();
  const policyCache = new Map<string, EscalationPolicy | null>();
  let tiersFired = 0;

  for (const { incident, escalationPolicyId, targetName } of work) {
    let policy = policyCache.get(escalationPolicyId);
    if (policy === undefined) {
      policy = await getEscalationPolicy(escalationPolicyId);
      policyCache.set(escalationPolicyId, policy);
    }
    if (!policy || policy.tiers.length === 0) continue;

    const lastFired = await highestTierFired(incident.id);
    const nextIndex = lastFired + 1;
    const tier = policy.tiers[nextIndex];
    if (!tier) continue;

    if (tier.condition === 'is_money_moving' && !incident.isMoneyMovingSnapshot) {
      // Skip this tier but still advance the pointer so later tiers can fire.
      await escalateIncident(incident.id, nextIndex);
      continue;
    }
    if (!tierIsDue(incident.startedAt, tier.delayMinutes, now)) continue;

    for (const recipient of tier.recipients) {
      await createAlert({
        alertType: 'ESCALATION_TRIGGERED',
        channel: tier.channel,
        recipient,
        incidentId: incident.id,
        apiId: incident.apiId,
        escalationTier: nextIndex,
      });
    }
    await escalateIncident(incident.id, nextIndex);
    tiersFired += 1;
    log.warn(
      {
        incident: incident.incidentNumber,
        target: targetName,
        tier: nextIndex,
        channel: tier.channel,
      },
      'escalation tier fired',
    );
  }

  return { incidentsScanned: work.length, tiersFired };
}
