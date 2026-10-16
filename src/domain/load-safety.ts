import type { Environment, LoadAuthorizationStatus, LoadEnvironmentClass } from './enums.js';
import { LOAD_ENVIRONMENT_CLASSES } from './enums.js';

/**
 * Load-test safety gate (Phase 21). A pure function: every decision to start
 * load against a target flows through `evaluateLoadSafety`, and *every* rule
 * must pass. Deny by default — missing config or authorization is a violation,
 * never an implicit allow.
 */

export interface LoadCeiling {
  maxRps: number;
  maxVus: number;
  maxDurationSeconds: number;
}
export type LoadCeilings = Record<LoadEnvironmentClass, LoadCeiling>;

export interface HostLists {
  production: string[];
  sandbox: string[];
  mock: string[];
}

export interface SafetyAuthorization {
  status: LoadAuthorizationStatus;
  windowStart: Date;
  windowEnd: Date;
  maxRps: number;
  maxVus: number;
  maxDurationSeconds: number;
  allowRealSideEffects: boolean;
}

export interface SafetyInput {
  now: Date;
  enabled: boolean;
  killSwitch: boolean;
  target: { url: string; isMoneyMoving: boolean; environment: Environment };
  config: { environmentClass: LoadEnvironmentClass; hasRealSideEffects: boolean } | null;
  authorization: SafetyAuthorization | null;
  plan: {
    rps: number;
    vus: number;
    durationSeconds: number;
    mutating: boolean;
    /** The plan itself declares real-world side effects (in addition to the target's flag). */
    realSideEffects?: boolean;
  };
  hosts: HostLists;
  ceilings: LoadCeilings;
  realSideEffectMaxRps: number;
}

export interface SafetyViolation {
  code: string;
  message: string;
}

export interface SafetyDecision {
  allowed: boolean;
  effectiveClass: LoadEnvironmentClass | null;
  violations: SafetyViolation[];
}

const STRICTNESS: Record<LoadEnvironmentClass, number> = {
  MOCK: 0,
  SANDBOX: 1,
  STAGING: 2,
  PRODUCTION: 3,
};

