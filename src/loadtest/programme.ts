import type { LoadProfile } from '../domain/enums.js';
import type { LoadCeiling } from '../domain/load-safety.js';

/**
 * The test programme (register item A6). Two volume scenarios supplied by the
 * business on 2026-10-16 — both PROVISIONAL, pending confirmed launch volumes:
 *
 *   Test 1  10,000 transactions/day — sustained peak 10 TPS, high load 20, stress to 50
 *   Test 2  100,000 transactions/day — average 1.16 TPS (not a peak target), peak 20, stress 50
 *
 * A tier is expressed by what the service must actually see (`peakRps`); the helper
 * below derives the plan's base rate for the profile's own shape (a STRESS plan ramps
 * to 2× its base, a SPIKE plan multiplies it).
 */

export interface Tier {
  id: string;
  label: string;
  purpose: string;
  profile: LoadProfile;
  /** Highest requests/s the service sees. */
  peakRps: number;
  durationSeconds: number;
  maxVus: number;
  /** SPIKE only: rate before the burst. */
  spikeFromRps?: number;
  /** The service must hold at least this many requests/s cleanly (null = discover the limit). */
  requiredCapacityRps: number | null;
}

export interface Programme {
  id: string;
  title: string;
  dailyVolume: number;
  averageTps: number;
  note: string;
  tiers: Tier[];
}

const H = 3600;

export const PROGRAMMES: Programme[] = [
  {
    id: 'test-1',
    title: 'Test 1 — 10,000 transactions/day',
    dailyVolume: 10_000,
    averageTps: 0.12,
    note: 'First target. Sustained peak 10 TPS, high load 20 TPS, stress to 50 TPS. Covers collections, disbursements, authentication, transaction status, callbacks and reconciliation. Acceptance depends on response-time SLAs, transaction integrity, error rates and payment-provider capacity.',
    tiers: [
      {
        id: 't1-normal',
        label: 'Normal load',
        purpose: 'Validate routine transaction processing',
        profile: 'LOAD',
        peakRps: 5,
        durationSeconds: 30 * 60,
        maxVus: 100,
        requiredCapacityRps: null,
      },
      {
        id: 't1-peak',
        label: 'Expected peak',
        purpose: 'Launch-day and busy-period demand',
        profile: 'LOAD',
        peakRps: 10,
        durationSeconds: 30 * 60,
        maxVus: 250,
        requiredCapacityRps: 10,
      },
      {
        id: 't1-high',
        label: 'High load',
        purpose: 'Capacity above expected demand',
        profile: 'LOAD',
        peakRps: 20,
        durationSeconds: 30 * 60,
        maxVus: 500,
        requiredCapacityRps: 10,
      },
      {
        id: 't1-stress',
        label: 'Stress test',
        purpose: 'Find bottlenecks and the breaking point (ramps to 50 TPS)',
        profile: 'STRESS',
        peakRps: 50,
        durationSeconds: 40 * 60,
        maxVus: 1000,
        requiredCapacityRps: 10,
      },
      {
        id: 't1-spike',
        label: 'Spike test',
        purpose: 'Sudden surge from 10 to 30 TPS',
        profile: 'SPIKE',
        spikeFromRps: 10,
        peakRps: 30,
        durationSeconds: 20 * 60,
        maxVus: 500,
        requiredCapacityRps: 10,
      },
      {
        id: 't1-endurance',
        label: 'Endurance test',
        purpose: 'Memory leaks, resource exhaustion, gradual degradation (10 TPS for 8 hours)',
        profile: 'SOAK',
        peakRps: 10,
        durationSeconds: 8 * H,
        maxVus: 250,
        requiredCapacityRps: 10,
      },
    ],
  },
  {
    id: 'test-2',
    title: 'Test 2 — 100,000 transactions/day',
    dailyVolume: 100_000,
    averageTps: 1.16,
    note: 'Follow-up after Test 1. The 1.16 TPS daily average is not a peak target by itself; the sustained peak to prove is 20 TPS, with stress to 50 TPS.',
    tiers: [
      {
        id: 't2-baseline',
        label: 'Baseline',
        purpose: 'Confirm basic performance',
        profile: 'LOAD',
        peakRps: 2,
        durationSeconds: 30 * 60,
        maxVus: 50,
        requiredCapacityRps: null,
      },
      {
        id: 't2-expected',
        label: 'Expected load',
        purpose: 'Validate routine activity',
        profile: 'LOAD',
        peakRps: 5,
        durationSeconds: H,
        maxVus: 100,
        requiredCapacityRps: null,
      },
      {
        id: 't2-peak',
        label: 'Peak load',
        purpose: 'Validate busy periods',
        profile: 'LOAD',
        peakRps: 20,
        durationSeconds: H,
        maxVus: 500,
        requiredCapacityRps: 20,
      },
      {
        id: 't2-stress',
        label: 'Stress test',
        purpose: 'Increase gradually to 50 TPS to find capacity limits',
        profile: 'STRESS',
        peakRps: 50,
        durationSeconds: 40 * 60,
        maxVus: 1000,
        requiredCapacityRps: 20,
      },
      {
        id: 't2-spike',
        label: 'Spike test',
        purpose: 'Repeated bursts from 5 to 30 TPS',
        profile: 'SPIKE',
        spikeFromRps: 5,
        peakRps: 30,
        durationSeconds: 30 * 60,
        maxVus: 500,
        requiredCapacityRps: 20,
      },
      {
        id: 't2-endurance',
        label: 'Endurance test',
        purpose: 'Resource leaks and degradation (10 TPS for 8 hours; extend to 24 later)',
        profile: 'SOAK',
        peakRps: 10,
        durationSeconds: 8 * H,
        maxVus: 250,
        requiredCapacityRps: null,
      },
    ],
  },
];

