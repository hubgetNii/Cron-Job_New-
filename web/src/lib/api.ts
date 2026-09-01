import { authStore, type AuthUser } from './auth';
import type {
  AiInsight,
  Alert,
  AnomalySignal,
  CronJobRun,
  DashboardSummary,
  HealthCheckRow,
  Incident,
  IncidentAnalysis,
  MissedRun,
  PerfBucket,
  HealthCheckRun,
  HealthCheckRunDetail,
  PublicStatus,
  RawTrace,
  RootCauseAnalysis,
  SlaReport,
  SlaSummaryRow,
  Target,
  TargetStatusRow,
  TestOutcome,
  TraceRow,
  TraceSearchParams,
} from './types';

const BASE = import.meta.env.VITE_API_URL ?? '/api/v1';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  const token = authStore.accessToken();
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
}

let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  const rt = authStore.refreshToken();
  if (!rt) return false;
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!res.ok) return false;
      const { data } = (await res.json()) as {
        data: { accessToken: string; refreshToken: string };
      };
      authStore.setAccess(data.accessToken, data.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await rawFetch(path, init);

  if (res.status === 401 && !path.startsWith('/auth/') && (await tryRefresh())) {
    res = await rawFetch(path, init);
  }
  if (res.status === 401 && !path.startsWith('/auth/')) {
    authStore.clear();
    if (window.location.pathname !== '/login') window.location.href = '/login';
  }

  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = body as { error?: { message?: string; code?: string } } | null;
    throw new ApiError(
      err?.error?.message ?? `Request failed (${res.status})`,
      res.status,
      err?.error?.code,
    );
  }
  return body as T;
}