/** Maps the monitor's own environment label onto the stricter load class. */
function classFromEnvironment(e: Environment): LoadEnvironmentClass {
  return e === 'production' ? 'PRODUCTION' : e === 'staging' ? 'STAGING' : 'SANDBOX';
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

export function parseHostList(csv: string): string[] {
  return csv
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** Parses "MOCK:5000/2000/3600,SANDBOX:…" — every class must be present. */
export function parseCeilings(spec: string): LoadCeilings {
  const out: Partial<LoadCeilings> = {};
  for (const part of spec.split(',')) {
    const [cls, nums] = part.trim().split(':');
    const [rps, vus, dur] = (nums ?? '').split('/').map(Number);
    if (
      !cls ||
      !(LOAD_ENVIRONMENT_CLASSES as readonly string[]).includes(cls) ||
      ![rps, vus, dur].every((n) => Number.isFinite(n) && (n as number) > 0)
    ) {
      throw new Error(`Invalid LOAD_TEST_CEILINGS entry: "${part}"`);
    }
    out[cls as LoadEnvironmentClass] = {
      maxRps: rps as number,
      maxVus: vus as number,
      maxDurationSeconds: dur as number,
    };
  }
  for (const c of LOAD_ENVIRONMENT_CLASSES) {
    if (!out[c]) throw new Error(`LOAD_TEST_CEILINGS is missing class ${c}`);
  }
  return out as LoadCeilings;
}

export function evaluateLoadSafety(i: SafetyInput): SafetyDecision {
  const v: SafetyViolation[] = [];
  const add = (code: string, message: string): void => {
    v.push({ code, message });
  };

  if (!i.enabled)
    add('LOAD_TESTING_DISABLED', 'Load testing is disabled (LOAD_TEST_ENABLED=false).');
  if (i.killSwitch) add('KILL_SWITCH', 'The load-test kill switch is engaged.');

  if (!i.config) {
    add('NO_CONFIG', 'Target has no load-test environment classification (deny by default).');
    return { allowed: false, effectiveClass: null, violations: v };
  }

  // The stricter of the configured class and the monitor's own environment wins,
  // so a target cannot be "downgraded" to dodge production rules.
  const envClass = classFromEnvironment(i.target.environment);
  const configured = i.config.environmentClass;
  const effective =
    configured !== 'MOCK' && STRICTNESS[envClass] > STRICTNESS[configured] ? envClass : configured;
  if (i.target.environment === 'production' && configured !== 'PRODUCTION') {
    add(
      'CLASS_DOWNGRADE',
      `Target environment is production but its load class is ${configured}. Fix the classification.`,
    );
  }

  // Host guard — never let a "sandbox" classification point at a production host.
  const host = hostOf(i.target.url);
  if (!host) {
    add('BAD_URL', 'Target URL could not be parsed.');
  } else {
    const isProdHost = i.hosts.production.includes(host);
    if (isProdHost && effective !== 'PRODUCTION') {
      add('HOST_IS_PRODUCTION', `Host ${host} is a production host but the class is ${effective}.`);
    }
    if (effective === 'MOCK' && !i.hosts.mock.includes(host)) {
      add('HOST_NOT_MOCK', `Host ${host} is not an allow-listed simulator host.`);
    }
    if ((effective === 'SANDBOX' || effective === 'STAGING') && !i.hosts.sandbox.includes(host)) {
      add('HOST_NOT_ALLOWLISTED', `Host ${host} is not on the sandbox/staging allow-list.`);
    }
    if (effective === 'PRODUCTION' && !isProdHost && !i.hosts.sandbox.includes(host)) {
      add('HOST_UNKNOWN', `Host ${host} is not a known production host.`);
    }
  }

  const stateChanging = i.target.isMoneyMoving || i.plan.mutating;
  if (effective === 'PRODUCTION' && stateChanging) {
    add(
      'PRODUCTION_STATE_CHANGING',
      'State-changing / money-moving load on PRODUCTION is never permitted.',
    );
  }

  const ceiling = i.ceilings[effective];
  if (i.plan.rps > ceiling.maxRps)
    add(
      'CEILING_RPS',
      `Plan rps ${i.plan.rps} exceeds the ${effective} ceiling ${ceiling.maxRps}.`,
    );
  if (i.plan.vus > ceiling.maxVus)
    add(
      'CEILING_VUS',
      `Plan vus ${i.plan.vus} exceeds the ${effective} ceiling ${ceiling.maxVus}.`,
    );
  if (i.plan.durationSeconds > ceiling.maxDurationSeconds)
    add(
      'CEILING_DURATION',
      `Plan duration ${i.plan.durationSeconds}s exceeds the ${effective} ceiling ${ceiling.maxDurationSeconds}s.`,
    );

  // Authorization — required for everything except the local simulator.
  const a = i.authorization;
  if (effective !== 'MOCK') {
    if (!a) {
      add('AUTH_REQUIRED', 'No load-test authorization exists for this target.');
    } else {
      if (a.status !== 'APPROVED')
        add('AUTH_NOT_APPROVED', `Authorization is ${a.status}, not APPROVED.`);
      const end = i.now.getTime() + i.plan.durationSeconds * 1000;
      if (i.now < a.windowStart || end > a.windowEnd.getTime())
        add('AUTH_OUTSIDE_WINDOW', 'The run does not fit inside the authorized window.');
      if (i.plan.rps > a.maxRps) add('AUTH_CAP_RPS', `Plan rps exceeds authorized ${a.maxRps}.`);
      if (i.plan.vus > a.maxVus) add('AUTH_CAP_VUS', `Plan vus exceeds authorized ${a.maxVus}.`);
      if (i.plan.durationSeconds > a.maxDurationSeconds)
        add('AUTH_CAP_DURATION', `Plan duration exceeds authorized ${a.maxDurationSeconds}s.`);
    }
  }

  // Real side effects (airtime/data actually delivered, real SMS, …).
  if ((i.config.hasRealSideEffects || i.plan.realSideEffects === true) && effective !== 'MOCK') {
    if (!a?.allowRealSideEffects) {
      add(
        'REAL_SIDE_EFFECTS',
        'This endpoint has real-world side effects even outside production; the authorization must explicitly allow them.',
      );
    }
    if (i.plan.rps > i.realSideEffectMaxRps) {
      add(
        'REAL_SIDE_EFFECTS_RPS',
        `Real-side-effect endpoints are capped at ${i.realSideEffectMaxRps} rps.`,
      );
    }
  }

  return { allowed: v.length === 0, effectiveClass: effective, violations: v };
}