export interface FittedTier extends Tier {
  /** Values to put in the plan (`targetRps` is the profile's base rate). */
  plan: {
    profile: LoadProfile;
    targetRps: number;
    durationSeconds: number;
    maxVus: number;
    spikeMultiplier?: number;
    requiredCapacityRps: number | null;
  };
  /** True when nothing had to be reduced. */
  fits: boolean;
  /** What the sandbox ceiling forces us to reduce, in plain words. */
  reductions: string[];
}

/** Derives the plan's base rate from the rate the service should peak at. */
export function baseRpsFor(t: Pick<Tier, 'profile' | 'peakRps' | 'spikeFromRps'>): number {
  if (t.profile === 'STRESS') return Math.max(1, Math.floor(t.peakRps / 2));
  if (t.profile === 'SPIKE') return Math.max(1, t.spikeFromRps ?? Math.round(t.peakRps / 3));
  return t.peakRps;
}

/**
 * Fits a tier under a class ceiling. The ceiling is never raised to suit a tier:
 * it is reduced and the reduction is reported, so a capped run is never mistaken
 * for the full target.
 */
export function fitTier(t: Tier, ceiling: LoadCeiling): FittedTier {
  const reductions: string[] = [];
  let peak = t.peakRps;
  if (peak > ceiling.maxRps) {
    reductions.push(`peak ${peak} → ${ceiling.maxRps} requests/s`);
    peak = ceiling.maxRps;
  }
  let vus = t.maxVus;
  if (vus > ceiling.maxVus) {
    reductions.push(`virtual users ${vus} → ${ceiling.maxVus}`);
    vus = ceiling.maxVus;
  }
  let dur = t.durationSeconds;
  if (dur > ceiling.maxDurationSeconds) {
    reductions.push(
      `duration ${Math.round(dur / 60)} → ${Math.round(ceiling.maxDurationSeconds / 60)} min`,
    );
    dur = ceiling.maxDurationSeconds;
  }
  const capped: Tier = { ...t, peakRps: peak };
  const base = baseRpsFor(capped);
  const spike =
    t.profile === 'SPIKE' ? Math.max(2, Math.floor(peak / Math.max(1, base))) : undefined;
  if (t.requiredCapacityRps != null && peak < t.requiredCapacityRps) {
    reductions.push(
      `cannot prove the required ${t.requiredCapacityRps} requests/s while capped at ${peak}`,
    );
  }
  return {
    ...t,
    fits: reductions.length === 0,
    reductions,
    plan: {
      profile: t.profile,
      targetRps: base,
      durationSeconds: dur,
      maxVus: vus,
      ...(spike !== undefined ? { spikeMultiplier: spike } : {}),
      requiredCapacityRps: t.requiredCapacityRps,
    },
  };
}
