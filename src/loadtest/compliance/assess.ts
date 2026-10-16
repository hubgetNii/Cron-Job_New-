import type { LoadEnvironmentClass, LoadProfile } from '../../domain/enums.js';
import type { RunVerdict } from '../../domain/load-slo.js';
import {
  CONTROLS,
  FRAMEWORKS,
  LIBRARY_VERSION,
  type Control,
  type Framework,
  type Scope,
} from './controls.js';

/**
 * Turns test evidence into a per-control compliance picture (Phase 28).
 * Pure and deterministic. The rules that keep it honest:
 *
 *  - REAL-environment evidence counts; simulator evidence is reported as
 *    SIMULATOR_ONLY and never as "evidenced";
 *  - evidence older than `maxAgeDays` is STALE (shown, but not fresh);
 *  - ANY failing mapped check makes the control FAILING;
 *  - a missing or skipped check is a gap (PARTIAL / NOT_TESTED), never a pass;
 *  - a control whose scope is only `partial` can be EVIDENCED yet is still
 *    reported with `coverage: 'partial'` and its limitation;
 *  - out-of-scope controls say what other evidence they need.
 */

export type ControlStatus =
  | 'EVIDENCED'
  | 'EVIDENCED_STALE'
  | 'PARTIAL'
  | 'SIMULATOR_ONLY'
  | 'NOT_TESTED'
  | 'FAILING'
  | 'OUT_OF_SCOPE';

export type ItemOutcome = 'PASS' | 'STALE' | 'SIM_ONLY' | 'MISSING' | 'FAIL';

export interface SuiteCheckEvidence {
  id: string;
  status: 'PASS' | 'FAIL' | 'ERROR' | 'SKIPPED';
  assertions: number;
  failed: number;
}
export interface SuiteRunEvidence {
  runId: string;
  suite: 'correctness' | 'security';
  finishedAt: string;
  environmentClass: LoadEnvironmentClass | null;
  checks: SuiteCheckEvidence[];
}
export interface LoadRunEvidence {
  runId: string;
  profile: LoadProfile;
  verdict: RunVerdict;
  finishedAt: string;
  environmentClass: LoadEnvironmentClass | null;
}

export type ReviewDecision = 'APPROVED' | 'REJECTED' | 'NEEDS_CHANGE';
export interface ReviewRecord {
  controlId: string;
  libraryVersion: string;
  decision: ReviewDecision;
  note: string;
  reviewerLabel: string;
  createdAt: string;
}

export interface ReviewState {
  status: 'DRAFT' | ReviewDecision | 'STALE_REVIEW';
  reviewer?: string;
  at?: string;
  note?: string;
  libraryVersion?: string;
}

export interface EvidenceItem {
  label: string;
  kind: 'check' | 'load';
  /** The check id or load profile(s). */
  subject: string;
  outcome: ItemOutcome;
  runId?: string;
  /** Which kind of report `runId` opens (lets the UI link straight to it). */
  runKind?: 'correctness' | 'security' | 'load';
  finishedAt?: string;
  environment?: LoadEnvironmentClass | null;
  detail: string;
}

export interface ControlAssessment {
  control: Control;
  status: ControlStatus;
  coverage: Scope;
  items: EvidenceItem[];
  review: ReviewState;
  /** One plain sentence for the matrix. */
  statement: string;
}

export interface FrameworkSummary {
  framework: Framework;
  name: string;
  note: string;
  total: number;
  byStatus: Record<ControlStatus, number>;
  /** Controls with fresh real evidence ÷ controls tests can speak to at all. */
  evidencedShare: number;
  reviewedApproved: number;
  unverifiedReferences: number;
}

export interface Assessment {
  libraryVersion: string;
  asOf: string;
  maxAgeDays: number;
  basis: 'none' | 'simulator' | 'real' | 'mixed';
  controls: ControlAssessment[];
  frameworks: FrameworkSummary[];
}

const isReal = (c: LoadEnvironmentClass | null): boolean =>
  c === 'SANDBOX' || c === 'STAGING' || c === 'PRODUCTION';
const DAY = 86_400_000;

export interface AssessInput {
  now: Date;
  suites: SuiteRunEvidence[];
  load: LoadRunEvidence[];
  reviews: ReviewRecord[];
  maxAgeDays?: number;
  controls?: Control[];
  libraryVersion?: string;
}

