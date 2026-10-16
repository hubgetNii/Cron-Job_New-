import { describe, expect, it } from 'vitest';
import { PlanConfigSchema, type PlanConfig } from './load-plan.js';
import {
  defaultSlo,
  evaluateRunSlo,
  expectedRequests,
  pct,
  plainDuration,
  resolveSlo,
  type RunNumbers,
} from './load-slo.js';

const plan = (over: Record<string, unknown> = {}): PlanConfig =>
  PlanConfigSchema.parse({
    profile: 'LOAD',
    method: 'POST',
    moneyMoving: true,
    targetRps: 10,
    durationSeconds: 100,
    maxVus: 50,
    ...over,
  });

const nums = (over: Partial<RunNumbers> = {}): RunNumbers => ({
  totalRequests: 900,
  errorClasses: {
    server5xx: 0,
    rateLimited429: 0,
    client4xx: 0,
    networkOrTimeout: 0,
    unexpectedOther: 0,
  },
  statusCounts: { '202': 900 },
  latencyMs: { p95: 600, p99: 900 },
  achievedAvgRps: 9,
  peakRps: 10,
  maxSustainedRps: 10,
  droppedIterations: 0,
  generatorSaturated: false,
  ...over,
});

const run = (
  cfg: PlanConfig,
  n: RunNumbers | null,
  status: 'COMPLETED' | 'ABORTED' | 'FAILED' = 'COMPLETED',
  reason: string | null = 'completed',
) => evaluateRunSlo({ config: cfg, numbers: n, runStatus: status, finishedReason: reason });
const by = (e: ReturnType<typeof run>, id: string) => e.checks.find((c) => c.id === id)!;

describe('defaults and helpers', () => {
  it('derives stricter targets for reads than writes than batches', () => {
    const read = defaultSlo({ method: 'GET', moneyMoving: false, fanout: 1 });
    const write = defaultSlo({ method: 'POST', moneyMoving: true, fanout: 1 });
    const batch = defaultSlo({ method: 'POST', moneyMoving: true, fanout: 20 });
    expect([read.p95Ms, write.p95Ms, batch.p95Ms]).toEqual([800, 2000, 4000]);
  });

  it('lets a plan override individual objectives', () => {
    const cfg = plan({ slo: { p95Ms: 500, requiredCapacityRps: 40 } });
    expect(resolveSlo(cfg)).toMatchObject({ p95Ms: 500, p99Ms: 4000, requiredCapacityRps: 40 });
  });

  it('computes the area under the ramp', () => {
    // LOAD 100 s @10 rps: 10 s ramp (50) + 80 s hold (800) + 10 s down (50)
    expect(expectedRequests(plan())).toBe(900);
  });

  it('writes numbers for humans', () => {
    expect(plainDuration(420)).toBe('420 ms');
    expect(plainDuration(1500)).toBe('1.5 seconds');
    expect(plainDuration(25_000)).toBe('25 seconds');
    expect([pct(0), pct(0.0123), pct(0.5), pct(0.0004)]).toEqual(['0%', '1.23%', '50%', '0.04%']);
  });
});

describe('evaluateRunSlo', () => {
  it('passes a healthy run and says why in plain words', () => {
    const e = run(plan(), nums());
    expect(e.verdict).toBe('PASS');
    expect(e.checks.every((c) => c.status === 'PASS')).toBe(true);
    expect(by(e, 'server-errors').why).toContain('did not fail a single request');
  });

  it('warns on thin margins and fails on a miss', () => {
    expect(run(plan(), nums({ latencyMs: { p95: 2200, p99: 3000 } })).verdict).toBe(
      'PASS_WITH_WARNINGS',
    );
    const bad = run(plan(), nums({ latencyMs: { p95: 5000, p99: 9000 } }));
    expect(bad.verdict).toBe('FAIL');
    expect(bad.reason).toContain('typical-worst response time');
  });

  it('fails when the service itself fails requests', () => {
    const e = run(
      plan(),
      nums({
        errorClasses: {
          server5xx: 40,
          rateLimited429: 0,
          client4xx: 0,
          networkOrTimeout: 10,
          unexpectedOther: 0,
        },
      }),
    );
    expect(by(e, 'server-errors').status).toBe('FAIL');
    expect(e.verdict).toBe('FAIL');
  });

  it('treats refused valid requests as a defect, and token rejections as a client problem', () => {
    expect(
      by(
        run(
          plan(),
          nums({
            errorClasses: {
              server5xx: 0,
              rateLimited429: 0,
              client4xx: 90,
              networkOrTimeout: 0,
              unexpectedOther: 0,
            },
          }),
        ),
        'client-errors',
      ).status,
    ).toBe('FAIL');
    expect(by(run(plan(), nums({ statusCounts: { '202': 880, '401': 20 } })), 'auth').status).toBe(
      'FAIL',
    );
  });

  it('flags a shortfall against the planned load', () => {
    const e = run(plan(), nums({ totalRequests: 500 }));
    expect(by(e, 'throughput').status).toBe('FAIL');
  });

  it('declares a saturated generator INCONCLUSIVE, never a pass or a fail of the service', () => {
    const e = run(plan(), nums({ generatorSaturated: true, droppedIterations: 30 }));
    expect(e.verdict).toBe('INCONCLUSIVE');
    expect(by(e, 'generator').status).toBe('FAIL');
  });

  it('interprets aborted and failed runs correctly', () => {
    expect(run(plan(), nums(), 'FAILED', 'runner error').verdict).toBe('INCONCLUSIVE');
    expect(run(plan(), nums(), 'ABORTED', 'abort requested: operator pressed stop').verdict).toBe(
      'INCONCLUSIVE',
    );
    expect(run(plan(), nums(), 'ABORTED', 'kill switch engaged: drill').verdict).toBe(
      'INCONCLUSIVE',
    );
    // The service started failing: that IS a result.
    const g = run(
      plan(),
      nums(),
      'ABORTED',
      'guardrail: server failure rate 61.0% over 120 requests in 30s exceeded 25%',
    );
    expect(g.verdict).toBe('FAIL');
    expect(g.reason).toContain('began failing under load');
    // Credentials / limits refusing everything invalidates the run rather than blaming the service.
    expect(
      run(
        plan(),
        nums(),
        'ABORTED',
        'guardrail: 80.0% of 100 requests were refused with 401/403 (bad key)',
      ).verdict,
    ).toBe('INCONCLUSIVE');
  });

  it('grades capacity for BREAKPOINT/STRESS: informational unless a requirement is set', () => {
    const bp = plan({ profile: 'BREAKPOINT', durationSeconds: 60 });
    const n = nums({ maxSustainedRps: 35, peakRps: 52, latencyMs: { p95: 9000, p99: 20000 } });
    const info = run(bp, n, 'COMPLETED', 'limit reached: server failure rate 40%');
    expect(by(info, 'capacity').status).toBe('INFO');
    expect(info.checks.filter((c) => c.status === 'FAIL').length).toBe(0); // latency past the limit is expected
    expect(info.verdict).not.toBe('FAIL');

    const needs = run(
      plan({ profile: 'BREAKPOINT', durationSeconds: 60, slo: { requiredCapacityRps: 50 } }),
      n,
      'COMPLETED',
      'limit reached',
    );
    expect(by(needs, 'capacity').status).toBe('FAIL');
    expect(needs.verdict).toBe('FAIL');
    expect(by(needs, 'capacity').why).toContain('below the 50 required');
  });
});
