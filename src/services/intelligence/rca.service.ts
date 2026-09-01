/**
 * Deterministic root-cause analysis (spec §8). Given an incident, it reads the
 * facts already recorded — the incident row, the target, and the target's
 * recent health-check history — and produces a structured analysis:
 *
 *   summary · evidence[] · probable cause · confidence · impact · recommendation
 *
 * It is ADVISORY. Nothing here changes the incident's status, severity or
 * lifecycle; it only writes to `incidents.rca` and returns the analysis. This is
 * a rules engine, not an LLM call — the AI path in `services/ai/` is separate
 * and additionally gated.
 */

import { componentLogger } from '../../lib/logger.js';
import { query } from '../../lib/db.js';
import { NotFoundError } from '../../lib/errors.js';
import { getIncident } from '../../repositories/incidents.repo.js';
import { findTargetById } from '../../repositories/monitored-apis.repo.js';
import { getRecentHealthChecks } from '../../repositories/dashboard.repo.js';
import { getTraceByCheckId } from '../../repositories/health-check-traces.repo.js';
import {
  classifyFailure,
  type FailureCategory,
} from '../../domain/failure-taxonomy.js';
import { recommendationFor, type Recommendation } from '../../domain/recommendations.js';
import type { CheckFailureType } from '../../domain/enums.js';

const log = componentLogger('rca');

export interface RootCauseAnalysis {
  generatedAt: string;
  method: 'deterministic';
  category: FailureCategory;
  subtype: string;
  summary: string;
  evidence: string[];
  probableCause: string;
  /** 0..1 — how well the recorded facts support the probable cause. */
  confidence: number;
  impact: string;
  recommendation: Recommendation;
  occurrences24h: number;
  latency: { baselineMs: number; recentMs: number; ratio: number } | null;
  assistive: true;
}

interface LatencyDelta {
  baselineMs: number;
  recentMs: number;
  ratio: number;
}

/** Mean latency of healthy checks before the incident vs. checks during it. */
async function latencyDelta(apiId: string, startedAt: Date): Promise<LatencyDelta | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT
       avg(response_time_ms) FILTER (
         WHERE status IN ('UP','DEGRADED')
           AND checked_at BETWEEN $2::timestamptz - interval '24 hours' AND $2::timestamptz
       ) AS baseline_ms,
       avg(response_time_ms) FILTER (WHERE checked_at >= $2::timestamptz) AS recent_ms
     FROM health_check_results
     WHERE api_id = $1
       AND response_time_ms IS NOT NULL
       AND checked_at >= $2::timestamptz - interval '24 hours'`,
    [apiId, startedAt],
  );
  const r = rows[0];
  if (!r || r['baseline_ms'] == null || r['recent_ms'] == null) return null;
  const baselineMs = Math.round(Number(r['baseline_ms']));
  const recentMs = Math.round(Number(r['recent_ms']));
  if (baselineMs <= 0) return null;
  return { baselineMs, recentMs, ratio: Number((recentMs / baselineMs).toFixed(2)) };
}

/** Incidents opened for this target in the 24h ending at `startedAt`, same failure type. */
async function occurrenceCount(
  apiId: string,
  failureType: CheckFailureType | null,
  startedAt: Date,
): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM incidents
     WHERE api_id = $1
       AND started_at BETWEEN $3::timestamptz - interval '24 hours' AND $3::timestamptz
       AND ($2::text IS NULL OR failure_type::text = $2::text)`,
    [apiId, failureType, startedAt],
  );
  return Math.max(1, Number(rows[0]?.n ?? '1'));
}

