import { describe, expect, it } from 'vitest';
import {
  assessLatency,
  deviationPercent,
  DEFAULT_LATENCY_THRESHOLDS_BY_CLASS,
  resolveThresholds,
} from './latency.js';

describe('assessLatency', () => {
  const t = { normalMs: 500, degradedMs: 1000, criticalMs: 2000 };
  it.each([
    [null, 'NO_DATA'],
    [200, 'NORMAL'],
    [700, 'ELEVATED'],
    [1200, 'HIGH'],
    [2842, 'CRITICAL'],
  ] as const)('P95 %s → %s', (p95, expected) => {
    expect(assessLatency(p95, t)).toBe(expected);
  });
});

describe('resolveThresholds', () => {
  it('uses the class default when no custom row', () => {
    const r = resolveThresholds('payment_status', null);
    expect(r.source).toBe('default');
    expect(r.thresholds).toEqual(DEFAULT_LATENCY_THRESHOLDS_BY_CLASS['payment_status']);
  });
  it('prefers a custom row', () => {
    const custom = { normalMs: 100, degradedMs: 200, criticalMs: 300 };
    expect(resolveThresholds('notification', custom)).toEqual({ thresholds: custom, source: 'custom' });
  });
});

describe('deviationPercent', () => {
  it('computes +577% for 2842 vs 420 baseline', () => {
    expect(deviationPercent(2842, 420)).toBeCloseTo(576.7, 0);
  });
  it('is null without both values', () => {
    expect(deviationPercent(null, 100)).toBeNull();
    expect(deviationPercent(100, null)).toBeNull();
    expect(deviationPercent(100, 0)).toBeNull();
  });
});
