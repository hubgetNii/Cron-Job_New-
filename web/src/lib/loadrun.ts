import { useQuery } from '@tanstack/react-query';
import { req, type Wrapped } from './api';

/** Run launcher + live console client (B2). Mirrors the /load-tests/* run endpoints. */

export type RunStatus = 'QUEUED' | 'PREFLIGHT' | 'RUNNING' | 'COMPLETED' | 'ABORTED' | 'FAILED';
export type Profile = 'SMOKE' | 'LOAD' | 'STRESS' | 'SPIKE' | 'SOAK' | 'BREAKPOINT';

export interface PackInfo {
  id: string;
  title: string;
  channel: string;
  description: string;
  endpoint: { method: string; path: string };
  moneyMoving: boolean;
  realSideEffects: boolean;
  sandboxSupport: string;
  dataFields: string[];
  recommended: { profile: Profile; targetRps: number; durationSeconds: number; maxVus: number };
  notes: string[];
  caution?: string;
  exampleDataSets: { name: string; description: string; needsEdit: boolean }[];
}
export interface DataSetInfo {
  id: string;
  name: string;
  environment: string;
  recordCount: number;
  fields: string[];
}
export interface Violation {
  code: string;
  message: string;
}
export interface Safety {
  allowed: boolean;
  effectiveClass: string | null;
  violations: Violation[];
}
export interface PlanInfo {
  id: string;
  name: string;
  effectiveRps?: number;
}
export interface RunSummaryLite {
  totalRequests: number;
  failedRequests: number;
  errorRate: number;
  latencyMs: { p50: number; p95: number; p99: number };
  achievedAvgRps: number;
  generatorSaturated: boolean;
}
export interface LoadRunInfo {
  id: string;
  planId: string;
  apiId: string;
  status: RunStatus;
  snapshot: { name?: string; config?: { profile?: Profile } };
  effectiveClass: string | null;
  abortRequested: boolean;
  finishedReason: string | null;
  error: string | null;
  summary: RunSummaryLite | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface SuiteRunInfo {
  id: string;
  apiId: string;
  status: RunStatus;
  suite: 'correctness' | 'security';
  mode: 'simulator' | 'live' | null;
  effectiveClass: string | null;
  error: string | null;
  summary: { passed?: number; failed?: number; total?: number } | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface MetricPoint {
  bucketStart: string;
  requests: number;
  failures: number;
  rps: number;
  p95Ms: number;
  p99Ms: number;
}
export interface ProgrammeTier {
  id: string;
  label: string;
  purpose: string;
  peakRps: number;
  fits: boolean;
  reductions: string[];
  plan: {
    profile: Profile;
    targetRps: number;
    durationSeconds: number;
    maxVus: number;
    spikeMultiplier?: number;
    requiredCapacityRps: number | null;
  };
}
export interface Programme {
  id: string;
  title: string;
  dailyVolume: number;
  averageTps: number;
  note: string;
  tiers: ProgrammeTier[];
}
export interface ProgrammeResponse {
  provisional: boolean;
  ceiling: { maxRps: number; maxVus: number; maxDurationSeconds: number };
  programmes: Programme[];
}

export interface PlanParams {
  spikeMultiplier?: number;
  requiredCapacityRps?: number;
  apiId: string;
  dataSetId?: string;
  profile?: Profile;
  targetRps?: number;
  durationSeconds?: number;
  maxVus?: number;
}

export interface ScheduleInfo {
  id: string;
  apiId: string;
  targetName: string | null;
  suite: 'correctness' | 'security';
  cron: string;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastOutcome: 'QUEUED' | 'REFUSED' | 'SKIPPED_BUSY' | 'ERROR' | null;
  lastMessage: string | null;
}

export interface SinkInfo {
  id: string;
  label: string;
  slug: string;
  hasSecret: boolean;
  enabled: boolean;
  deliveries: number;
  lastDeliveryAt: string | null;
}
export interface DeliveryInfo {
  id: number;
  eventId: string;
  eventType: string | null;
  reference: string | null;
  attempt: number;
  signatureOk: boolean;
  reason: string | null;
  respondedWith: number;
  receivedAt: string;
}

export const isLive = (s: RunStatus): boolean =>
  s === 'QUEUED' || s === 'PREFLIGHT' || s === 'RUNNING';

const post = <T>(path: string, body: unknown) =>
  req<Wrapped<T>>(path, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.data);

export const runApi = {
  packs: () => req<Wrapped<PackInfo[]>>('/load-tests/packs').then((r) => r.data),
  dataSets: () => req<Wrapped<DataSetInfo[]>>('/load-tests/data-sets').then((r) => r.data),
  exampleDataSet: (packId: string, name: string) =>
    post<DataSetInfo>(
      `/load-tests/packs/${packId}/example-datasets/${encodeURIComponent(name)}`,
      {},
    ),
  preflight: (
    apiId: string,
    rps: number,
    vus: number,
    durationSeconds: number,
    mutating: boolean,
  ) => post<Safety>('/load-tests/safety/preflight', { apiId, rps, vus, durationSeconds, mutating }),
  createPlan: (packId: string, p: PlanParams) =>
    post<PlanInfo>(`/load-tests/packs/${packId}/plans`, p),
  queue: (planId: string) => post<LoadRunInfo>(`/load-tests/plans/${planId}/runs`, {}),
  queueSuite: (suite: 'correctness' | 'security', apiId: string) =>
    post<SuiteRunInfo>(`/load-tests/${suite}-runs`, { apiId }),
  harvest: (runId: string, limit = 500) =>
    post<DataSetInfo & { caveat: string | null }>(`/load-tests/runs/${runId}/harvest-references`, {
      limit,
    }),
  programme: () => req<Wrapped<ProgrammeResponse>>('/load-tests/programme').then((r) => r.data),
  sinks: () => req<Wrapped<SinkInfo[]>>('/load-tests/webhook-sinks').then((r) => r.data),
  createSink: (label: string) => post<SinkInfo>('/load-tests/webhook-sinks', { label }),
  setSinkSecret: (id: string, secret: string) =>
    req<Wrapped<SinkInfo>>(`/load-tests/webhook-sinks/${id}/secret`, {
      method: 'PUT',
      body: JSON.stringify({ secret }),
    }).then((r) => r.data),
  deliveries: (id: string) =>
    req<Wrapped<DeliveryInfo[]>>(`/load-tests/webhook-sinks/${id}/deliveries?limit=30`).then(
      (r) => r.data,
    ),
  deleteSink: (id: string) => req<unknown>(`/load-tests/webhook-sinks/${id}`, { method: 'DELETE' }),
  schedules: () => req<Wrapped<ScheduleInfo[]>>('/load-tests/schedules').then((r) => r.data),
  saveSchedule: (apiId: string, suite: ScheduleInfo['suite'], cron: string) =>
    post<ScheduleInfo>('/load-tests/schedules', { apiId, suite, cron }),
  setSchedule: (id: string, enabled: boolean) =>
    req<Wrapped<ScheduleInfo>>(`/load-tests/schedules/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }).then((r) => r.data),
  deleteSchedule: (id: string) => req<unknown>(`/load-tests/schedules/${id}`, { method: 'DELETE' }),
  abort: (runId: string, reason: string) =>
    post<LoadRunInfo>(`/load-tests/runs/${runId}/abort`, { reason }),
  runs: () => req<Wrapped<LoadRunInfo[]>>('/load-tests/runs?limit=15').then((r) => r.data),
  metrics: (runId: string) =>
    req<Wrapped<MetricPoint[]>>(`/load-tests/runs/${runId}/metrics`).then((r) => r.data),
  suiteRuns: (suite: 'correctness' | 'security') =>
    req<Wrapped<SuiteRunInfo[]>>(`/load-tests/${suite}-runs?limit=10`).then((r) => r.data),
};

export const useRuns = () =>
  useQuery({
    queryKey: ['lt-runs'],
    queryFn: runApi.runs,
    refetchInterval: (q) => (q.state.data?.some((r) => isLive(r.status)) ? 2_000 : 15_000),
  });
export const useSuiteRuns = (suite: 'correctness' | 'security') =>
  useQuery({
    queryKey: ['lt-suite-runs', suite],
    queryFn: () => runApi.suiteRuns(suite),
    refetchInterval: (q) => (q.state.data?.some((r) => isLive(r.status)) ? 2_000 : 15_000),
  });
export const useRunMetrics = (runId: string | null, live: boolean) =>
  useQuery({
    queryKey: ['lt-metrics', runId],
    queryFn: () => runApi.metrics(runId!),
    enabled: runId != null,
    refetchInterval: live ? 2_000 : false,
  });
