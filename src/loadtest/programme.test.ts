import { describe, expect, it } from 'vitest';
import { peakRps } from '../domain/load-plan.js';
import { parseCeilings } from '../domain/load-safety.js';
import { PROGRAMMES, baseRpsFor, fitTier } from './programme.js';
import { PACKS, packById, planFromPack } from './packs/packs.js';

const SANDBOX = parseCeilings(
  'MOCK:5000/2000/3600,SANDBOX:25/100/1800,STAGING:25/100/1800,PRODUCTION:2/5/300',
).SANDBOX;
const MOCK = parseCeilings(
  'MOCK:5000/2000/36000,SANDBOX:25/100/1800,STAGING:25/100/1800,PRODUCTION:2/5/300',
).MOCK;
const read = packById('collection-status-poll')!;

describe('test programme', () => {
  it('carries the agreed headline numbers', () => {
    const [t1, t2] = PROGRAMMES;
    expect(t1!.dailyVolume).toBe(10_000);
    expect(t2!.dailyVolume).toBe(100_000);
    expect(t2!.averageTps).toBeCloseTo(100_000 / 86_400, 1);
    const stress = (p: typeof t1) => p!.tiers.find((t) => t.profile === 'STRESS')!;
    expect(stress(t1).peakRps).toBe(50);
    expect(stress(t2).peakRps).toBe(50);
  });

  it('each tier, unconstrained, produces a plan whose real peak equals the tier peak', () => {
    for (const p of PROGRAMMES) {
      for (const tier of p.tiers) {
        const fitted = fitTier(tier, MOCK);
        const cfg = planFromPack(read, fitted.plan);
        expect(peakRps(cfg), tier.id).toBe(tier.peakRps);
        expect(fitted.fits, tier.id).toBe(true);
      }
    }
  });

  it('under the sandbox ceiling no tier ever exceeds it, and every reduction is reported', () => {
    for (const p of PROGRAMMES) {
      for (const tier of p.tiers) {
        const fitted = fitTier(tier, SANDBOX);
        const cfg = planFromPack(read, fitted.plan);
        expect(peakRps(cfg), tier.id).toBeLessThanOrEqual(SANDBOX.maxRps);
        expect(cfg.maxVus).toBeLessThanOrEqual(SANDBOX.maxVus);
        expect(cfg.durationSeconds).toBeLessThanOrEqual(SANDBOX.maxDurationSeconds);
        const reduced =
          tier.peakRps > SANDBOX.maxRps ||
          tier.maxVus > SANDBOX.maxVus ||
          tier.durationSeconds > SANDBOX.maxDurationSeconds;
        expect(fitted.fits, tier.id).toBe(!reduced);
        if (reduced) expect(fitted.reductions.length, tier.id).toBeGreaterThan(0);
      }
    }
  });

  it('refuses to claim a capped stress run proves the required capacity', () => {
    const t = PROGRAMMES[1]!.tiers.find((x) => x.id === 't2-peak')!;
    const fitted = fitTier(t, SANDBOX); // 20 required, ceiling 25 → fine
    expect(fitted.reductions.some((r) => r.includes('cannot prove'))).toBe(false);
    const low = fitTier(t, { ...SANDBOX, maxRps: 10 });
    expect(low.reductions.some((r) => r.includes('cannot prove'))).toBe(true);
  });

  it('derives the base rate from each profile shape', () => {
    expect(baseRpsFor({ profile: 'STRESS', peakRps: 50 })).toBe(25);
    expect(baseRpsFor({ profile: 'LOAD', peakRps: 10 })).toBe(10);
    expect(baseRpsFor({ profile: 'SPIKE', peakRps: 30, spikeFromRps: 5 })).toBe(5);
  });

  it('works with every pack (shape is pack independent)', () => {
    const tier = fitTier(PROGRAMMES[0]!.tiers[1]!, SANDBOX);
    for (const pack of PACKS.filter((p) => p.dataFields.length === 0)) {
      expect(() => planFromPack(pack, tier.plan)).not.toThrow();
    }
  });
});
