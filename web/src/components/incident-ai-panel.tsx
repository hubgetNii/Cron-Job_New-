import { Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { authStore } from '@/lib/auth';
import { useAiStatus, useAnalyzeIncident, useIncidentInsights } from '@/lib/queries';
import type { AiInsight } from '@/lib/types';

function ConfidenceBar({ value }: { value: number | null }) {
  if (value == null) return null;
  const pct = Math.round(value * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--color-border)]">
        <div
          className="h-full rounded-full bg-[var(--color-brand)]"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="tabular-nums text-xs text-[var(--color-text-faint)]">{pct}% confidence</span>
    </div>
  );
}

function byKind(insights: AiInsight[] | undefined, kind: AiInsight['kind']): AiInsight | undefined {
  return insights?.find((i) => i.kind === kind);
}

export function IncidentAiPanel({ incidentId }: { incidentId: string }) {
  const status = useAiStatus();
  const insights = useIncidentInsights(incidentId);
  const analyze = useAnalyzeIncident(incidentId);
  const canOperate = ['OPERATOR', 'ADMIN'].some((r) =>
    authStore.user()?.roles.includes(r as never),
  );

  const classification = byKind(insights.data, 'failure_classification');
  const rootCause = byKind(insights.data, 'root_cause');
  const summary = byKind(insights.data, 'incident_summary');
  const configured = status.data?.configured ?? false;

  const cls = classification?.content as
    | { classification: string; reasoning: string }
    | undefined;
  const rc = rootCause?.content as
    | {
        hypotheses: { cause: string; confidence: number; evidence: string }[];
        recommendedNextStep: string;
      }
    | undefined;
  const sm = summary?.content as { summary: string; impact: string } | undefined;

  return (
    <section className="space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-[var(--color-brand)]" />
          <span className="text-sm font-medium">AI analysis</span>
          <Badge
            className="border-[var(--color-brand)] text-[var(--color-brand)]"
            title="Advisory only — a human decides. Never used to set health status or close an incident."
          >
            ASSISTIVE
          </Badge>
        </div>
        {canOperate && configured && (
          <Button
            size="sm"
            variant="outline"
            disabled={analyze.isPending}
            onClick={() => analyze.mutate()}
          >
            {analyze.isPending
              ? 'Analyzing…'
              : insights.data && insights.data.length > 0
                ? 'Re-run'
                : 'Run analysis'}
          </Button>
        )}
      </header>

      {!configured && (
        <p className="text-xs text-[var(--color-text-faint)]">
          AI features are not configured on this instance (set <code>ANTHROPIC_API_KEY</code>).
        </p>
      )}

      {analyze.isError && (
        <p className="text-xs text-[var(--color-down)]">
          Analysis failed. The AI service is advisory — the incident is unaffected.
        </p>
      )}

      {configured && (!insights.data || insights.data.length === 0) && !analyze.isPending && (
        <p className="text-xs text-[var(--color-text-faint)]">
          No analysis yet.{canOperate ? ' Run one to get a suggested classification, root-cause hypotheses and a summary.' : ''}
        </p>
      )}

      {cls && (
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-[var(--color-text-faint)]">
            Suggested classification
          </p>
          <p className="font-mono text-sm">{cls.classification}</p>
          <ConfidenceBar value={classification?.confidence ?? null} />
          <p className="text-xs text-[var(--color-text-muted)]">{cls.reasoning}</p>
        </div>
      )}

      {rc && (
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-[var(--color-text-faint)]">
            Root-cause hypotheses
          </p>
          <ol className="space-y-1.5">
            {rc.hypotheses.map((h, i) => (
              <li key={i} className="text-sm">
                <span className="text-[var(--color-text)]">{h.cause}</span>
                <ConfidenceBar value={h.confidence} />
                <p className="text-xs text-[var(--color-text-muted)]">{h.evidence}</p>
              </li>
            ))}
          </ol>
          <p className="pt-1 text-xs text-[var(--color-text-muted)]">
            <span className="text-[var(--color-text-faint)]">Next step: </span>
            {rc.recommendedNextStep}
          </p>
        </div>
      )}

      {sm && (
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-[var(--color-text-faint)]">Summary</p>
          <p className="text-sm text-[var(--color-text-muted)]">{sm.summary}</p>
          <p className="text-xs text-[var(--color-text-faint)]">Impact: {sm.impact}</p>
        </div>
      )}
    </section>
  );
}
