import type { PlanConfig } from '../../../domain/load-plan.js';
import { buildStages } from '../../../domain/load-plan.js';
import type { LoadEnvironmentClass } from '../../../domain/enums.js';
import type { RunVerdict, SloEvaluation } from '../../../domain/load-slo.js';
import { pct, plainDuration } from '../../../domain/load-slo.js';
import type { Decision, KeyNumber } from './report.types.js';

/**
 * Plain-language generation for reports. Everything here is deterministic
 * templating over numbers we measured — no model, no guesswork — so the same run
 * always reads the same, and every sentence can be traced to a figure.
 */

const num = (n: number): string => n.toLocaleString('en-US');

export function environmentLabel(cls: LoadEnvironmentClass | null): {
  label: string;
  isReal: boolean;
} {
  switch (cls) {
    case 'MOCK':
      return { label: 'Simulator (not the real service)', isReal: false };
    case 'SANDBOX':
      return { label: 'iSmartPay sandbox', isReal: true };
    case 'STAGING':
      return { label: 'Staging environment', isReal: true };
    case 'PRODUCTION':
      return { label: 'Production (read-only)', isReal: true };
    default:
      return { label: 'Unclassified environment', isReal: false };
  }
}

/** "Sent POST /v1/payouts requests that move money (a payout), to <target>." */
export function describeScenario(
  cfg: PlanConfig,
  packTitle: string | null,
  targetName: string,
): string {
  const what = packTitle ?? `${cfg.method} ${cfg.path ?? 'the target URL'}`;
  const parts = [
    `Sent ${cfg.method} ${cfg.path ?? 'requests'} to ${targetName} — scenario “${what}”.`,
  ];
  if (cfg.moneyMoving) parts.push('Each request moves (test) money.');
  if (cfg.fanout > 1)
    parts.push(
      `Each request carries ${cfg.fanout} payments, so the effective rate is ${cfg.fanout}× the request rate.`,
    );
  if (cfg.realSideEffects)
    parts.push('This scenario has real-world side effects even in test (real airtime/data).');
  if (cfg.method !== 'GET')
    parts.push('Every request carried a unique Idempotency-Key and reference.');
  return parts.join(' ');
}

export function describeShape(cfg: PlanConfig): string {
  const stages = buildStages(cfg);
  let prev = 0;
  const bits = stages.map((s) => {
    const dur = `${s.durationSeconds}s`;
    const text =
      s.target === prev
        ? `held ${s.target}/s for ${dur}`
        : prev === 0 && s.target > 0
          ? `ramped up to ${s.target}/s over ${dur}`
          : s.target === 0
            ? `ramped down over ${dur}`
            : `moved from ${prev} to ${s.target}/s over ${dur}`;
    prev = s.target;
    return text;
  });
  const kind: Record<string, string> = {
    SMOKE: 'A quick sanity check at a trickle of traffic',
    LOAD: 'A steady load at the expected busy-time rate',
    STRESS: 'A staircase that pushes beyond normal volume to find the limit',
    SPIKE: 'A sudden surge on top of normal traffic',
    SOAK: 'A long steady load to expose slow leaks and drift',
    BREAKPOINT: 'A continuous ramp until the service starts to fail',
  };
  return `${kind[cfg.profile]}: ${bits.join(', ')}.`;
}

export function decisionFor(verdict: RunVerdict): Decision {
  return verdict === 'PASS'
    ? 'GO'
    : verdict === 'PASS_WITH_WARNINGS'
      ? 'GO_WITH_CONDITIONS'
      : verdict === 'FAIL'
        ? 'NO_GO'
        : 'RE_RUN';
}

export const DECISION_TEXT: Record<Decision, string> = {
  GO: 'Go — the service met every objective at this volume.',
  GO_WITH_CONDITIONS:
    'Go with conditions — it met the objectives, but with thin margins to address.',
  NO_GO: 'No-go — the service missed an objective at this volume.',
  RE_RUN: 'Re-run — this run does not prove anything either way.',
};