function impactStatement(
  endpointClass: string,
  isMoneyMoving: boolean,
  category: FailureCategory,
): string {
  if (isMoneyMoving) {
    return 'Money-moving endpoint — payment transactions may be affected. Treat as customer-impacting until proven otherwise.';
  }
  switch (endpointClass) {
    case 'payment_status':
      return 'Payment status lookups may be failing — customers and support may see stale or missing transaction state.';
    case 'auth':
      return 'Authentication endpoint degraded — downstream services that depend on it may fail to obtain sessions.';
    case 'kyc':
      return 'KYC endpoint degraded — customer onboarding and verification flows may stall.';
    case 'notification':
      return 'Notification endpoint degraded — outbound SMS/email/push to customers may be delayed.';
    case 'utility_vending':
      return 'Utility vending endpoint degraded — airtime/data/bill purchases through this provider may fail.';
    case 'reporting':
    case 'internal':
      return 'Internal/reporting endpoint — limited direct customer impact; operational visibility is reduced.';
    default:
      return category === 'PERFORMANCE'
        ? 'Elevated latency on this endpoint — requests are slow but mostly completing.'
        : 'Service availability on this endpoint is reduced.';
  }
}

function probableCause(
  category: FailureCategory,
  subtype: string,
  latency: LatencyDelta | null,
): { text: string; confidence: number } {
  switch (category) {
    case 'DATABASE':
      return {
        text:
          subtype === 'Connection pool exhaustion'
            ? 'Database connection pool exhaustion in the upstream API.'
            : `Database dependency failure (${subtype.toLowerCase()}).`,
        confidence: 0.75,
      };
    case 'DEPENDENCY':
      return { text: `A downstream dependency is unavailable (${subtype.toLowerCase()}).`, confidence: 0.7 };
    case 'CONNECTIVITY':
      return { text: `Network path to the target is broken (${subtype.toLowerCase()}).`, confidence: 0.85 };
    case 'AUTHENTICATION':
      return { text: 'The monitored credential is being rejected — likely expired, rotated or misconfigured.', confidence: 0.8 };
    case 'PERFORMANCE':
      return {
        text: latency
          ? `Response time rose to ${latency.recentMs}ms (~${latency.ratio}× the ${latency.baselineMs}ms baseline) — a downstream or resource bottleneck.`
          : 'Requests are timing out or being throttled — a downstream or resource bottleneck.',
        confidence: latency ? 0.65 : 0.5,
      };
    case 'CONFIGURATION':
      return { text: `Target configuration is wrong (${subtype.toLowerCase()}).`, confidence: 0.7 };
    case 'APPLICATION':
      return { text: `The API itself returned an error (${subtype.toLowerCase()}) — an unhandled exception or failing internal logic.`, confidence: 0.6 };
    default:
      return { text: 'Cause could not be determined from the recorded data.', confidence: 0.3 };
  }
}

/**
 * Builds (and persists to `incidents.rca`) the deterministic RCA for one
 * incident. Idempotent — safe to recompute as new checks arrive.
 */
