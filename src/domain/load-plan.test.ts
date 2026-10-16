import { describe, expect, it } from 'vitest';
import {
  buildStages,
  isMutating,
  peakRps,
  PlanConfigSchema,
  type PlanConfig,
} from './load-plan.js';

const cfg = (over: Record<string, unknown> = {}): PlanConfig =>
  PlanConfigSchema.parse({
    profile: 'LOAD',
    targetRps: 100,
    durationSeconds: 100,
    maxVus: 200,
    ...over,
  });

const total = (c: PlanConfig): number => buildStages(c).reduce((s, x) => s + x.durationSeconds, 0);

describe('buildStages', () => {
  it.each(['SMOKE', 'LOAD', 'STRESS', 'SPIKE', 'SOAK', 'BREAKPOINT'] as const)(
    '%s stages sum to the requested duration',
    (profile) => {
      for (const durationSeconds of [60, 97, 100, 3600]) {
        const c = cfg({ profile, durationSeconds });
        expect(total(c)).toBe(durationSeconds);
        expect(buildStages(c).every((s) => s.durationSeconds >= 1 && s.target >= 0)).toBe(true);
      }
    },
  );

  it('LOAD ramps up, holds, ramps down', () => {
    expect(buildStages(cfg())).toEqual([
      { durationSeconds: 10, target: 100 },
      { durationSeconds: 80, target: 100 },
      { durationSeconds: 10, target: 0 },
    ]);
  });

  it('SMOKE is tiny regardless of target', () => {
    expect(peakRps(cfg({ profile: 'SMOKE', targetRps: 500 }))).toBe(2);
  });

  it('SPIKE and STRESS peak above the target — the safety gate must see that', () => {
    expect(peakRps(cfg({ profile: 'SPIKE', spikeMultiplier: 10 }))).toBe(1000);
    expect(peakRps(cfg({ profile: 'STRESS' }))).toBe(200);
    expect(peakRps(cfg({ profile: 'LOAD' }))).toBe(100);
  });
});

describe('PlanConfigSchema', () => {
  it('refuses credential headers in any casing', () => {
    expect(() => cfg({ headers: { Authorization: 'Bearer x' } })).toThrow(/Credential headers/);
    expect(() => cfg({ headers: { 'X-API-Key': 'k' } })).toThrow();
    expect(cfg({ headers: { 'X-Trace': '1' } }).headers).toEqual({ 'X-Trace': '1' });
  });

  it('bounds duration and VUs and defaults expected statuses', () => {
    expect(() => cfg({ durationSeconds: 5 })).toThrow();
    expect(() => cfg({ profile: 'STRESS', durationSeconds: 30 })).toThrow(/too short/);
    expect(() => cfg({ preAllocatedVus: 500 })).toThrow(/preAllocatedVus/);
    expect(cfg().expectedStatuses).toContain(202);
  });

  it('treats everything except GET as mutating', () => {
    expect(isMutating({ method: 'GET' })).toBe(false);
    expect(isMutating({ method: 'POST' })).toBe(true);
    expect(isMutating({ method: 'DELETE' })).toBe(true);
  });
});
