import { describe, expect, it } from 'vitest';
import {
  assessControls,
  statusFromItems,
  type LoadRunEvidence,
  type ReviewRecord,
  type SuiteRunEvidence,
} from './assess.js';
import { CONTROLS, LIBRARY_VERSION } from './controls.js';

const now = new Date('2026-10-16T12:00:00Z');
const ago = (days: number): string => new Date(now.getTime() - days * 86_400_000).toISOString();

const allChecks = (status: 'PASS' | 'FAIL' | 'SKIPPED' = 'PASS') =>
  [
    ...new Set(
      CONTROLS.flatMap((c) => c.evidence.flatMap((r) => (r.kind === 'checks' ? r.checkIds : []))),
    ),
  ].map((id) => ({ id, status, assertions: 5, failed: status === 'FAIL' ? 1 : 0 }));

const suite = (over: Partial<SuiteRunEvidence> = {}): SuiteRunEvidence => ({
  runId: 's1',
  suite: 'security',
  finishedAt: ago(1),
  environmentClass: 'SANDBOX',
  checks: allChecks(),
  ...over,
});
const load = (
  profile: LoadRunEvidence['profile'],
  verdict: LoadRunEvidence['verdict'] = 'PASS',
  over: Partial<LoadRunEvidence> = {},
): LoadRunEvidence => ({
  runId: `l-${profile}`,
  profile,
  verdict,
  finishedAt: ago(1),
  environmentClass: 'SANDBOX',
  ...over,
});
const run = (over: Partial<Parameters<typeof assessControls>[0]> = {}) =>
  assessControls({ now, suites: [], load: [], reviews: [], ...over });
const get = (a: ReturnType<typeof run>, id: string) => a.controls.find((c) => c.control.id === id)!;

