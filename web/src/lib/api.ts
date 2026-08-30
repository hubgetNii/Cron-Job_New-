import type {
  Alert,
  CronJobRun,
  DashboardSummary,
  HealthCheckRow,
  Incident,
  MissedRun,
  PerfBucket,
  Target,
  TargetStatusRow,
  TestOutcome,
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

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-actor-id': 'dashboard',
      ...init?.headers,
    },
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = body as { error?: { message?: string; code?: string } } | null;
    throw new ApiError(err?.error?.message ?? `Request failed (${res.status})`, res.status, err?.error?.code);
  }
  return body as T;
}

type Wrapped<T> = { data: T; count?: number };

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
};