function checkOutcome(
  checkId: string,
  suites: SuiteRunEvidence[],
  now: Date,
  maxAge: number,
): EvidenceItem {
  const base = { kind: 'check' as const, subject: checkId };
  const hits = suites
    .map((s) => ({ s, c: s.checks.find((x) => x.id === checkId && x.status !== 'SKIPPED') }))
    .filter((h): h is { s: SuiteRunEvidence; c: SuiteCheckEvidence } => h.c !== undefined)
    .sort((a, b) => b.s.finishedAt.localeCompare(a.s.finishedAt));
  const real = hits.find((h) => isReal(h.s.environmentClass));
  const sim = hits.find((h) => h.s.environmentClass === 'MOCK');
  const pick = real ?? sim;
  if (!pick)
    return {
      ...base,
      label: checkId,
      outcome: 'MISSING',
      detail: 'No run has executed this check (or it was skipped in every environment).',
    };

  const { s, c } = pick;
  const ev = {
    runId: s.runId,
    runKind: s.suite,
    finishedAt: s.finishedAt,
    environment: s.environmentClass,
  };
  const passed = c.status === 'PASS';
  if (!passed) {
    return {
      ...base,
      ...ev,
      label: checkId,
      outcome: 'FAIL',
      detail: `${c.failed} of ${c.assertions} assertions failed${real ? '' : ' (simulator run — investigate the tooling or the simulator)'}.`,
    };
  }
  if (!real)
    return {
      ...base,
      ...ev,
      label: checkId,
      outcome: 'SIM_ONLY',
      detail: 'Passed on the simulator only; not evidence about the real service.',
    };
  const stale = now.getTime() - new Date(s.finishedAt).getTime() > maxAge;
  return {
    ...base,
    ...ev,
    label: checkId,
    outcome: stale ? 'STALE' : 'PASS',
    detail: `${c.assertions} assertions passed${stale ? ' — evidence is older than the freshness window' : ''}.`,
  };
}

function loadOutcome(
  profiles: LoadProfile[],
  load: LoadRunEvidence[],
  now: Date,
  maxAge: number,
): EvidenceItem {
  const base = { kind: 'load' as const, subject: profiles.join('/') };
  const meaningful = load
    .filter((l) => profiles.includes(l.profile) && l.verdict !== 'INCONCLUSIVE')
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
  const real = meaningful.find((l) => isReal(l.environmentClass));
  const sim = meaningful.find((l) => l.environmentClass === 'MOCK');
  const pick = real ?? sim;
  if (!pick)
    return {
      ...base,
      label: base.subject,
      outcome: 'MISSING',
      detail: `No valid ${profiles.join('/')} run yet.`,
    };
  const ev = {
    runId: pick.runId,
    runKind: 'load' as const,
    finishedAt: pick.finishedAt,
    environment: pick.environmentClass,
  };
  if (pick.verdict === 'FAIL')
    return {
      ...base,
      ...ev,
      label: base.subject,
      outcome: 'FAIL',
      detail: `The latest ${pick.profile} run missed its objectives.`,
    };
  if (!real)
    return {
      ...base,
      ...ev,
      label: base.subject,
      outcome: 'SIM_ONLY',
      detail: 'Passed on the simulator only.',
    };
  const stale = now.getTime() - new Date(pick.finishedAt).getTime() > maxAge;
  return {
    ...base,
    ...ev,
    label: base.subject,
    outcome: stale ? 'STALE' : 'PASS',
    detail: `The latest ${pick.profile} run ${pick.verdict === 'PASS' ? 'met every objective' : 'met its objectives with thin margins'}${stale ? ' — older than the freshness window' : ''}.`,
  };
}

export function statusFromItems(items: EvidenceItem[]): ControlStatus {
  if (items.length === 0) return 'NOT_TESTED';
  if (items.some((i) => i.outcome === 'FAIL')) return 'FAILING';
  if (items.every((i) => i.outcome === 'PASS')) return 'EVIDENCED';
  if (items.every((i) => i.outcome === 'PASS' || i.outcome === 'STALE')) return 'EVIDENCED_STALE';
  if (items.some((i) => i.outcome === 'PASS' || i.outcome === 'STALE')) return 'PARTIAL';
  if (items.some((i) => i.outcome === 'SIM_ONLY')) return 'SIMULATOR_ONLY';
  return 'NOT_TESTED';
}

