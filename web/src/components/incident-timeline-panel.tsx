import { GitCommitVertical } from 'lucide-react';
import { useIncidentTimeline } from '@/lib/queries';

const KIND_COLOR: Record<string, string> = {
  detected: 'var(--color-down)',
  failure_changed: 'var(--color-degraded)',
  severity_escalated: 'var(--color-down)',
  flapping_detected: 'var(--color-degraded)',
  latency_elevated: 'var(--color-degraded)',
  dependency_error: 'var(--color-down)',
  database_error: 'var(--color-down)',
  rca_computed: 'var(--color-brand)',
  alert_sent: 'var(--color-series-1)',
  alert_queued: 'var(--color-text-faint)',
  alert_failed: 'var(--color-down)',
  alert_suppressed: 'var(--color-text-faint)',
  acknowledged: 'var(--color-series-1)',
  recovered: 'var(--color-up)',
  resolved: 'var(--color-up)',
};

const LABEL: Record<string, string> = {
  detected: 'Detected',
  failure_changed: 'Failure changed',
  severity_escalated: 'Escalated',
  flapping_detected: 'Flapping',
  latency_elevated: 'Latency elevated',
  dependency_error: 'Dependency error',
  database_error: 'Database error',
  rca_computed: 'Root cause',
  alert_sent: 'Alert sent',
  alert_queued: 'Alert queued',
  alert_failed: 'Alert failed',
  alert_suppressed: 'Alert suppressed',
  acknowledged: 'Acknowledged',
  recovered: 'Recovered',
  resolved: 'Resolved',
};

export function IncidentTimelinePanel({ incidentId }: { incidentId: string }) {
  const { data: entries, isLoading } = useIncidentTimeline(incidentId);

  return (
    <section className="space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3">
      <header className="flex items-center gap-2">
        <GitCommitVertical className="h-4 w-4 text-[var(--color-brand)]" />
        <span className="text-sm font-medium">Timeline</span>
      </header>

      {isLoading && <p className="text-xs text-[var(--color-text-faint)]">Loading…</p>}
      {!isLoading && (entries ?? []).length === 0 && (
        <p className="text-xs text-[var(--color-text-faint)]">No events recorded yet.</p>
      )}

      <ol className="relative space-y-3 border-l border-[var(--color-border)] pl-4">
        {(entries ?? []).map((e, i) => {
          const color = KIND_COLOR[e.kind] ?? 'var(--color-text-muted)';
          return (
            <li key={i} className="relative">
              <span
                className="absolute -left-[21px] top-1 size-2 rounded-full ring-2 ring-[var(--color-surface-1)]"
                style={{ background: color }}
              />
              <div className="flex items-baseline gap-2">
                <time className="shrink-0 font-mono text-xs tabular-nums text-[var(--color-text-faint)]">
                  {new Date(e.at).toLocaleTimeString()}
                </time>
                <span className="text-xs font-medium" style={{ color }}>
                  {LABEL[e.kind] ?? e.kind}
                </span>
              </div>
              <p className="text-sm text-[var(--color-text-muted)]">{e.summary}</p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
