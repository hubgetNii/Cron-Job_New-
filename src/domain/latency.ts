/**
 * Latency intelligence (spec §6). Per-endpoint-class default bands, plus the
 * assessment rule. A payment API is expected to be fast; an SMS or vending API
 * legitimately takes longer — so "abnormal" is relative, not a global number.
 */

import type { EndpointClass } from './enums.js';

export interface LatencyThresholds {
  normalMs: number;
  degradedMs: number;
  criticalMs: number;
}

/** Class-based defaults, used when a target has no custom `latency_thresholds` row. */
export const DEFAULT_LATENCY_THRESHOLDS_BY_CLASS: Record<EndpointClass, LatencyThresholds> = {
  payment_initiation: { normalMs: 500, degradedMs: 1000, criticalMs: 2000 },
  payment_status: { normalMs: 400, degradedMs: 800, criticalMs: 1500 },
  ledger: { normalMs: 500, degradedMs: 1200, criticalMs: 2500 },
  settlement: { normalMs: 800, degradedMs: 2000, criticalMs: 5000 },
  psp_gateway: { normalMs: 600, degradedMs: 1500, criticalMs: 3000 },
  kyc: { normalMs: 800, degradedMs: 2000, criticalMs: 5000 },
  auth: { normalMs: 500, degradedMs: 1200, criticalMs: 3000 },
  notification: { normalMs: 1500, degradedMs: 3000, criticalMs: 6000 },
  utility_vending: { normalMs: 1000, degradedMs: 3000, criticalMs: 8000 },
  reporting: { normalMs: 1500, degradedMs: 4000, criticalMs: 10000 },
  internal: { normalMs: 1000, degradedMs: 3000, criticalMs: 8000 },
};

export function resolveThresholds(
  endpointClass: EndpointClass,
  custom: LatencyThresholds | null,
): { thresholds: LatencyThresholds; source: 'custom' | 'default' } {
  return custom
    ? { thresholds: custom, source: 'custom' }
    : { thresholds: DEFAULT_LATENCY_THRESHOLDS_BY_CLASS[endpointClass], source: 'default' };
}

export type LatencyAssessment = 'NORMAL' | 'ELEVATED' | 'HIGH' | 'CRITICAL' | 'NO_DATA';

/**
 * Assessment from P95 vs the bands: P95 is stable against a single slow blip but
 * still catches a sustained regression.
 */
export function assessLatency(
  p95Ms: number | null,
  t: LatencyThresholds,
): LatencyAssessment {
  if (p95Ms == null) return 'NO_DATA';
  if (p95Ms >= t.criticalMs) return 'CRITICAL';
  if (p95Ms >= t.degradedMs) return 'HIGH';
  if (p95Ms >= t.normalMs) return 'ELEVATED';
  return 'NORMAL';
}

/** % the observed value sits above (or below) the historical baseline. */
export function deviationPercent(observedMs: number | null, baselineMs: number | null): number | null {
  if (observedMs == null || baselineMs == null || baselineMs <= 0) return null;
  return Number((((observedMs - baselineMs) / baselineMs) * 100).toFixed(1));
}
