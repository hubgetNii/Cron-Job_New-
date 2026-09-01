import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { TraceSearchParams } from './types';

const LIVE = 10_000; // poll every 10s — the dashboard is a live view

export const useSummary = () =>
  useQuery({ queryKey: ['summary'], queryFn: api.dashboardSummary, refetchInterval: LIVE });

export const usePerformance = (hours = 6) =>
  useQuery({
    queryKey: ['performance', hours],
    queryFn: () => api.performance(hours),
    refetchInterval: LIVE,
  });

export const useTargetBoard = () =>
  useQuery({ queryKey: ['target-board'], queryFn: api.targetBoard, refetchInterval: LIVE });

export const useTargets = () => useQuery({ queryKey: ['targets'], queryFn: api.targets });

export const useIncidents = (params = '') =>
  useQuery({
    queryKey: ['incidents', params],
    queryFn: () => api.incidents(params),
    refetchInterval: LIVE,
  });

export const useIncident = (id: string | null) =>
  useQuery({
    queryKey: ['incident', id],
    queryFn: () => api.incident(id!),
    enabled: id != null,
  });

export const useAlerts = (params = '') =>
  useQuery({ queryKey: ['alerts', params], queryFn: () => api.alerts(params), refetchInterval: LIVE });

export const useJobRuns = () =>
  useQuery({ queryKey: ['job-runs'], queryFn: api.jobRuns, refetchInterval: LIVE });

export const useMissedRuns = () =>
  useQuery({ queryKey: ['missed-runs'], queryFn: api.missedRuns, refetchInterval: LIVE });

export const useHealthChecks = (id: string | null) =>
  useQuery({
    queryKey: ['health-checks', id],
    queryFn: () => api.healthChecks(id!),
    enabled: id != null,
  });

export const useAiStatus = () =>
  useQuery({ queryKey: ['ai-status'], queryFn: api.aiStatus, staleTime: 60_000 });

export const useIncidentInsights = (id: string | null) =>
  useQuery({
    queryKey: ['incident-insights', id],
    queryFn: () => api.incidentInsights(id!),
    enabled: id != null,
    refetchInterval: LIVE,
  });

export const useAnomalies = (hours = 24) =>
  useQuery({
    queryKey: ['anomalies', hours],
    queryFn: () => api.anomalies(hours),
    refetchInterval: LIVE,
  });

export function useAnalyzeIncident(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.analyzeIncident(id!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['incident-insights', id] });
    },
  });
}

export const useIncidentRca = (id: string | null) =>
  useQuery({
    queryKey: ['incident-rca', id],
    queryFn: () => api.incidentRca(id!),
    enabled: id != null,
    refetchInterval: LIVE,
  });

export const useIncidentTimeline = (id: string | null) =>
  useQuery({
    queryKey: ['incident-timeline', id],
    queryFn: () => api.incidentTimeline(id!),
    enabled: id != null,
    refetchInterval: LIVE,
  });

export function useRecomputeRca(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.recomputeIncidentRca(id!),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['incident-rca', id] }),
  });
}

export const useTraces = (params: TraceSearchParams) =>
  useQuery({
    queryKey: ['traces', params],
    queryFn: () => api.traces(params),
    refetchInterval: LIVE,
    placeholderData: (prev) => prev,
  });

export const useTrace = (checkId: string | null) =>
  useQuery({
    queryKey: ['trace', checkId],
    queryFn: () => api.trace(checkId!),
    enabled: checkId != null,
  });

export const useHealthCheckRuns = (limit = 30) =>
  useQuery({
    queryKey: ['health-check-runs', limit],
    queryFn: () => api.healthCheckRuns(limit),
    refetchInterval: LIVE,
  });

export const useHealthCheckRun = (hcId: string | null) =>
  useQuery({
    queryKey: ['health-check-run', hcId],
    queryFn: () => api.healthCheckRun(hcId!),
    enabled: hcId != null,
  });

export const useLatencyAll = () =>
  useQuery({ queryKey: ['latency-all'], queryFn: api.latencyAll, refetchInterval: LIVE });

export const useLatency = (apiId: string | null) =>
  useQuery({
    queryKey: ['latency', apiId],
    queryFn: () => api.latency(apiId!),
    enabled: apiId != null,
  });

export const useSlaSummary = () =>
  useQuery({ queryKey: ['sla-summary'], queryFn: api.slaSummary, refetchInterval: 30_000 });

export const useTargetSla = (id: string | null) =>
  useQuery({
    queryKey: ['sla', id],
    queryFn: () => api.targetSla(id!),
    enabled: id != null,
  });

export function useTargetActions() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['target-board'] });
    void qc.invalidateQueries({ queryKey: ['targets'] });
    void qc.invalidateQueries({ queryKey: ['summary'] });
  };
  return {
    setEnabled: useMutation({
      mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
        api.setTargetEnabled(id, enabled),
      onSuccess: invalidate,
    }),
    test: useMutation({ mutationFn: (id: string) => api.testTarget(id) }),
  };
}

export function useIncidentActions() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['incidents'] });
    void qc.invalidateQueries({ queryKey: ['incident'] });
    void qc.invalidateQueries({ queryKey: ['summary'] });
  };
  return {
    acknowledge: useMutation({
      mutationFn: (id: string) => api.acknowledgeIncident(id),
      onSuccess: invalidate,
    }),
    resolve: useMutation({
      mutationFn: ({ id, resolution }: { id: string; resolution: string }) =>
        api.resolveIncident(id, resolution),
      onSuccess: invalidate,
    }),
  };
}
