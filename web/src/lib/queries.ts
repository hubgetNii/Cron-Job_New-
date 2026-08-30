import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

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