describe('assessControls', () => {
  it('reports NOT_TESTED everywhere when there is no evidence, and OUT_OF_SCOPE for process controls', () => {
    const a = run();
    expect(a.basis).toBe('none');
    expect(get(a, 'OWASP-API1').status).toBe('NOT_TESTED');
    expect(get(a, 'PCI-11.4').status).toBe('OUT_OF_SCOPE');
    expect(get(a, 'PCI-11.4').items).toEqual([]);
    expect(a.frameworks.every((f) => f.byStatus.EVIDENCED === 0)).toBe(true);
  });

  it('marks a control EVIDENCED only from fresh real-environment passes', () => {
    const a = run({ suites: [suite()], load: [load('LOAD'), load('SOAK')] });
    expect(a.basis).toBe('real');
    expect(get(a, 'OWASP-API5').status).toBe('EVIDENCED');
    expect(get(a, 'OWASP-API1').statement).toContain('Fresh evidence');
    expect(get(a, 'OWASP-API1').items[0]).toMatchObject({
      outcome: 'PASS',
      runId: 's1',
      environment: 'SANDBOX',
    });
  });

  it('never calls simulator evidence "evidenced"', () => {
    const a = run({ suites: [suite({ environmentClass: 'MOCK' })] });
    expect(a.basis).toBe('simulator');
    expect(get(a, 'OWASP-API5').status).toBe('SIMULATOR_ONLY');
    expect(get(a, 'OWASP-API5').statement).toContain('not evidence about the real service');
  });

  it('flags stale real evidence rather than counting it as fresh', () => {
    const a = run({ suites: [suite({ finishedAt: ago(200) })], maxAgeDays: 90 });
    expect(get(a, 'OWASP-API5').status).toBe('EVIDENCED_STALE');
    expect(get(a, 'OWASP-API5').items[0]!.detail).toContain('older than the freshness window');
  });

  it('any failing mapped check makes the control FAILING — even if others pass', () => {
    const checks = allChecks().map((c) =>
      c.id === 'bola.cross-account-access' ? { ...c, status: 'FAIL' as const, failed: 2 } : c,
    );
    const a = run({ suites: [suite({ checks })] });
    expect(get(a, 'OWASP-API1').status).toBe('FAILING');
    expect(get(a, 'PCI-7.2').status).toBe('FAILING'); // shares that check
    expect(get(a, 'OWASP-API7').status).toBe('EVIDENCED'); // unrelated control unaffected
    expect(get(a, 'OWASP-API1').statement).toContain('FAILED');
  });

  it('treats a skipped check as a gap: PARTIAL when only some evidence exists, NOT_TESTED when none', () => {
    const checks = allChecks().map((c) =>
      c.id === 'authz.permission-enforced' ? { ...c, status: 'SKIPPED' as const } : c,
    );
    const a = run({ suites: [suite({ checks })] });
    expect(get(a, 'OWASP-API5').status).toBe('NOT_TESTED'); // its only check was skipped
    expect(get(a, 'PCI-7.2').status).toBe('PARTIAL'); // one passed, one skipped
  });

  it('prefers the latest REAL run over a newer simulator run, and a real failure over an old pass', () => {
    const real = suite({ runId: 'real', finishedAt: ago(5) });
    const sim = suite({ runId: 'sim', environmentClass: 'MOCK', finishedAt: ago(1) });
    expect(get(run({ suites: [real, sim] }), 'OWASP-API5').items[0]!.runId).toBe('real');
    const failedReal = suite({
      runId: 'real2',
      finishedAt: ago(1),
      checks: allChecks().map((c) => ({ ...c, status: 'FAIL' as const, failed: 1 })),
    });
    expect(get(run({ suites: [real, failedReal] }), 'OWASP-API5').status).toBe('FAILING');
  });

  it('a real pass plus simulator-only checks is PARTIAL, never EVIDENCED', () => {
    // BOG-DUPLICATE includes a simulator-only check; give the real run everything except that one.
    const checks = allChecks().filter((c) => c.id !== 'sim.ambiguous-timeout-retry');
    const a = run({
      suites: [
        suite({ checks }),
        suite({ runId: 'sim', environmentClass: 'MOCK', checks: allChecks() }),
      ],
    });
    const dup = get(a, 'BOG-DUPLICATE');
    expect(dup.status).toBe('PARTIAL');
    expect(dup.items.find((i) => i.subject === 'sim.ambiguous-timeout-retry')!.outcome).toBe(
      'SIM_ONLY',
    );
  });

  it('load evidence: pass/warn count, fail fails, inconclusive is ignored', () => {
    const ok = run({ load: [load('LOAD', 'PASS_WITH_WARNINGS'), load('SPIKE')] });
    expect(get(ok, 'BOG-RESILIENCE').status).toBe('EVIDENCED');
    const bad = run({ load: [load('LOAD', 'FAIL'), load('SPIKE')] });
    expect(get(bad, 'BOG-RESILIENCE').status).toBe('FAILING');
    const inconclusive = run({ load: [load('LOAD', 'INCONCLUSIVE'), load('SPIKE')] });
    expect(get(inconclusive, 'BOG-RESILIENCE').status).toBe('PARTIAL'); // SPIKE ok, LOAD has no valid run
    const capacity = run({ load: [load('BREAKPOINT')] });
    expect(get(capacity, 'BOG-CAPACITY').status).toBe('EVIDENCED');
  });

  it('keeps partial-scope controls honest: evidenced, but still flagged partial with their limitation', () => {
    const a = run({ suites: [suite()] });
    const c = get(a, 'PCI-3.3');
    expect(c.status).toBe('EVIDENCED');
    expect(c.coverage).toBe('partial');
    expect(c.statement).toContain('scope is partial');
    expect(c.control.limitation).toContain('cannot prove');
  });

  it('overlays review state, and a new library version makes old reviews stale', () => {
    const review = (
      version: string,
      decision: ReviewRecord['decision'] = 'APPROVED',
      createdAt = ago(2),
    ): ReviewRecord => ({
      controlId: 'OWASP-API1',
      libraryVersion: version,
      decision,
      note: 'Mapping confirmed against the standard.',
      reviewerLabel: 'user:compliance@x.test',
      createdAt,
    });
    expect(get(run(), 'OWASP-API1').review.status).toBe('DRAFT');
    expect(get(run({ reviews: [review(LIBRARY_VERSION)] }), 'OWASP-API1').review).toMatchObject({
      status: 'APPROVED',
      reviewer: 'user:compliance@x.test',
    });
    expect(get(run({ reviews: [review('2025.01-old')] }), 'OWASP-API1').review.status).toBe(
      'STALE_REVIEW',
    );
    // The newest decision wins.
    const latest = run({
      reviews: [
        review(LIBRARY_VERSION, 'APPROVED', ago(5)),
        review(LIBRARY_VERSION, 'NEEDS_CHANGE', ago(1)),
      ],
    });
    expect(get(latest, 'OWASP-API1').review.status).toBe('NEEDS_CHANGE');
    expect(latest.frameworks.find((f) => f.framework === 'OWASP_API_2023')!.reviewedApproved).toBe(
      0,
    );
  });

  it('summarises each framework, including unverified references', () => {
    const a = run({
      suites: [suite()],
      load: [load('LOAD'), load('SOAK'), load('SPIKE'), load('BREAKPOINT')],
    });
    const owasp = a.frameworks.find((f) => f.framework === 'OWASP_API_2023')!;
    expect(owasp.total).toBe(10);
    expect(owasp.byStatus.EVIDENCED).toBeGreaterThanOrEqual(8);
    expect(owasp.unverifiedReferences).toBe(0);
    const bog = a.frameworks.find((f) => f.framework === 'BOG')!;
    expect(bog.unverifiedReferences).toBe(bog.total); // every BoG reference still needs the compliance owner
    expect(a.frameworks.reduce((n, f) => n + f.total, 0)).toBe(CONTROLS.length);
  });

  it('statusFromItems precedence is FAIL > evidenced > stale > partial > simulator > not tested', () => {
    const i = (outcome: 'PASS' | 'STALE' | 'SIM_ONLY' | 'MISSING' | 'FAIL') => ({
      label: '',
      kind: 'check' as const,
      subject: '',
      outcome,
      detail: '',
    });
    expect(statusFromItems([])).toBe('NOT_TESTED');
    expect(statusFromItems([i('PASS'), i('FAIL')])).toBe('FAILING');
    expect(statusFromItems([i('PASS'), i('PASS')])).toBe('EVIDENCED');
    expect(statusFromItems([i('PASS'), i('STALE')])).toBe('EVIDENCED_STALE');
    expect(statusFromItems([i('PASS'), i('MISSING')])).toBe('PARTIAL');
    expect(statusFromItems([i('SIM_ONLY'), i('MISSING')])).toBe('SIMULATOR_ONLY');
    expect(statusFromItems([i('MISSING')])).toBe('NOT_TESTED');
  });
});
