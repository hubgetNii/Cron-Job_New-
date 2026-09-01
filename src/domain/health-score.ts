/**
 * Service health score (spec §11). A single 0–100 number per service from four
 * weighted sub-scores. The weights are configurable (env `HEALTH_SCORE_WEIGHTS`).
 * Pure — the service layer supplies the sub-scores from the data.
 */

export interface ScoreWeights {
  availability: number;
  latency: number;
  errorRate: number;
  dependencyHealth: number;
}

export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  availability: 40,
  latency: 25,
  errorRate: 20,
  dependencyHealth: 15,
};

/** Parses "40,25,20,15" (availability,latency,errorRate,dependency). Falls back to defaults. */
export function parseWeights(raw: string | undefined): ScoreWeights {
  if (!raw) return DEFAULT_SCORE_WEIGHTS;
  const parts = raw.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    return DEFAULT_SCORE_WEIGHTS;
  }
  const [availability, latency, errorRate, dependencyHealth] = parts as [
    number,
    number,
    number,
    number,
  ];
  return { availability, latency, errorRate, dependencyHealth };
}

export interface SubScores {
  /** each 0–100; null = no data, excluded from the weighted mean */
  availability: number | null;
  latency: number | null;
  errorRate: number | null;
  dependencyHealth: number | null;
}

export type ScoreBand = 'HEALTHY' | 'DEGRADED' | 'CRITICAL' | 'NO_DATA';

export interface HealthScoreResult {
  score: number | null;
  band: ScoreBand;
  contributions: {
    key: keyof SubScores;
    sub: number | null;
    weight: number;
    /** weight-normalised points this sub-score adds to the final score */
    points: number | null;
  }[];
}

function band(score: number | null): ScoreBand {
  if (score == null) return 'NO_DATA';
  if (score >= 85) return 'HEALTHY';
  if (score >= 60) return 'DEGRADED';
  return 'CRITICAL';
}

/** Weighted mean over the sub-scores that have data. */
export function computeHealthScore(subs: SubScores, weights: ScoreWeights): HealthScoreResult {
  const keys: (keyof SubScores)[] = [
    'availability',
    'latency',
    'errorRate',
    'dependencyHealth',
  ];
  const present = keys.filter((k) => subs[k] != null);
  const totalWeight = present.reduce((sum, k) => sum + weights[k], 0);

  const contributions = keys.map((key) => {
    const sub = subs[key];
    const weight = weights[key];
    const points =
      sub == null || totalWeight === 0 ? null : Number(((sub * weight) / totalWeight).toFixed(1));
    return { key, sub, weight, points };
  });

  const score =
    totalWeight === 0
      ? null
      : Number(
          contributions
            .reduce((sum, c) => sum + (c.points ?? 0), 0)
            .toFixed(1),
        );

  return { score, band: band(score), contributions };
}

/* --- sub-score curves ------------------------------------------------------ */

/** Availability: the uptime % maps almost straight through, with a floor. */
export function availabilitySubScore(uptimePercent: number | null): number | null {
  if (uptimePercent == null) return null;
  return Math.max(0, Math.min(100, uptimePercent));
}

/** Latency: 100 at/below `normalMs`, 0 at/above `criticalMs`, linear between. */
export function latencySubScore(
  p95Ms: number | null,
  normalMs: number,
  criticalMs: number,
): number | null {
  if (p95Ms == null) return null;
  if (p95Ms <= normalMs) return 100;
  if (p95Ms >= criticalMs) return 0;
  return Number((100 * (1 - (p95Ms - normalMs) / (criticalMs - normalMs))).toFixed(1));
}

/** Error rate: 0% → 100, 12%+ → 0, quadratic in between (small rates barely hurt). */
export function errorRateSubScore(errorRatePercent: number | null): number | null {
  if (errorRatePercent == null) return null;
  const r = Math.max(0, Math.min(1, errorRatePercent / 12));
  return Number((100 * (1 - r) ** 2).toFixed(1));
}

/**
 * Dependency health: starts at 100, penalised by open incidents whose RCA
 * implicates a downstream (DEPENDENCY / DATABASE) and by recent flapping.
 */
export function dependencySubScore(input: {
  openIncident: boolean;
  openIncidentCategory: string | null;
  dependencyIncidents24h: number;
  flapping24h: number;
}): number {
  let s = 100;
  if (input.openIncident) {
    s -= input.openIncidentCategory === 'DEPENDENCY' || input.openIncidentCategory === 'DATABASE'
      ? 55
      : 25;
  }
  s -= Math.min(30, input.dependencyIncidents24h * 15);
  s -= Math.min(20, input.flapping24h * 10);
  return Math.max(0, Math.round(s));
}