export interface LoginResponse {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

type Wrapped<T> = { data: T; count?: number };

/** Serialises trace-search params, dropping empties. Also used for the CSV export URL. */
export function traceQuery(params: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '' && v !== null) qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export const api = {
  dashboardSummary: () => req<Wrapped<DashboardSummary>>('/dashboard/summary').then((r) => r.data),
  performance: (hours = 6) =>
    req<Wrapped<PerfBucket[]>>(`/dashboard/performance?hours=${hours}`).then((r) => r.data),
  targetBoard: () => req<Wrapped<TargetStatusRow[]>>('/dashboard/targets').then((r) => r.data),

  targets: () => req<Wrapped<Target[]>>('/targets').then((r) => r.data),
  target: (id: string) => req<Wrapped<Target>>(`/targets/${id}`).then((r) => r.data),
  setTargetEnabled: (id: string, enabled: boolean) =>
    req<Wrapped<Target>>(`/targets/${id}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }).then(
      (r) => r.data,
    ),
  testTarget: (id: string) =>
    req<Wrapped<TestOutcome>>(`/targets/${id}/test`, { method: 'POST' }).then((r) => r.data),
  healthChecks: (id: string, limit = 120) =>
    req<Wrapped<HealthCheckRow[]>>(`/health-checks/${id}?limit=${limit}`).then((r) => r.data),

  incidents: (params = '') => req<Wrapped<Incident[]>>(`/incidents${params}`).then((r) => r.data),
  incident: (id: string) => req<Wrapped<Incident>>(`/incidents/${id}`).then((r) => r.data),
  acknowledgeIncident: (id: string) =>
    req<Wrapped<Incident>>(`/incidents/${id}/acknowledge`, { method: 'POST' }).then((r) => r.data),
  resolveIncident: (id: string, resolution: string) =>
    req<Wrapped<Incident>>(`/incidents/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolution }),
    }).then((r) => r.data),

  alerts: (params = '') => req<Wrapped<Alert[]>>(`/alerts${params}`).then((r) => r.data),
  schedulerStatus: () =>
    req<Wrapped<DashboardSummary['scheduler']>>('/scheduler/status').then((r) => r.data),
  jobRuns: () => req<Wrapped<CronJobRun[]>>('/scheduler/jobs').then((r) => r.data),
  missedRuns: () => req<Wrapped<MissedRun[]>>('/scheduler/missed-runs').then((r) => r.data),

  configRequests: (params = '') =>
    req<Wrapped<ConfigChangeRequest[]>>(`/config-requests${params}`).then((r) => r.data),
  reviewConfigRequest: (id: string, decision: 'approve' | 'reject', note?: string) =>
    req<Wrapped<ConfigChangeRequest>>(`/config-requests/${id}/${decision}`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }).then((r) => r.data),

  aiStatus: () => req<Wrapped<{ configured: boolean }>>('/ai/status').then((r) => r.data),
  incidentInsights: (id: string) =>
    req<Wrapped<AiInsight[]>>(`/incidents/${id}/ai`).then((r) => r.data),
  analyzeIncident: (id: string) =>
    req<Wrapped<IncidentAnalysis>>(`/incidents/${id}/ai/analyze`, { method: 'POST' }).then(
      (r) => r.data,
    ),
  anomalies: (hours = 24) =>
    req<Wrapped<AiInsight[]>>(`/anomalies?hours=${hours}`).then((r) => r.data),
  targetAnomalies: (id: string) =>
    req<Wrapped<AnomalySignal[]>>(`/targets/${id}/anomalies`).then((r) => r.data),

  incidentRca: (id: string) =>
    req<Wrapped<RootCauseAnalysis | null>>(`/incidents/${id}/rca`).then((r) => r.data),
  recomputeIncidentRca: (id: string) =>
    req<Wrapped<RootCauseAnalysis>>(`/incidents/${id}/rca/recompute`, { method: 'POST' }).then(
      (r) => r.data,
    ),

  traces: (params: TraceSearchParams) =>
    req<Wrapped<TraceRow[]> & { total: number }>(
      `/observability/traces${traceQuery(params as Record<string, unknown>)}`,
    ).then((r) => ({ rows: r.data, total: r.total })),
  trace: (checkId: string) =>
    req<Wrapped<TraceRow>>(`/observability/traces/${checkId}`).then((r) => r.data),
  healthCheckRuns: (limit = 30) =>
    req<Wrapped<HealthCheckRun[]>>(`/observability/health-checks?limit=${limit}`).then(
      (r) => r.data,
    ),
  healthCheckRun: (hcId: string) =>
    req<Wrapped<HealthCheckRunDetail>>(`/observability/health-checks/${hcId}`).then((r) => r.data),
  revealTrace: (checkId: string) =>
    req<Wrapped<RawTrace>>(`/observability/traces/${checkId}/raw`).then((r) => r.data),

  slaSummary: () =>
    req<Wrapped<{ targets: SlaSummaryRow[]; meeting: number; breaching: number }>>(
      '/sla/summary',
    ).then((r) => r.data),
  targetSla: (id: string) => req<Wrapped<SlaReport[]>>(`/sla/${id}`).then((r) => r.data),

  login: (email: string, password: string) =>
    req<Wrapped<LoginResponse>>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }).then((r) => r.data),
  logout: () => req<null>('/auth/logout', { method: 'POST' }).catch(() => null),
  me: () => req<Wrapped<AuthUser>>('/auth/me').then((r) => r.data),
};

/** Authenticated file download (compliance exports). Triggers a browser save. */
export async function downloadWithAuth(path: string, filename: string): Promise<void> {
  const res = await rawFetch(path, {});
  if (!res.ok) throw new ApiError(`Download failed (${res.status})`, res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Public, unauthenticated — the status page must work with no session. */
export async function fetchPublicStatus(): Promise<PublicStatus> {
  const res = await fetch(`${BASE}/status`);
  if (!res.ok) throw new ApiError(`Status unavailable (${res.status})`, res.status);
  return ((await res.json()) as Wrapped<PublicStatus>).data;
}

export interface ConfigChangeRequest {
  id: string;
  kind: string;
  targetId: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'APPLIED' | 'FAILED';
  summary: string;
  proposedBy: string;
  reviewedBy: string | null;
  reviewNote: string | null;
  error: string | null;
  createdAt: string;
}
