import { z } from 'zod';
import { LOAD_PROFILES } from './enums.js';

/**
 * Load-test plan model (Phase 23). A plan is one request shape plus a traffic
 * profile; `buildStages` turns the profile into k6 `ramping-arrival-rate` stages
 * (open model: requests are *scheduled* at a rate regardless of response time,
 * which avoids the coordinated-omission under-reporting of closed-loop VUs).
 */

/** Headers that would put a credential in a stored plan. Auth is injected at run time. */
const FORBIDDEN_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'x-auth-token',
  'api-key',
]);

/** Each profile needs room for its stages (every stage lasts at least a second). */
export const MIN_DURATION_SECONDS: Record<(typeof LOAD_PROFILES)[number], number> = {
  SMOKE: 10,
  LOAD: 20,
  SOAK: 20,
  BREAKPOINT: 30,
  SPIKE: 30,
  STRESS: 60,
};

export const PlanConfigSchema = z
  .object({
    profile: z.enum(LOAD_PROFILES),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    headers: z
      .record(z.string(), z.string().max(1000))
      .default({})
      .refine((h) => !Object.keys(h).some((k) => FORBIDDEN_HEADERS.has(k.toLowerCase())), {
        message: 'Credential headers are injected at run time and may not be stored in a plan.',
      }),
    /**
     * Request path (replaces the target URL's path + query; the ORIGIN always
     * comes from the target, so a plan can never redirect traffic elsewhere).
     * May contain {{data.field}}. Omitted → the target's own URL is used as-is.
     */
    path: z
      .string()
      .min(1)
      .max(500)
      .regex(
        /^\/(?!\/)[^\s\\@]*$/,
        'path must start with a single "/" and contain no spaces, backslashes or "@"',
      )
      .optional(),
    /**
     * JSON body template. Supports {{idem}}, {{ref}}, {{iter}}, {{uuid}},
     * {{data.field}} and {"$repeat": N, "template": {...}} (index = {{i}}).
     */
    body: z.unknown().optional(),
    /** Approved synthetic data set whose records feed {{data.*}}. */
    dataSetId: z.string().uuid().optional(),
    dataSelection: z.enum(['sequential', 'random']).default('sequential'),
    /** Declares that this request moves money, whatever the target's own flag says. */
    moneyMoving: z.boolean().default(false),
    /** Declares real-world side effects (e.g. airtime actually delivered) even in test. */
    realSideEffects: z.boolean().default(false),
    /**
     * Payments (or other effects) produced by ONE request — e.g. a payout batch of
     * 10 items has fanout 10. The safety gate judges requests/s × fanout.
     */
    fanout: z.number().int().min(1).max(100).default(1),
    /**
     * Pass/fail thresholds for the report (see load-slo.ts). Omitted fields use
     * defaults derived from the request type (read / write / batch).
     */
    slo: z
      .object({
        p95Ms: z.number().positive().max(600_000),
        p99Ms: z.number().positive().max(600_000),
        maxServerErrorRate: z.number().min(0).max(1),
        minThroughputRatio: z.number().min(0.1).max(1),
        maxRateLimitedShare: z.number().min(0).max(1),
        maxClientErrorShare: z.number().min(0).max(1),
        /** Effects/s the service must sustain (e.g. the launch estimate). Used by STRESS / BREAKPOINT. */
        requiredCapacityRps: z.number().positive().nullable(),
      })
      .partial()
      .optional(),
    /** Scenario pack this plan was instantiated from (informational). */
    packId: z.string().max(100).optional(),
    /** Header carrying a unique per-request key; null disables. */
    idempotencyHeader: z.string().min(1).max(100).nullable().default('Idempotency-Key'),
    /** Normal-peak rps (LOAD/SOAK/SPIKE baseline), ceiling for BREAKPOINT. */
    targetRps: z.number().positive().max(100_000),
    durationSeconds: z.number().int().min(10).max(86_400),
    maxVus: z.number().int().positive().max(100_000),
    preAllocatedVus: z.number().int().positive().max(100_000).optional(),
    spikeMultiplier: z.number().min(2).max(50).default(10),
    expectedStatuses: z
      .array(z.number().int().min(100).max(599))
      .min(1)
      .default([200, 201, 202, 204]),
    timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
  })
  .refine((c) => c.durationSeconds >= MIN_DURATION_SECONDS[c.profile], {
    message: 'durationSeconds is too short for this profile',
    path: ['durationSeconds'],
  })
  .refine((c) => (c.preAllocatedVus ?? 1) <= c.maxVus, {
    message: 'preAllocatedVus may not exceed maxVus',
    path: ['preAllocatedVus'],
  });

