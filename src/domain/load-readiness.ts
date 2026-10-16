import type { LoadEnvironmentClass, LoadProfile } from './enums.js';
import type { RunVerdict } from './load-slo.js';

/**
 * Production-readiness assessment (Phase 27). Readiness is a set of GATES, not a
 * weighted average: a payment service with a duplicate-charge bug is not "87 %
 * ready". Correctness and security are hard gates; steady-state load is a hard
 * gate; spike, capacity and freshness are advisory unless they actively fail.
 *
 * Honesty rules built in:
 *  - evidence from the SIMULATOR can never make a service READY (it proves our
 *    tests work, not that the vendor’s service does);
 *  - a missing gate is INCOMPLETE, never silently passed;
 *  - the score is provisional and only a summary — the gates decide.
 */

export type ReadinessStatus = 'READY' | 'READY_WITH_WARNINGS' | 'NOT_READY' | 'INCOMPLETE';
export type GateStatus = 'PASS' | 'WARN' | 'FAIL' | 'MISSING';

export interface LoadEvidence {
  id: string;
  profile: LoadProfile;
  verdict: RunVerdict;
  finishedAt: string;
  environmentClass: LoadEnvironmentClass | null;
  /** Share of SLO checks that passed (PASS=1, WARN=0.6) — for the provisional score. */
  sloScore: number;
}

export interface SuiteEvidence {
  id: string;
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  warnings: number;
  skipped: number;
  finishedAt: string;
  environmentClass: LoadEnvironmentClass | null;
  assertionPassRatio: number;
}

export interface Gate {
  id: string;
  name: string;
  required: boolean;
  status: GateStatus;
  detail: string;
  evidenceId?: string;
}

export interface Readiness {
  status: ReadinessStatus;
  /** 0–100, provisional. Null when there is no evidence at all. */
  score: number | null;
  basis: 'simulator' | 'sandbox' | 'production' | 'mixed' | 'none';
  gates: Gate[];
  /** Why, most important first. */
  reasons: string[];
  /** Concrete next actions. */
  nextSteps: string[];
  asOf: string;
}

const DAY = 86_400_000;

export interface ReadinessInput {
  now: Date;
  load: LoadEvidence[];
  correctness: SuiteEvidence | null;
  security: SuiteEvidence | null;
  maxAgeDays?: number;
}

const latest = <T extends { finishedAt: string }>(xs: T[]): T | undefined =>
  [...xs].sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))[0];

function loadGate(
  id: string,
  name: string,
  required: boolean,
  ev: LoadEvidence | undefined,
  missing: string,
): Gate {
  if (!ev) return { id, name, required, status: 'MISSING', detail: missing };
  const base = { id, name, required, evidenceId: ev.id };
  switch (ev.verdict) {
    case 'PASS':
      return {
        ...base,
        status: 'PASS',
        detail: `Latest ${ev.profile} run passed every objective.`,
      };
    case 'PASS_WITH_WARNINGS':
      return {
        ...base,
        status: 'WARN',
        detail: `Latest ${ev.profile} run passed with thin margins.`,
      };
    case 'FAIL':
      return { ...base, status: 'FAIL', detail: `Latest ${ev.profile} run missed an objective.` };
    case 'INCONCLUSIVE':
      return {
        ...base,
        status: 'MISSING',
        detail: `Latest ${ev.profile} run was inconclusive (stopped early or the test tool saturated) — it does not count as evidence.`,
      };
  }
}

function suiteGate(id: string, name: string, ev: SuiteEvidence | null, missing: string): Gate {
  if (!ev) return { id, name, required: true, status: 'MISSING', detail: missing };
  const base = { id, name, required: true, evidenceId: ev.id };
  if (ev.verdict === 'INCONCLUSIVE')
    return {
      ...base,
      status: 'MISSING',
      detail: `The latest ${name.toLowerCase()} run could not judge the service (the test key lacked permissions) — it does not count as evidence.`,
    };
  if (ev.verdict === 'FAIL')
    return {
      ...base,
      status: 'FAIL',
      detail: `The latest ${name.toLowerCase()} run found defects.`,
    };
  if (ev.warnings > 0 || ev.skipped > 0) {
    return {
      ...base,
      status: 'WARN',
      detail: `Passed, with ${ev.warnings} hardening warning(s) and ${ev.skipped} check(s) that could not run in this environment.`,
    };
  }
  return {
    ...base,
    status: 'PASS',
    detail: `The latest ${name.toLowerCase()} run passed with no warnings.`,
  };
}

