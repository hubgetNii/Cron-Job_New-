import { useQuery } from '@tanstack/react-query';
import { fetchBlob, req, downloadWithAuth, type Wrapped } from './api';

/**
 * Load-testing reports client (Phase 27). Types mirror the backend report model
 * (src/services/loadtest/report/report.types.ts) — the same JSON drives this
 * page and every export format.
 */

export type RunVerdict = 'PASS' | 'PASS_WITH_WARNINGS' | 'FAIL' | 'INCONCLUSIVE';
export type SuiteVerdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE';
export type Decision = 'GO' | 'GO_WITH_CONDITIONS' | 'NO_GO' | 'RE_RUN';
export type FindingSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type ReadinessStatus = 'READY' | 'READY_WITH_WARNINGS' | 'NOT_READY' | 'INCOMPLETE';

export interface Finding {
  id: string;
  source: 'performance' | 'correctness' | 'security';
  severity: FindingSeverity;
  title: string;
  impact: string;
  cause: string;
  recommendation: string;
  reference: string;
  owasp?: string;
  advisory: boolean;
}

export interface KeyNumber {
  label: string;
  value: string;
  caption: string;
}
export interface SloCheck {
  id: string;
  name: string;
  target: string;
  actual: string;
  status: 'PASS' | 'WARN' | 'FAIL' | 'INFO';
  why: string;
}
export interface Gate {
  id: string;
  name: string;
  required: boolean;
  status: 'PASS' | 'WARN' | 'FAIL' | 'MISSING';
  detail: string;
  evidenceId?: string;
}
export interface Readiness {
  status: ReadinessStatus;
  score: number | null;
  basis: 'simulator' | 'sandbox' | 'production' | 'mixed' | 'none';
  gates: Gate[];
  reasons: string[];
  nextSteps: string[];
  asOf: string;
}
export interface ReportMeta {
  kind: 'load' | 'correctness' | 'security' | 'readiness';
  id: string;
  title: string;
  generatedAt: string;
  target: { id: string; name: string; host: string };
  environment: { class: string | null; label: string; isReal: boolean };
  requestedBy: string | null;
}
export interface SuiteDigest {
  runId: string;
  suite: 'correctness' | 'security';
  finishedAt: string;
  environmentLabel: string;
  verdict: SuiteVerdict;
  passed: number;
  failed: number;
  warnings: number;
  skipped: number;
  total: number;
  headline: string;
  failedChecks: { id: string; title: string; why: string }[];
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

export interface LoadRunReport {
  meta: ReportMeta;
  executive: { verdict: RunVerdict; decision: Decision; headline: string; summary: string; keyNumbers: KeyNumber[]; topRisks: Finding[] };
  tested: {
    scenario: string;
    shape: string;
    profile: string;
    planName: string;
    packId: string | null;
    dataSet: { name: string; records: number } | null;
    flags: string[];
    window: { queuedAt: string; startedAt: string | null; finishedAt: string | null; seconds: number | null };
  };
  results: {
    slo: SloCheck[];
    verdictReason: string;
    latency: { avgMs: number; p50Ms: number; p90Ms: number; p95Ms: number; p99Ms: number; maxMs: number };
    throughput: { totalRequests: number; expectedRequests: number; achievedAvgRps: number; peakRps: number; maxSustainedRps: number };
    errors: { classes: Record<string, number>; statusCounts: Record<string, number>; plain: string };
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
  executive: { verdict: SuiteVerdict; headline: string; summary: string; keyNumbers: KeyNumber[]; topRisks: Finding[] };
  checks: ReportCheck[];
  findings: Finding[];
  coverageGaps: { id: string; title: string; reason: string }[];
  evidence: { checkId: string; at: string; method: string; path: string; status: number; ms: number; requestId: string | null; reference?: string }[];
  logs: { timeline: TimelineEntry[]; finishedReason: string | null; error: string | null };
  readiness: Readiness;
  glossary: Record<string, string>;
}
export interface ReadinessReport {
  meta: ReportMeta;
  readiness: Readiness;
  headline: string;
  evidence: {
    load: { id: string; profile: string; verdict: RunVerdict; finishedAt: string; environmentLabel: string }[];
    correctness: SuiteDigest | null;
    security: SuiteDigest | null;
  };
  findings: Finding[];
  glossary: Record<string, string>;
}

export interface ReportIndexItem {
  kind: 'load' | 'correctness' | 'security';
  id: string;
  title: string;
  targetId: string;
  targetName: string;
  status: string;
  verdict: RunVerdict | SuiteVerdict | null;
  environmentLabel: string;
  isReal: boolean;
  finishedAt: string | null;
  queuedAt: string;
  headline: string;
}

export interface CatalogEntry {
  method: string;
  path: string;
  area: string;
  summary: string;
  permission: string[];
  kind: string;
  moneyMoving: boolean;
  realSideEffects: boolean;
  loadTest: 'ready' | 'needs_data' | 'caution' | 'excluded' | 'other';
  packId?: string;
  note?: string;
}
export interface CatalogResponse {
  summary: { total: number; apiEndpoints: number; byStatus: Record<string, number>; withPack: number };
  endpoints: CatalogEntry[];
}

export type ReportFormat = 'html' | 'pdf' | 'xlsx' | 'csv' | 'json';

/** Where a report lives in the API. */
export function reportApiPath(kind: ReportMeta['kind'], id: string, format?: ReportFormat, table?: string): string {
  const base =
    kind === 'load' ? `/load-tests/runs/${id}/report` : kind === 'readiness' ? `/load-tests/readiness/${id}` : `/load-tests/${kind}-runs/${id}/report`;
  const qs = new URLSearchParams();
  if (format) qs.set('format', format);
  if (table) qs.set('table', table);
  const s = qs.toString();
  return s ? `${base}?${s}` : base;
}

/** The dashboard route for a report. */
export const reportRoute = (kind: ReportMeta['kind'], id: string): string =>
  `/app/load-tests/${kind === 'load' ? 'run' : kind}/${id}`;

export const loadTestApi = {
  reports: (apiId?: string) =>
    req<Wrapped<ReportIndexItem[]>>(`/load-tests/reports${apiId ? `?apiId=${apiId}` : ''}`).then((r) => r.data),
  runReport: (id: string) => req<Wrapped<LoadRunReport>>(reportApiPath('load', id)).then((r) => r.data),
  suiteReport: (kind: 'correctness' | 'security', id: string) => req<Wrapped<SuiteReport>>(reportApiPath(kind, id)).then((r) => r.data),
  readiness: (apiId: string) => req<Wrapped<ReadinessReport>>(reportApiPath('readiness', apiId)).then((r) => r.data),
  catalog: () => req<Wrapped<CatalogResponse>>('/load-tests/api-catalog').then((r) => r.data),
};

export const useReportIndex = () =>
  useQuery({ queryKey: ['lt-reports'], queryFn: () => loadTestApi.reports(), refetchInterval: 15_000 });
export const useCatalog = () => useQuery({ queryKey: ['lt-catalog'], queryFn: loadTestApi.catalog, staleTime: 300_000 });

/** Opens the printable HTML report in a new tab (fetched with the session token, shown from a blob). */
export async function openHtmlReport(kind: ReportMeta['kind'], id: string): Promise<void> {
  const blob = await fetchBlob(reportApiPath(kind, id, 'html'));
  const url = URL.createObjectURL(new Blob([blob], { type: 'text/html' }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const downloadReport = (kind: ReportMeta['kind'], id: string, format: ReportFormat, table?: string): Promise<void> =>
  downloadWithAuth(reportApiPath(kind, id, format, table), `${kind}-report-${id.slice(0, 8)}.${format}`);