function reviewState(controlId: string, reviews: ReviewRecord[], version: string): ReviewState {
  const mine = reviews
    .filter((r) => r.controlId === controlId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = mine[0];
  if (!latest) return { status: 'DRAFT' };
  const base = {
    reviewer: latest.reviewerLabel,
    at: latest.createdAt,
    note: latest.note,
    libraryVersion: latest.libraryVersion,
  };
  return latest.libraryVersion === version
    ? { status: latest.decision, ...base }
    : { status: 'STALE_REVIEW', ...base };
}

const STATEMENT: Record<ControlStatus, (a: { count: number; partialScope: boolean }) => string> = {
  EVIDENCED: ({ partialScope }) =>
    partialScope
      ? 'Fresh evidence from the real service supports this control — within the stated limits (scope is partial).'
      : 'Fresh evidence from the real service supports this control.',
  EVIDENCED_STALE: () =>
    'Evidence from the real service exists but is older than the freshness window — re-run before relying on it.',
  PARTIAL: () =>
    'Some of the evidence this control needs is in place; the rest is missing, skipped or simulator-only.',
  SIMULATOR_ONLY: () =>
    'Only simulator evidence exists. It shows the tests work; it is not evidence about the real service.',
  NOT_TESTED: () => 'No test evidence yet.',
  FAILING: () =>
    'A test mapped to this control FAILED. This is a defect to fix, not a documentation gap.',
  OUT_OF_SCOPE: () =>
    'This control cannot be evidenced by load or API testing; other evidence is required.',
};

export function assessControls(input: AssessInput): Assessment {
  const { now, suites, load, reviews } = input;
  const maxAgeDays = input.maxAgeDays ?? 90;
  const maxAge = maxAgeDays * DAY;
  const version = input.libraryVersion ?? LIBRARY_VERSION;
  const controls = input.controls ?? CONTROLS;

  const assessed: ControlAssessment[] = controls.map((control) => {
    const items: EvidenceItem[] =
      control.scope === 'out_of_scope'
        ? []
        : control.evidence.flatMap((rule) =>
            rule.kind === 'checks'
              ? rule.checkIds.map((id) => ({
                  ...checkOutcome(id, suites, now, maxAge),
                  label: `${rule.description} (${id})`,
                }))
              : [{ ...loadOutcome(rule.profiles, load, now, maxAge), label: rule.description }],
          );
    const status: ControlStatus =
      control.scope === 'out_of_scope' ? 'OUT_OF_SCOPE' : statusFromItems(items);
    return {
      control,
      status,
      coverage: control.scope,
      items,
      review: reviewState(control.id, reviews, version),
      statement: STATEMENT[status]({
        count: items.length,
        partialScope: control.scope === 'partial',
      }),
    };
  });

  const emptyCounts = (): Record<ControlStatus, number> => ({
    EVIDENCED: 0,
    EVIDENCED_STALE: 0,
    PARTIAL: 0,
    SIMULATOR_ONLY: 0,
    NOT_TESTED: 0,
    FAILING: 0,
    OUT_OF_SCOPE: 0,
  });
  const frameworks: FrameworkSummary[] = (Object.keys(FRAMEWORKS) as Framework[]).map((f) => {
    const mine = assessed.filter((a) => a.control.framework === f);
    const byStatus = emptyCounts();
    for (const a of mine) byStatus[a.status]++;
    const testable = mine.filter((a) => a.control.scope !== 'out_of_scope').length;
    return {
      framework: f,
      name: FRAMEWORKS[f].name,
      note: FRAMEWORKS[f].note,
      total: mine.length,
      byStatus,
      evidencedShare: testable === 0 ? 0 : byStatus.EVIDENCED / testable,
      reviewedApproved: mine.filter((a) => a.review.status === 'APPROVED').length,
      unverifiedReferences: mine.filter((a) => !a.control.refVerified).length,
    };
  });

  const classes = new Set([
    ...suites.map((s) => s.environmentClass),
    ...load.map((l) => l.environmentClass),
  ]);
  const hasReal = [...classes].some(isReal);
  const hasSim = classes.has('MOCK');
  return {
    libraryVersion: version,
    asOf: now.toISOString(),
    maxAgeDays,
    basis: hasReal && hasSim ? 'mixed' : hasReal ? 'real' : hasSim ? 'simulator' : 'none',
    controls: assessed,
    frameworks,
  };
}