export function loadHeadline(args: {
  verdict: RunVerdict;
  cfg: PlanConfig;
  evaluation: SloEvaluation;
  totalRequests: number;
  p95Ms: number;
  serverErrorRate: number;
  maxSustainedRps: number;
  targetName: string;
  env: string;
}): string {
  const {
    verdict,
    cfg,
    evaluation,
    totalRequests,
    p95Ms,
    serverErrorRate,
    maxSustainedRps,
    targetName,
    env,
  } = args;
  if (verdict === 'INCONCLUSIVE')
    return `This ${cfg.profile.toLowerCase()} test on ${env} is inconclusive: ${evaluation.reason}`;
  const volume = `${num(totalRequests)} requests`;
  const base = `${targetName} handled ${volume} in a ${cfg.profile.toLowerCase()} test on ${env}`;
  if (cfg.profile === 'BREAKPOINT' || cfg.profile === 'STRESS') {
    return `${base}; it held ${maxSustainedRps} requests/s cleanly before it began to degrade.`;
  }
  if (verdict === 'PASS')
    return `${base} with ${serverErrorRate === 0 ? 'no failures' : `${pct(serverErrorRate)} failures`}; 95% of requests finished within ${plainDuration(p95Ms)}.`;
  if (verdict === 'PASS_WITH_WARNINGS')
    return `${base} and met its objectives, but ${evaluation.reason.charAt(0).toLowerCase()}${evaluation.reason.slice(1)}`;
  return `${base} but did not meet its objectives. ${evaluation.reason}`;
}

export function keyNumbers(a: {
  totalRequests: number;
  serverErrorRate: number;
  p95Ms: number;
  p99Ms: number;
  achievedAvgRps: number;
  peakRps: number;
  fanout: number;
}): KeyNumber[] {
  const ok = Math.round((1 - a.serverErrorRate) * 10_000) / 100;
  return [
    {
      label: 'Requests sent',
      value: num(a.totalRequests),
      caption: 'Total requests during the test.',
    },
    {
      label: 'Success rate',
      value: `${ok}%`,
      caption: 'Share that did not fail on the service side (5xx, timeouts).',
    },
    {
      label: 'Typical-worst speed (P95)',
      value: plainDuration(a.p95Ms),
      caption: '95 out of 100 requests were at least this fast.',
    },
    {
      label: 'Worst-case speed (P99)',
      value: plainDuration(a.p99Ms),
      caption: 'Only 1 in 100 was slower than this.',
    },
    {
      label: 'Average throughput',
      value: `${a.achievedAvgRps}/s`,
      caption:
        a.fanout > 1
          ? `Requests per second (each carries ${a.fanout} payments).`
          : 'Requests handled per second, on average.',
    },
    { label: 'Peak throughput', value: `${a.peakRps}/s`, caption: 'The busiest single second.' },
  ];
}

export function errorsPlain(
  classes: {
    server5xx: number;
    rateLimited429: number;
    client4xx: number;
    networkOrTimeout: number;
    unexpectedOther: number;
  },
  total: number,
): string {
  const bad =
    classes.server5xx +
    classes.networkOrTimeout +
    classes.client4xx +
    classes.rateLimited429 +
    classes.unexpectedOther;
  if (bad === 0) return 'Every request succeeded.';
  const parts: string[] = [];
  if (classes.server5xx) parts.push(`${num(classes.server5xx)} service errors (5xx)`);
  if (classes.networkOrTimeout)
    parts.push(`${num(classes.networkOrTimeout)} timeouts or dropped connections`);
  if (classes.rateLimited429) parts.push(`${num(classes.rateLimited429)} throttled (429)`);
  if (classes.client4xx) parts.push(`${num(classes.client4xx)} valid requests refused (4xx)`);
  if (classes.unexpectedOther) parts.push(`${num(classes.unexpectedOther)} unexpected responses`);
  return `${pct(bad / Math.max(1, total))} of requests did not succeed: ${parts.join(', ')}.`;
}

export const GLOSSARY: Record<string, string> = {
  P95: 'The response time that 95 out of 100 requests beat. It describes a “bad but not worst” customer experience.',
  P99: 'The response time that 99 out of 100 requests beat. It shows the slow tail.',
  Throughput: 'How many requests the service completes each second.',
  '5xx':
    'An error on the service’s side — the customer’s request failed through no fault of their own.',
  '429': '“Too many requests” — the service is asking the caller to slow down.',
  Idempotency:
    'Sending the same payment request twice has the same effect as sending it once — essential so a retry never charges someone twice.',
  Reconciliation:
    'Checking that wallet balances, the ledger and settlements all agree to the cent.',
  Guardrail:
    'A safety rule that stops a test automatically if the service starts failing, so a test can never hurt the system.',
  Inconclusive:
    'The run does not prove anything either way — for example it was stopped early or the test machine itself was the limit.',
  'Break point': 'The request rate at which the service stops coping cleanly.',
  OWASP:
    'The Open Worldwide Application Security Project; its API Security Top 10 lists the most common ways APIs get attacked.',
};
