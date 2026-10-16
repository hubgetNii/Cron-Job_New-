import type { LoadRunReport } from './loadtest';

/** Run comparison (B11): pure helpers so the page stays declarative. */

export type Direction = 'lower' | 'higher';
export type Change = 'better' | 'worse' | 'same';

export interface MetricDiff {
  label: string;
  unit: string;
  a: number;
  b: number;
  delta: number;
  pct: number | null;
  change: Change;
}

/** A change under this share of the baseline is noise, not a finding. */
export const NOISE = 0.05;

export function diff(
  label: string,
  unit: string,
  a: number,
  b: number,
  better: Direction,
): MetricDiff {
  const delta = b - a;
  const pct = a === 0 ? null : delta / a;
  const material = pct === null ? delta !== 0 : Math.abs(pct) >= NOISE;
  const improved = better === 'lower' ? delta < 0 : delta > 0;
  return {
    label,
    unit,
    a,
    b,
    delta,
    pct,
    change: !material ? 'same' : improved ? 'better' : 'worse',
  };
}

export function metricDiffs(a: LoadRunReport, b: LoadRunReport): MetricDiff[] {
  const la = a.results.latency;
  const lb = b.results.latency;
  const ta = a.results.throughput;
  const tb = b.results.throughput;
  const errRate = (r: LoadRunReport): number => {
    const t = r.results.throughput.totalRequests;
    const failed = Object.entries(r.results.errors.statusCounts)
      .filter(([s]) => !/^2/.test(s))
      .reduce((n, [, c]) => n + c, 0);
    return t === 0 ? 0 : (failed / t) * 100;
  };
  return [
    diff('Response time p50', 'ms', la.p50Ms, lb.p50Ms, 'lower'),
    diff('Response time p95', 'ms', la.p95Ms, lb.p95Ms, 'lower'),
    diff('Response time p99', 'ms', la.p99Ms, lb.p99Ms, 'lower'),
    diff('Slowest response', 'ms', la.maxMs, lb.maxMs, 'lower'),
    diff('Non-2xx responses', '%', errRate(a), errRate(b), 'lower'),
    diff('Average throughput', 'rps', ta.achievedAvgRps, tb.achievedAvgRps, 'higher'),
    diff('Peak throughput', 'rps', ta.peakRps, tb.peakRps, 'higher'),
    diff('Max sustained throughput', 'rps', ta.maxSustainedRps, tb.maxSustainedRps, 'higher'),
    diff('Total requests', '', ta.totalRequests, tb.totalRequests, 'higher'),
  ];
}

/** Why a comparison may mislead. Empty when the two runs are like for like. */
export function comparability(a: LoadRunReport, b: LoadRunReport): string[] {
  const out: string[] = [];
  if (a.meta.target.id !== b.meta.target.id) out.push('The runs tested different services.');
  if (a.tested.profile !== b.tested.profile)
    out.push(`Different profiles (${a.tested.profile} vs ${b.tested.profile}).`);
  if (a.tested.shape !== b.tested.shape)
    out.push(`Different load shapes (“${a.tested.shape}” vs “${b.tested.shape}”).`);
  if (a.tested.packId !== b.tested.packId) out.push('Different scenarios.');
  if (a.meta.environment.label !== b.meta.environment.label) out.push('Different environments.');
  if (a.meta.environment.isReal !== b.meta.environment.isReal)
    out.push('One run is simulator evidence, the other is not.');
  if (a.logs.generator.saturated || b.logs.generator.saturated)
    out.push('A run saturated the load generator, so its numbers understate the service.');
  return out;
}

export const fmt = (n: number, unit: string): string => {
  const v =
    Math.abs(n) >= 100 ? Math.round(n).toLocaleString() : n.toFixed(Math.abs(n) < 10 ? 2 : 1);
  return unit ? `${v} ${unit}` : v;
};
