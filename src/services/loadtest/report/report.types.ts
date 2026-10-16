import type { Finding } from '../../../domain/load-findings.js';
import type { Readiness } from '../../../domain/load-readiness.js';
import type { RunVerdict, SloCheck, SloTargets } from '../../../domain/load-slo.js';
import type { LoadEnvironmentClass, LoadProfile } from '../../../domain/enums.js';
import type { Exchange } from '../../../loadtest/correctness/client.js';

/**
 * Report data model (Phase 27). One structure serves two audiences:
 *  - the BUSINESS view reads `executive`, `moneySafety`, `security`, `findings`
 *    (plain sentences, a decision, no jargon);
 *  - the TECHNICAL view reads `results`, `logs`, `trend` and the evidence.
 * The same JSON drives the dashboard page, the HTML/PDF/XLSX/CSV exports and,
 * in Phase 28, the compliance evidence pack.
 */

export type ReportKind = 'load' | 'correctness' | 'security' | 'readiness';
export type Decision = 'GO' | 'GO_WITH_CONDITIONS' | 'NO_GO' | 'RE_RUN';

export interface ReportMeta {
  kind: ReportKind;
  id: string;
  title: string;
  generatedAt: string;
  target: { id: string; name: string; host: string };
  environment: {
    class: LoadEnvironmentClass | null;
    /** Plain label: "iSmartPay sandbox", "Simulator (not the real service)", … */
    label: string;
    isReal: boolean;
  };
  requestedBy: string | null;
}

export interface KeyNumber {
  label: string;
  value: string;
  caption: string;
}

export interface MetricRow {
  at: string;
  requests: number;
  failures: number;
  rps: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  statusCounts: Record<string, number>;
}

export interface TimelineEntry {
  at: string;
  event: string;
  detail: string;
  actor: string | null;
}

export interface TrendPoint {
  runId: string;
  finishedAt: string;
  verdict: RunVerdict;
  p95Ms: number;
  errorRate: number;
  achievedRps: number;
  current: boolean;
}

export interface SuiteDigest {
  runId: string;
  suite: 'correctness' | 'security';
  finishedAt: string;
  environmentLabel: string;
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  passed: number;
  failed: number;
  warnings: number;
  skipped: number;
  total: number;
  headline: string;
  failedChecks: { id: string; title: string; why: string }[];
}

export interface LoadRunReport {
  meta: ReportMeta;
  executive: {
    verdict: RunVerdict;
    decision: Decision;
    headline: string;
    summary: string;
    keyNumbers: KeyNumber[];
    topRisks: Finding[];
  };
  tested: {
    scenario: string;
    shape: string;
    profile: LoadProfile;
    planName: string;
    packId: string | null;
    dataSet: { name: string; records: number } | null;
    stages: { durationSeconds: number; target: number }[];
    slo: SloTargets;
    flags: string[];
    window: {
      queuedAt: string;
      startedAt: string | null;
      finishedAt: string | null;
      seconds: number | null;
    };
  };
  results: {
    slo: SloCheck[];
    verdictReason: string;
    latency: {
      avgMs: number;
      p50Ms: number;
      p90Ms: number;
      p95Ms: number;
      p99Ms: number;
      maxMs: number;
    };
    throughput: {
      totalRequests: number;
      expectedRequests: number;
      achievedAvgRps: number;
      peakRps: number;
      maxSustainedRps: number;
    };
    errors: {
      classes: Record<string, number>;
      statusCounts: Record<string, number>;
      plain: string;
    };
    series: MetricRow[];
  };
  moneySafety: SuiteDigest | null;
  security: SuiteDigest | null;
  findings: Finding[];
  trend: TrendPoint[];
  logs: {
    timeline: TimelineEntry[];
    runConfig: unknown;
    reproduce: string[];
    generator: { saturated: boolean; droppedIterations: number; k6Version: string | null };
    finishedReason: string | null;
    error: string | null;
  };
  readiness: Readiness;
  glossary: Record<string, string>;
}

export interface ReportCheck {
  id: string;
  title: string;
  owasp: string | null;
  controls: string[];
  status: 'PASS' | 'FAIL' | 'ERROR' | 'SKIPPED';
  /** Why a business reader should care about this check. */
  whyItMatters: string;
  assertions: { name: string; pass: boolean; detail: string | null; advisory: boolean }[];
  warnings: number;
  durationMs: number;
  evidenceCount: number;
  note: string | null;
}

export interface SuiteReport {
  meta: ReportMeta;
  suite: 'correctness' | 'security';
  executive: {
    verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
    headline: string;
    summary: string;
    keyNumbers: KeyNumber[];
    topRisks: Finding[];
  };
  checks: ReportCheck[];
  findings: Finding[];
  /** What could NOT be checked in this environment, and why — never hidden. */
  coverageGaps: { id: string; title: string; reason: string }[];
  /** Per-call evidence, flattened. Ids and statuses only. */
  evidence: (Exchange & { checkId: string })[];
  logs: { timeline: TimelineEntry[]; finishedReason: string | null; error: string | null };
  readiness: Readiness;
  glossary: Record<string, string>;
}

export interface ReadinessReport {
  meta: ReportMeta;
  readiness: Readiness;
  headline: string;
  evidence: {
    load: {
      id: string;
      profile: LoadProfile;
      verdict: RunVerdict;
      finishedAt: string;
      environmentLabel: string;
    }[];
    correctness: SuiteDigest | null;
    security: SuiteDigest | null;
  };
  findings: Finding[];
  glossary: Record<string, string>;
}

export type AnyReport = LoadRunReport | SuiteReport | ReadinessReport;

export interface ReportIndexItem {
  kind: Exclude<ReportKind, 'readiness'>;
  id: string;
  title: string;
  targetId: string;
  targetName: string;
  status: string;
  verdict: RunVerdict | 'PASS' | 'FAIL' | 'INCONCLUSIVE' | null;
  environmentLabel: string;
  isReal: boolean;
  finishedAt: string | null;
  queuedAt: string;
  headline: string;
}