export type PlanConfig = z.infer<typeof PlanConfigSchema>;

export interface Stage {
  durationSeconds: number;
  /** Target rps reached at the END of the stage (linear ramp from the previous). */
  target: number;
}

/** Splits `total` seconds by fractions; rounding remainder goes to the longest slice. */
function split(total: number, fractions: number[]): number[] {
  const parts = fractions.map((f) => Math.max(1, Math.floor(total * f)));
  const diff = total - parts.reduce((a, b) => a + b, 0);
  const longest = fractions.indexOf(Math.max(...fractions));
  parts[longest] = Math.max(1, (parts[longest] ?? 1) + diff);
  return parts;
}

const rate = (n: number): number => Math.max(1, Math.round(n));

export function buildStages(cfg: PlanConfig): Stage[] {
  const t = cfg.targetRps;
  const d = cfg.durationSeconds;
  const mk = (fr: number[], targets: number[]): Stage[] =>
    split(d, fr).map((durationSeconds, i) => ({ durationSeconds, target: targets[i] ?? 0 }));

  switch (cfg.profile) {
    case 'SMOKE':
      return mk([1], [Math.min(2, t)].map(rate));
    case 'LOAD':
      return mk([0.1, 0.8, 0.1], [rate(t), rate(t), 0]);
    case 'SOAK':
      return mk([0.05, 0.9, 0.05], [rate(t), rate(t), 0]);
    case 'STRESS': {
      const steps = [0.5, 1, 1.5, 2].map((m) => rate(t * m));
      return mk(
        [0.05, 0.2, 0.05, 0.2, 0.05, 0.2, 0.05, 0.2],
        steps.flatMap((s) => [s, s]),
      );
    }
    case 'SPIKE': {
      const peak = rate(t * cfg.spikeMultiplier);
      return mk([0.25, 0.05, 0.2, 0.05, 0.45], [rate(t), peak, peak, rate(t), rate(t)]);
    }
    case 'BREAKPOINT':
      return mk([1], [rate(t)]);
  }
}

/** Highest rps any stage reaches — what the safety gate must judge, not `targetRps`. */
export function peakRps(cfg: PlanConfig): number {
  return Math.max(...buildStages(cfg).map((s) => s.target));
}

/** Effective effects/s the safety gate must judge (requests/s × fanout at the peak stage). */
export const effectiveRps = (cfg: PlanConfig): number => peakRps(cfg) * cfg.fanout;

export const isMutating = (cfg: Pick<PlanConfig, 'method'>): boolean => cfg.method !== 'GET';

/** Everything the safety gate must treat as state-changing for this plan. */
export const isStateChanging = (cfg: Pick<PlanConfig, 'method' | 'moneyMoving'>): boolean =>
  cfg.method !== 'GET' || cfg.moneyMoving;

const DATA_REF = /\{\{data\.([A-Za-z0-9_.]+)\}\}/g;

/** Every `{{data.path}}` the plan's path/headers/body refer to — checked against the data set. */
export function dataFieldsUsed(cfg: Pick<PlanConfig, 'path' | 'headers' | 'body'>): string[] {
  const found = new Set<string>();
  const scan = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(DATA_REF)) found.add(m[1]!);
    } else if (Array.isArray(v)) v.forEach(scan);
    else if (v && typeof v === 'object') Object.values(v).forEach(scan);
  };
  scan(cfg.path);
  scan(cfg.headers);
  scan(cfg.body);
  return [...found].sort();
}