export async function buildRootCauseAnalysis(incidentId: string): Promise<RootCauseAnalysis> {
  const incident = await getIncident(incidentId);
  if (!incident) throw new NotFoundError(`Incident ${incidentId} not found`);
  const target = await findTargetById(incident.apiId);
  const checks = await getRecentHealthChecks(incident.apiId, 50);

  const sinceStart = checks.filter((c) => c.checkedAt >= incident.startedAt);
  const failing = (sinceStart.length > 0 ? sinceStart : checks).filter(
    (c) => c.status === 'DOWN' || c.status === 'DEGRADED',
  );
  const worst = failing[0] ?? checks[0] ?? null;

  const statusesSeen = [...new Set(failing.map((c) => c.httpStatus).filter((s): s is number => s != null))];
  const consecutiveFailures = (() => {
    let n = 0;
    for (const c of checks) {
      if (c.status === 'DOWN' || c.status === 'DEGRADED') n += 1;
      else break;
    }
    return n;
  })();

  // Pull the response body from the trace of the worst failing check, if captured.
  const worstTrace = worst ? await getTraceByCheckId(worst.id) : null;
  const classification = classifyFailure({
    failureType: incident.failureType ?? (worst?.errorType as CheckFailureType | null) ?? null,
    httpStatus: worst?.httpStatus ?? null,
    errorMessage: worst?.errorMessage ?? null,
    responseSample: worstTrace?.responseBodyMasked ?? null,
  });

  const latency = await latencyDelta(incident.apiId, incident.startedAt);
  const occurrences24h = await occurrenceCount(incident.apiId, incident.failureType, incident.startedAt);

  const cause = probableCause(classification.category, classification.subtype, latency);
  // Blend the taxonomy's own confidence with the cause heuristic.
  const confidence = Number(
    Math.min(0.95, (cause.confidence * 0.6 + classification.confidence * 0.4)).toFixed(2),
  );

  const recommendation = recommendationFor({
    category: classification.category,
    failureType: incident.failureType,
    httpStatus: worst?.httpStatus ?? null,
    occurrences24h,
    latencyRatio: latency?.ratio ?? null,
  });

  const targetName = target?.name ?? 'the target';
  const evidence: string[] = [];
  if (statusesSeen.length > 0) {
    evidence.push(`HTTP status${statusesSeen.length > 1 ? 'es' : ''} observed: ${statusesSeen.join(', ')}`);
  }
  if (worst?.errorType) evidence.push(`Recorded failure type: ${worst.errorType}`);
  if (worst?.errorMessage) evidence.push(`Last error: ${worst.errorMessage}`);
  if (worstTrace?.responseBodyMasked) {
    const snippet = worstTrace.responseBodyMasked.slice(0, 240);
    evidence.push(`Response body (masked): ${snippet}${worstTrace.responseBodyMasked.length > 240 ? '…' : ''}`);
  }
  if (consecutiveFailures > 0) {
    evidence.push(`${consecutiveFailures} consecutive failed check${consecutiveFailures > 1 ? 's' : ''}`);
  }
  evidence.push(`Incident failure count: ${incident.failureCount}`);
  if (latency) {
    evidence.push(
      `Latency ${latency.baselineMs}ms → ${latency.recentMs}ms (${latency.ratio}× baseline)`,
    );
  }
  if (occurrences24h > 1) {
    evidence.push(`${occurrences24h} incidents with this signature for this target in the last 24h`);
  }

  const summary =
    classification.category === 'NONE'
      ? `${targetName} recovered or is only slow; no failing checks recorded for this incident.`
      : `${targetName} is ${incident.incidentType === 'DEGRADATION' ? 'degraded' : 'failing'}` +
        `${worst?.httpStatus ? ` (HTTP ${worst.httpStatus})` : ''}. ` +
        `Classified as ${classification.category} — ${classification.subtype}.`;

  const rca: RootCauseAnalysis = {
    generatedAt: new Date().toISOString(),
    method: 'deterministic',
    category: classification.category,
    subtype: classification.subtype,
    summary,
    evidence,
    probableCause: cause.text,
    confidence,
    impact: impactStatement(
      incident.endpointClassSnapshot,
      incident.isMoneyMovingSnapshot,
      classification.category,
    ),
    recommendation,
    occurrences24h,
    latency,
    assistive: true,
  };

  await query(`UPDATE incidents SET rca = $2, rca_updated_at = now() WHERE id = $1`, [
    incidentId,
    JSON.stringify(rca),
  ]);
  log.info(
    { incidentId, category: rca.category, confidence: rca.confidence },
    'deterministic RCA computed (advisory)',
  );

  return rca;
}

/** Reads the stored RCA without recomputing. */
export async function getStoredRca(incidentId: string): Promise<RootCauseAnalysis | null> {
  const { rows } = await query<{ rca: RootCauseAnalysis | null }>(
    `SELECT rca FROM incidents WHERE id = $1`,
    [incidentId],
  );
  if (rows.length === 0) throw new NotFoundError(`Incident ${incidentId} not found`);
  return rows[0]?.rca ?? null;
}