export function assessReadiness(input: ReadinessInput): Readiness {
  const { now, load, correctness, security } = input;
  const maxAge = (input.maxAgeDays ?? 30) * DAY;
  const steady = latest(load.filter((l) => l.profile === 'LOAD' || l.profile === 'SOAK'));
  const spike = latest(load.filter((l) => l.profile === 'SPIKE'));
  const limit = latest(load.filter((l) => l.profile === 'STRESS' || l.profile === 'BREAKPOINT'));

  const gates: Gate[] = [
    suiteGate(
      'correctness',
      'Money correctness',
      correctness,
      'No correctness run yet: idempotency, refunds, webhooks and the ledger are unverified.',
    ),
    suiteGate(
      'security',
      'Security',
      security,
      'No security run yet: the OWASP API checks have not been run.',
    ),
    loadGate(
      'steady-load',
      'Steady load',
      true,
      steady,
      'No LOAD or SOAK run yet: normal-peak behaviour is unmeasured.',
    ),
    loadGate(
      'spike',
      'Spike resilience',
      false,
      spike,
      'No SPIKE run yet: sudden surges are untested.',
    ),
    loadGate(
      'capacity',
      'Capacity limit',
      false,
      limit,
      'No BREAKPOINT or STRESS run yet: the ceiling is unknown.',
    ),
  ];
  // Optional gates that were never run are a gap to report, not a pass.
  for (const g of gates) if (!g.required && g.status === 'MISSING') g.status = 'WARN';

  const evidence = [correctness, security, steady, spike, limit].filter(Boolean) as {
    finishedAt: string;
    environmentClass: LoadEnvironmentClass | null;
  }[];
  const stale = evidence.filter((e) => now.getTime() - new Date(e.finishedAt).getTime() > maxAge);
  gates.push({
    id: 'freshness',
    name: 'Evidence is recent',
    required: false,
    status: evidence.length === 0 ? 'MISSING' : stale.length > 0 ? 'WARN' : 'PASS',
    detail:
      evidence.length === 0
        ? 'There is no evidence.'
        : stale.length > 0
          ? `${stale.length} piece(s) of evidence are older than ${input.maxAgeDays ?? 30} days.`
          : `All evidence is within ${input.maxAgeDays ?? 30} days.`,
  });

  const classes = new Set(evidence.map((e) => e.environmentClass));
  const basis: Readiness['basis'] =
    evidence.length === 0
      ? 'none'
      : classes.size === 1 && classes.has('MOCK')
        ? 'simulator'
        : classes.has('MOCK')
          ? 'mixed'
          : classes.has('PRODUCTION')
            ? 'production'
            : 'sandbox';
  gates.push({
    id: 'real-environment',
    name: 'Evidence comes from the real service',
    required: true,
    status:
      basis === 'simulator' || basis === 'none' ? 'MISSING' : basis === 'mixed' ? 'WARN' : 'PASS',
    detail:
      basis === 'simulator'
        ? 'All evidence is from the simulator. That proves the tests work, not that the iSmartPay service does.'
        : basis === 'none'
          ? 'There is no evidence.'
          : basis === 'mixed'
            ? 'Some evidence is from the simulator; only the sandbox/production runs count for readiness.'
            : `Evidence comes from the ${basis}.`,
  });

  const fails = gates.filter((g) => g.status === 'FAIL');
  const missingRequired = gates.filter((g) => g.required && g.status === 'MISSING');
  const warns = gates.filter((g) => g.status === 'WARN');
  const status: ReadinessStatus =
    fails.length > 0
      ? 'NOT_READY'
      : missingRequired.length > 0
        ? 'INCOMPLETE'
        : warns.length > 0
          ? 'READY_WITH_WARNINGS'
          : 'READY';

  const perfParts = [steady?.sloScore, spike?.sloScore, limit?.sloScore].filter(
    (x): x is number => x !== undefined,
  );
  const score =
    evidence.length === 0
      ? null
      : Math.round(
          30 * (correctness?.assertionPassRatio ?? 0) +
            30 * (security?.assertionPassRatio ?? 0) +
            40 * (perfParts.length ? perfParts.reduce((a, b) => a + b, 0) / perfParts.length : 0),
        );

  const reasons: string[] = [
    ...fails.map((g) => g.detail),
    ...missingRequired.map((g) => g.detail),
    ...warns.map((g) => g.detail),
  ];
  const nextSteps: string[] = [];
  for (const g of [...fails, ...missingRequired, ...warns]) {
    const step: Record<string, string> = {
      correctness:
        g.status === 'FAIL'
          ? 'Fix the failed correctness findings first — they are money-safety defects — then re-run the correctness suite.'
          : 'Run the correctness suite against the sandbox.',
      security:
        g.status === 'FAIL'
          ? 'Fix the failed security findings, then re-run the security suite.'
          : 'Run the security suite against the sandbox.',
      'steady-load':
        g.status === 'FAIL'
          ? 'Address the performance findings, then repeat the LOAD run.'
          : 'Run a LOAD plan at the expected peak rate against the sandbox.',
      spike: 'Run a SPIKE plan to check the service survives a sudden surge.',
      capacity: 'Run a BREAKPOINT plan to learn the ceiling, and set a required capacity.',
      freshness: 'Re-run the stale evidence so the decision reflects the current system.',
      'real-environment':
        'Repeat the runs against the iSmartPay sandbox (needs a test-console API key).',
    };
    if (step[g.id]) nextSteps.push(step[g.id]!);
  }

  return {
    status,
    score,
    basis,
    gates,
    reasons,
    nextSteps: [...new Set(nextSteps)],
    asOf: now.toISOString(),
  };
}
