import { describe, expect, it } from 'vitest';
import { assessReadiness, type LoadEvidence, type SuiteEvidence } from './load-readiness.js';

const now = new Date('2026-10-16T12:00:00Z');
const day = (n: number): string => new Date(now.getTime() - n * 86_400_000).toISOString();
const load = (
  profile: LoadEvidence['profile'],
  verdict: LoadEvidence['verdict'],
  over: Partial<LoadEvidence> = {},
): LoadEvidence => ({
  id: `${profile}-${verdict}`,
  profile,
  verdict,
  finishedAt: day(1),
  environmentClass: 'SANDBOX',
  sloScore: verdict === 'PASS' ? 1 : verdict === 'PASS_WITH_WARNINGS' ? 0.6 : 0,
  ...over,
});
const suite = (over: Partial<SuiteEvidence> = {}): SuiteEvidence => ({
  id: 's',
  verdict: 'PASS',
  warnings: 0,
  skipped: 0,
  finishedAt: day(1),
  environmentClass: 'SANDBOX',
  assertionPassRatio: 1,
  ...over,
});
const gate = (r: ReturnType<typeof assessReadiness>, id: string) =>
  r.gates.find((g) => g.id === id)!;

describe('assessReadiness', () => {
  it('is READY only with every gate evidenced from the real service', () => {
    const r = assessReadiness({
      now,
      load: [load('LOAD', 'PASS'), load('SPIKE', 'PASS'), load('BREAKPOINT', 'PASS')],
      correctness: suite(),
      security: suite(),
    });
    expect(r.status).toBe('READY');
    expect(r.score).toBe(100);
    expect(r.basis).toBe('sandbox');
    expect(r.nextSteps).toEqual([]);
  });

  it('is NOT_READY when correctness has a defect, no matter how fast the service is', () => {
    const r = assessReadiness({
      now,
      load: [load('LOAD', 'PASS'), load('SPIKE', 'PASS'), load('BREAKPOINT', 'PASS')],
      correctness: suite({ verdict: 'FAIL', assertionPassRatio: 0.8 }),
      security: suite(),
    });
    expect(r.status).toBe('NOT_READY');
    expect(r.reasons[0]).toContain('found defects');
    expect(r.nextSteps[0]).toContain('money-safety');
    expect(r.score).toBeLessThan(100);
  });

  it('is INCOMPLETE — never silently passed — when a required gate has no evidence', () => {
    const r = assessReadiness({
      now,
      load: [load('LOAD', 'PASS')],
      correctness: suite(),
      security: null,
    });
    expect(r.status).toBe('INCOMPLETE');
    expect(gate(r, 'security').status).toBe('MISSING');
    expect(r.nextSteps.join(' ')).toContain('security suite');
  });

  it('can never be READY on simulator evidence alone', () => {
    const sim = { environmentClass: 'MOCK' as const };
    const r = assessReadiness({
      now,
      load: [
        load('LOAD', 'PASS', sim),
        load('SPIKE', 'PASS', sim),
        load('BREAKPOINT', 'PASS', sim),
      ],
      correctness: suite(sim),
      security: suite(sim),
    });
    expect(r.basis).toBe('simulator');
    expect(r.status).toBe('INCOMPLETE');
    expect(gate(r, 'real-environment').detail).toContain('simulator');
    expect(r.nextSteps.join(' ')).toContain('sandbox');
  });

  it('treats an inconclusive load run as no evidence, and uses the LATEST run per profile', () => {
    const r = assessReadiness({
      now,
      load: [
        load('LOAD', 'PASS', { finishedAt: day(5) }),
        load('LOAD', 'INCONCLUSIVE', { id: 'newer', finishedAt: day(1) }),
      ],
      correctness: suite(),
      security: suite(),
    });
    expect(gate(r, 'steady-load').status).toBe('MISSING');
    expect(gate(r, 'steady-load').evidenceId).toBe('newer');
    expect(r.status).toBe('INCOMPLETE');
  });

  it('warns on thin margins, skipped checks and stale evidence', () => {
    const r = assessReadiness({
      now,
      load: [
        load('LOAD', 'PASS_WITH_WARNINGS'),
        load('SPIKE', 'PASS'),
        load('BREAKPOINT', 'PASS', { finishedAt: day(60) }),
      ],
      correctness: suite({ skipped: 5 }),
      security: suite({ warnings: 3 }),
    });
    expect(r.status).toBe('READY_WITH_WARNINGS');
    expect(gate(r, 'freshness').status).toBe('WARN');
    expect(gate(r, 'correctness').detail).toContain('5 check(s) that could not run');
  });

  it('a failing advisory gate (spike) still blocks readiness; a never-run one only warns', () => {
    expect(
      assessReadiness({
        now,
        load: [load('LOAD', 'PASS'), load('SPIKE', 'FAIL')],
        correctness: suite(),
        security: suite(),
      }).status,
    ).toBe('NOT_READY');
    const never = assessReadiness({
      now,
      load: [load('LOAD', 'PASS')],
      correctness: suite(),
      security: suite(),
    });
    expect(never.status).toBe('READY_WITH_WARNINGS');
    expect(gate(never, 'spike').status).toBe('WARN');
  });

  it('reports no evidence plainly', () => {
    const r = assessReadiness({ now, load: [], correctness: null, security: null });
    expect(r).toMatchObject({ status: 'INCOMPLETE', score: null, basis: 'none' });
  });
});
