import { buildStages, type PlanConfig } from './load-plan.js';

/**
 * SLO evaluation for a finished load run (Phase 27). A pure function: it turns
 * the aggregated run numbers into graded checks, each with a plain-language
 * explanation, and one verdict. Business readers see the sentence; engineers
 * see the target and the actual.
 *
 * Verdicts:
 *   PASS                the target met every objective
 *   PASS_WITH_WARNINGS  met them, but with thin margins
 *   FAIL                the target missed an objective, or began failing
 *   INCONCLUSIVE        the run does not prove anything: the test tool saturated,
 *                       the run was stopped by a person/kill switch, credentials
 *                       or limits invalidated it, or the runner itself failed
 */

export interface SloTargets {
  p95Ms: number;
  p99Ms: number;
  /** 5xx + network + timeout share. */
  maxServerErrorRate: number;
  /** achieved requests ÷ requests the load shape should have produced. */
  minThroughputRatio: number;
  maxRateLimitedShare: number;
  /** Unexpected 4xx on VALID requests (limits, validation, permissions). */
  maxClientErrorShare: number;
  requiredCapacityRps: number | null;
}

export type SloStatus = 'PASS' | 'WARN' | 'FAIL' | 'INFO';
export type RunVerdict = 'PASS' | 'PASS_WITH_WARNINGS' | 'FAIL' | 'INCONCLUSIVE';

export interface SloCheck {
  id: string;
  name: string;
  target: string;
  actual: string;
  status: SloStatus;
  /** One sentence a non-engineer can act on. */
  why: string;
}

/** Structural view of a run's aggregated numbers (matches RunSummary; kept local so the domain stays pure). */
export interface RunNumbers {
  totalRequests: number;
  errorClasses: {
    server5xx: number;
    rateLimited429: number;
    client4xx: number;
    networkOrTimeout: number;
    unexpectedOther: number;
  };
  statusCounts: Record<string, number>;
  latencyMs: { p95: number; p99: number };
  achievedAvgRps: number;
  peakRps: number;
  maxSustainedRps: number;
  droppedIterations: number;
  generatorSaturated: boolean;
}

export interface SloEvaluation {
  checks: SloCheck[];
  verdict: RunVerdict;
  /** Why the verdict is what it is, in one or two sentences. */
  reason: string;
  expectedRequests: number;
}

export function defaultSlo(cfg: Pick<PlanConfig, 'method' | 'moneyMoving' | 'fanout'>): SloTargets {
  const batch = cfg.fanout > 1;
  const write = cfg.method !== 'GET' || cfg.moneyMoving;
  return {
    p95Ms: batch ? 4000 : write ? 2000 : 800,
    p99Ms: batch ? 8000 : write ? 4000 : 1500,
    maxServerErrorRate: 0.01,
    minThroughputRatio: 0.9,
    maxRateLimitedShare: 0.05,
    maxClientErrorShare: 0.01,
    requiredCapacityRps: null,
  };
}

export const resolveSlo = (cfg: PlanConfig): SloTargets =>
  ({ ...defaultSlo(cfg), ...cfg.slo }) as SloTargets;

/** Requests the load shape should have produced: the area under the stage ramp. */
export function expectedRequests(cfg: PlanConfig): number {
  let prev = 0;
  let total = 0;
  for (const s of buildStages(cfg)) {
    total += (s.durationSeconds * (prev + s.target)) / 2;
    prev = s.target;
  }
  return Math.round(total);
}

export const pct = (n: number): string =>
  `${(n * 100).toFixed(n > 0 && n < 0.001 ? 3 : 2).replace(/\.?0+$/, '')}%`;

