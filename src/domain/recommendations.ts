/**
 * Recommendations engine (spec §9). Turns a classified failure into a concrete
 * next action for the on-call engineer. Deterministic lookup keyed by the
 * failure signature, with a modifier that factors in recent history ("this is
 * the Nth occurrence in 24h").
 *
 * Pure: no I/O. The caller supplies the recurrence count.
 */

import type { CheckFailureType } from './enums.js';
import type { FailureCategory } from './failure-taxonomy.js';

export interface RecommendationInput {
  category: FailureCategory;
  failureType: CheckFailureType | null;
  httpStatus: number | null;
  /** How many incidents with this same signature have opened for this target in the last 24h (this one included). */
  occurrences24h?: number;
  /** Latency this check vs the target's baseline, if a latency anomaly is present. */
  latencyRatio?: number | null;
}

export interface Recommendation {
  finding: string;
  recommendation: string;
  priority: 'P1' | 'P2' | 'P3';
}

const BY_HTTP: Record<number, Omit<Recommendation, 'priority'>> = {
  400: { finding: 'HTTP 400 — bad request', recommendation: 'Validate the request payload and required parameters against the current API contract.' },
  401: { finding: 'HTTP 401 — unauthorized', recommendation: 'Validate the API credentials and token expiry; rotate the monitored credential if it has lapsed.' },
  403: { finding: 'HTTP 403 — forbidden', recommendation: 'Review the access policy and scopes granted to the monitoring credential.' },
  404: { finding: 'HTTP 404 — not found', recommendation: 'Verify the endpoint path and API version; the route may have moved or been deprecated.' },
  409: { finding: 'HTTP 409 — conflict', recommendation: 'Inspect application state for the conflicting resource; check for duplicate or out-of-order processing.' },
  422: { finding: 'HTTP 422 — unprocessable entity', recommendation: 'Review request validation rules; a field value is being rejected by the API.' },
  429: { finding: 'HTTP 429 — rate limited', recommendation: 'Review the check frequency and the provider rate limits; back off or request a higher quota.' },
  500: { finding: 'HTTP 500 — internal server error', recommendation: 'Review the application logs and exception traces around the failure window.' },
  502: { finding: 'HTTP 502 — bad gateway', recommendation: 'Investigate the gateway / upstream service the API proxies to.' },
  503: { finding: 'HTTP 503 — service unavailable', recommendation: 'Check service availability, deployment state and health of the upstream it depends on.' },
  504: { finding: 'HTTP 504 — gateway timeout', recommendation: 'Investigate the upstream response time; the API is timing out waiting on a dependency.' },
};

const BY_FAILURE_TYPE: Partial<Record<CheckFailureType, Omit<Recommendation, 'priority'>>> = {
  DNS_ERROR: { finding: 'DNS resolution failed', recommendation: 'Validate the DNS configuration for the host and the resolver used by the monitor.' },
  TLS_ERROR: { finding: 'TLS/SSL handshake failed', recommendation: 'Check the certificate validity, chain and expiry on the target host.' },
  CONNECTION_ERROR: { finding: 'Connection could not be established', recommendation: 'Check that the service is listening, and review network reachability, firewall and security-group rules.' },
  TIMEOUT: { finding: 'Request timed out', recommendation: 'Review network and dependency latency; if repeated, treat the downstream (DB / upstream API) as the suspect.' },
  RATE_LIMITED: { finding: 'Requests are being rate limited', recommendation: 'Review the check frequency and the provider rate limits.' },
  AUTHENTICATION_ERROR: { finding: 'Authentication rejected', recommendation: 'Validate credentials and token expiry; confirm the monitor is using the right environment key.' },
  VALIDATION_ERROR: { finding: 'Response failed validation', recommendation: 'Compare the current response shape against the target’s expected-response rules; the contract may have changed.' },
  SETTLEMENT_MISMATCH: { finding: 'Settlement figures did not reconcile', recommendation: 'Escalate to the settlements team; do not auto-resolve — a money-moving discrepancy needs human sign-off.' },
  RECONCILIATION_FAILURE: { finding: 'Reconciliation check failed', recommendation: 'Escalate to finance / operations; investigate the ledger and provider statements for the period.' },
};

const BY_CATEGORY: Record<FailureCategory, Omit<Recommendation, 'priority'>> = {
  CONNECTIVITY: { finding: 'Connectivity failure', recommendation: 'Check DNS, TLS and network reachability from the monitor to the target.' },
  AUTHENTICATION: { finding: 'Authentication failure', recommendation: 'Validate API credentials, token expiry and access scopes.' },
  APPLICATION: { finding: 'Application-level error', recommendation: 'Review the application logs and exception traces for the failure window.' },
  DATABASE: { finding: 'Database dependency failure', recommendation: 'Review database connection-pool utilisation, active connections and connection limits; check database availability.' },
  DEPENDENCY: { finding: 'Downstream dependency failure', recommendation: 'Investigate the gateway / provider the API depends on; check that provider’s status.' },
  PERFORMANCE: { finding: 'Performance degradation', recommendation: 'Investigate downstream dependency and database performance; check for resource exhaustion.' },
  CONFIGURATION: { finding: 'Configuration issue', recommendation: 'Verify the endpoint, credentials, environment and required parameters for this target.' },
  NONE: { finding: 'No failure', recommendation: 'No action required.' },
};

function basePriority(category: FailureCategory, httpStatus: number | null): Recommendation['priority'] {
  if (category === 'NONE') return 'P3';
  if (category === 'CONNECTIVITY' || category === 'DATABASE' || category === 'DEPENDENCY') return 'P1';
  if (httpStatus != null && httpStatus >= 500) return 'P1';
  if (category === 'AUTHENTICATION' || category === 'PERFORMANCE') return 'P2';
  return 'P2';
}

/** Builds the recommendation for a classified failure. */
export function recommendationFor(input: RecommendationInput): Recommendation {
  const { category, failureType, httpStatus } = input;

  const base =
    (httpStatus != null && BY_HTTP[httpStatus]) ||
    (failureType != null && BY_FAILURE_TYPE[failureType]) ||
    BY_CATEGORY[category];

  let priority = basePriority(category, httpStatus);
  let recommendation = base.recommendation;

  const n = input.occurrences24h ?? 1;
  if (n >= 3) {
    priority = priority === 'P3' ? 'P2' : 'P1';
    recommendation += ` This is occurrence #${n} in the last 24h — treat as a recurring fault, not a blip, and open a problem ticket if one is not already tracked.`;
  } else if (n === 2) {
    recommendation += ' This has recurred within 24h — check whether the earlier occurrence was actually resolved or only auto-recovered.';
  }

  if (input.latencyRatio != null && input.latencyRatio >= 2) {
    recommendation += ` Latency is ~${input.latencyRatio.toFixed(1)}× the baseline — correlate the failure window with dependency and database metrics.`;
  }

  return { finding: base.finding, recommendation, priority };
}
