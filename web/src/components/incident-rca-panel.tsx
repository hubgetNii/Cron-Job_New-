import { Microscope } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { authStore } from '@/lib/auth';
import { useIncidentRca, useRecomputeRca } from '@/lib/queries';

const PRIORITY_COLOR: Record<string, string> = {
  P1: 'var(--color-down)',
  P2: 'var(--color-degraded)',
  P3: 'var(--color-unknown)',
};

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--color-border)]">
        <div className="h-full rounded-full bg-[var(--color-brand)]" style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums text-xs text-[var(--color-text-faint)]">{pct}% confidence</span>
    </div>
  );
}

export function IncidentRcaPanel({ incidentId }: { incidentId: string }) {
  const { data: rca, isLoading } = useIncidentRca(incidentId);
  const recompute = useRecomputeRca(incidentId);
  const canOperate = ['OPERATOR', 'ADMIN'].some((r) => authStore.user()?.roles.includes(r as never));

  return (
    <section className="space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Microscope className="h-4 w-4 text-[var(--color-brand)]" />
          <span className="text-sm font-medium">Root-cause analysis</span>
          <Badge
            className="border-[var(--color-brand)] text-[var(--color-brand)]"
            title="Deterministic rules engine. Advisory only — it never changes the incident."
          >
            ASSISTIVE
          </Badge>
        </div>
        {canOperate && (
          <Button
            size="sm"
            variant="outline"
            disabled={recompute.isPending}
            onClick={() => recompute.mutate()}
          >
            {recompute.isPending ? 'Recomputing…' : 'Recompute'}
          </Button>
        )}
      </header>

      {isLoading && <p className="text-xs text-[var(--color-text-faint)]">Loading…</p>}

      {!isLoading && !rca && (
        <p className="text-xs text-[var(--color-text-faint)]">
          No RCA yet — it is computed automatically as the incident progresses.
        </p>
      )}

      {rca && (
        <div className="space-y-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-[var(--color-text-faint)]">Summary</p>
            <p className="text-sm">{rca.summary}</p>
          </div>

          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5">
              {rca.category} · {rca.subtype}
            </span>
            {rca.occurrences24h > 1 && (
              <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[var(--color-degraded)]">
                {rca.occurrences24h}× in 24h
              </span>
            )}
            {rca.latency && (
              <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 tabular-nums">
                {rca.latency.baselineMs}ms → {rca.latency.recentMs}ms ({rca.latency.ratio}×)
              </span>
            )}
          </div>

          <div>
            <p className="text-xs uppercase tracking-wide text-[var(--color-text-faint)]">
              Probable cause
            </p>
            <p className="text-sm">{rca.probableCause}</p>
            <ConfidenceBar value={rca.confidence} />
          </div>

          {rca.evidence.length > 0 && (
            <div>
              <p className="text-xs uppercase tracking-wide text-[var(--color-text-faint)]">
                Evidence
              </p>
              <ul className="list-disc space-y-0.5 pl-4 text-xs text-[var(--color-text-muted)]">
                {rca.evidence.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <p className="text-xs uppercase tracking-wide text-[var(--color-text-faint)]">Impact</p>
            <p className="text-sm text-[var(--color-text-muted)]">{rca.impact}</p>
          </div>

          <div className="rounded-md border border-[var(--color-border)] p-2">
            <div className="flex items-center gap-2">
              <span
                className="rounded px-1.5 py-0.5 text-xs font-semibold"
                style={{ color: PRIORITY_COLOR[rca.recommendation.priority] }}
              >
                {rca.recommendation.priority}
              </span>
              <span className="text-xs font-medium">{rca.recommendation.finding}</span>
            </div>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              {rca.recommendation.recommendation}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