export function plainDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)} seconds` : `${Math.round(s)} seconds`;
}

const grade = (value: number, limit: number, warnFactor: number): SloStatus =>
  value <= limit ? 'PASS' : value <= limit * warnFactor ? 'WARN' : 'FAIL';

export interface EvaluateInput {
  config: PlanConfig;
  numbers: RunNumbers | null;
  runStatus: 'COMPLETED' | 'ABORTED' | 'FAILED' | 'QUEUED' | 'PREFLIGHT' | 'RUNNING';
  finishedReason: string | null;
}

export function evaluateRunSlo(input: EvaluateInput): SloEvaluation {
  const { config, numbers, runStatus, finishedReason } = input;
  const slo = resolveSlo(config);
  const expected = expectedRequests(config);
  const limitProfile = config.profile === 'STRESS' || config.profile === 'BREAKPOINT';

  // Runs that cannot prove anything.
  if (runStatus === 'FAILED' || !numbers) {
    return {
      checks: [],
      expectedRequests: expected,
      verdict: 'INCONCLUSIVE',
      reason: 'The test itself failed to run, so nothing can be said about the service.',
    };
  }
  if (runStatus !== 'COMPLETED') {
    const reason = finishedReason ?? 'The run did not finish.';
    const guardrailFail =
      /^guardrail: (server failure rate|\d+(\.\d+)?% of \d+ requests were rate limited)/.test(
        reason,
      );
    if (guardrailFail) {
      return {
        checks: [],
        expectedRequests: expected,
        verdict: 'FAIL',
        reason: `The service began failing under load and the safety guardrail stopped the test (${reason.replace('guardrail: ', '')}).`,
      };
    }
    return {
      checks: [],
      expectedRequests: expected,
      verdict: 'INCONCLUSIVE',
      reason: `The run was stopped before completion (${reason}), so it is not a valid measurement.`,
    };
  }

  const total = Math.max(1, numbers.totalRequests);
  const serverErr =
    (numbers.errorClasses.server5xx + numbers.errorClasses.networkOrTimeout) / total;
  const clientErr = (numbers.errorClasses.client4xx + numbers.errorClasses.unexpectedOther) / total;
  const limited = numbers.errorClasses.rateLimited429 / total;
  const ratio = expected > 0 ? numbers.totalRequests / expected : 1;
  const auth401 = (numbers.statusCounts['401'] ?? 0) / total;
  const graded = (s: SloStatus): SloStatus => (limitProfile && s !== 'PASS' ? 'INFO' : s);

  const checks: SloCheck[] = [];
  const add = (c: SloCheck): void => void checks.push(c);

  add({
    id: 'generator',
    name: 'Test tool kept up',
    target: 'no dropped iterations',
    actual:
      numbers.droppedIterations === 0 ? 'none dropped' : `${numbers.droppedIterations} dropped`,
    status: numbers.generatorSaturated ? 'FAIL' : 'PASS',
    why: numbers.generatorSaturated
      ? 'The machine generating the load could not keep up, so the result says more about the test machine than the service. Re-run with more capacity.'
      : 'The load generator delivered every request on schedule, so the numbers can be trusted.',
  });
  add({
    id: 'p95',
    name: 'Typical-worst response time (P95)',
    target: `≤ ${plainDuration(slo.p95Ms)}`,
    actual: plainDuration(numbers.latencyMs.p95),
    status: graded(grade(numbers.latencyMs.p95, slo.p95Ms, 1.25)),
    why: `95 out of 100 customers were served within ${plainDuration(numbers.latencyMs.p95)}${numbers.latencyMs.p95 <= slo.p95Ms ? ', inside the target.' : `, slower than the ${plainDuration(slo.p95Ms)} target.`}`,
  });
  add({
    id: 'p99',
    name: 'Worst-case response time (P99)',
    target: `≤ ${plainDuration(slo.p99Ms)}`,
    actual: plainDuration(numbers.latencyMs.p99),
    status: graded(grade(numbers.latencyMs.p99, slo.p99Ms, 1.25)),
    why: `The slowest 1 in 100 requests took ${plainDuration(numbers.latencyMs.p99)}${numbers.latencyMs.p99 <= slo.p99Ms ? ', within the target.' : `, beyond the ${plainDuration(slo.p99Ms)} target.`}`,
  });
  add({
    id: 'server-errors',
    name: 'Service failures (5xx, timeouts)',
    target: `≤ ${pct(slo.maxServerErrorRate)}`,
    actual: pct(serverErr),
    status: graded(grade(serverErr, slo.maxServerErrorRate, 2)),
    why:
      serverErr === 0
        ? 'The service did not fail a single request.'
        : `${pct(serverErr)} of requests failed on the service side — customers would have seen an error.`,
  });
  add({
    id: 'client-errors',
    name: 'Valid requests refused (unexpected 4xx)',
    target: `≤ ${pct(slo.maxClientErrorShare)}`,
    actual: pct(clientErr),
    status: graded(grade(clientErr, slo.maxClientErrorShare, 3)),
    why:
      clientErr === 0
        ? 'Every valid request was accepted.'
        : `${pct(clientErr)} of valid requests were refused (limits, validation or permissions), which would block real customers.`,
  });
  add({
    id: 'rate-limited',
    name: 'Throttled requests (429)',
    target: `≤ ${pct(slo.maxRateLimitedShare)}`,
    actual: pct(limited),
    status: graded(limited <= slo.maxRateLimitedShare ? 'PASS' : limited <= 0.5 ? 'WARN' : 'FAIL'),
    why:
      limited === 0
        ? 'No request was throttled.'
        : `${pct(limited)} of requests were throttled; at this volume the service asks callers to slow down.`,
  });
  add({
    id: 'throughput',
    name: 'Delivered the planned load',
    target: `≥ ${pct(slo.minThroughputRatio)} of planned requests`,
    actual: `${pct(ratio)} (${numbers.totalRequests.toLocaleString('en-US')} of ${expected.toLocaleString('en-US')})`,
    status: graded(ratio >= slo.minThroughputRatio ? 'PASS' : ratio >= 0.75 ? 'WARN' : 'FAIL'),
    why:
      ratio >= slo.minThroughputRatio
        ? 'The test sent as much traffic as it was designed to.'
        : 'Fewer requests completed than planned, so the service (or the test) could not sustain the intended volume.',
  });
  add({
    id: 'auth',
    name: 'Authentication held for the whole run',
    target: '≈ 0 token rejections',
    actual: pct(auth401),
    status: auth401 <= 0.001 ? 'PASS' : auth401 <= 0.01 ? 'WARN' : 'FAIL',
    why:
      auth401 <= 0.001
        ? 'Tokens were refreshed in time; no request was rejected for an expired credential.'
        : 'Some requests were rejected because their token expired mid-run; a real client would need to refresh earlier.',
  });

  // Capacity: the point of BREAKPOINT / STRESS.
  const required = slo.requiredCapacityRps;
  if (limitProfile || required != null) {
    const sustained = numbers.maxSustainedRps;
    add({
      id: 'capacity',
      name: 'Sustained capacity',
      target: required != null ? `≥ ${required} requests/s` : 'discover the limit',
      actual: `${sustained} requests/s sustained (peak ${numbers.peakRps})`,
      status:
        required != null
          ? sustained >= required
            ? 'PASS'
            : sustained >= required * 0.8
              ? 'WARN'
              : 'FAIL'
          : 'INFO',
      why:
        required != null
          ? sustained >= required
            ? `The service held ${sustained} requests/s with under 1% errors, above the ${required} required.`
            : `The service only held ${sustained} requests/s cleanly, below the ${required} required.`
          : `The service held ${sustained} requests/s with under 1% errors before it degraded.`,
    });
  }

  const fails = checks.filter((c) => c.status === 'FAIL');
  const warns = checks.filter((c) => c.status === 'WARN');
  if (numbers.generatorSaturated) {
    return {
      checks,
      expectedRequests: expected,
      verdict: 'INCONCLUSIVE',
      reason:
        'The load generator could not keep up, so this run does not prove anything about the service.',
    };
  }
  if (fails.length > 0) {
    return {
      checks,
      expectedRequests: expected,
      verdict: 'FAIL',
      reason: `Missed ${fails.length} objective${fails.length > 1 ? 's' : ''}: ${fails.map((c) => c.name.toLowerCase()).join(', ')}.`,
    };
  }
  if (warns.length > 0) {
    return {
      checks,
      expectedRequests: expected,
      verdict: 'PASS_WITH_WARNINGS',
      reason: `Met the objectives with thin margins on: ${warns.map((c) => c.name.toLowerCase()).join(', ')}.`,
    };
  }
  return { checks, expectedRequests: expected, verdict: 'PASS', reason: 'Met every objective.' };
}
