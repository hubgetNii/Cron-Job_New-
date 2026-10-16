import { Card, CardContent } from '@/components/ui/card';
import { SeverityTag } from './verdict';
import type { Finding } from '@/lib/loadtest';

/** Findings in the same four parts for every reader: what it means, what we saw, what to do. */
export function FindingsList({ findings, empty = 'No findings.' }: { findings: Finding[]; empty?: string }) {
  if (findings.length === 0) return <p className="text-sm text-[var(--color-text-faint)]">{empty}</p>;
  return (
    <div className="space-y-2">
      {findings.map((f) => (
        <Card key={f.id} className={f.advisory ? 'opacity-80' : undefined}>
          <CardContent className="space-y-1.5 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <SeverityTag severity={f.severity} />
              <span className="font-medium">{f.title}</span>
              {f.advisory && <span className="text-xs text-[var(--color-text-faint)]">suggestion</span>}
              {f.owasp && (
                <span className="rounded border border-[var(--color-border)] px-1.5 text-[11px] text-[var(--color-text-faint)]">
                  {f.owasp.split(' ')[0]}
                </span>
              )}
            </div>
            <p>
              <span className="text-[var(--color-text-faint)]">What it means: </span>
              {f.impact}
            </p>
            <p>
              <span className="text-[var(--color-text-faint)]">What we saw: </span>
              {f.cause}
            </p>
            <p>
              <span className="text-[var(--color-text-faint)]">What to do: </span>
              {f.recommendation}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
