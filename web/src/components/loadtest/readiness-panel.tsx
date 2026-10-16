import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { VerdictBadge } from './verdict';
import type { Readiness } from '@/lib/loadtest';

const BASIS: Record<Readiness['basis'], string> = {
  simulator: 'Simulator only — not the real service',
  sandbox: 'iSmartPay sandbox',
  production: 'Production',
  mixed: 'Mixed (some simulator evidence)',
  none: 'No evidence yet',
};

/** Gate-based readiness: every gate, why, and exactly what to do next. */
export function ReadinessPanel({ readiness }: { readiness: Readiness }) {
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center gap-3">
        <CardTitle>Production readiness</CardTitle>
        <VerdictBadge value={readiness.status} />
        <span className="text-xs text-[var(--color-text-faint)]">
          {BASIS[readiness.basis]}
          {readiness.score != null && ` · provisional score ${readiness.score}/100`}
        </span>
      </CardHeader>
      <CardContent className="space-y-4">
        <Table>
          <THead>
            <TR>
              <TH>Gate</TH>
              <TH>Required</TH>
              <TH>Status</TH>
              <TH>Detail</TH>
            </TR>
          </THead>
          <TBody>
            {readiness.gates.map((g) => (
              <TR key={g.id}>
                <TD className="font-medium">{g.name}</TD>
                <TD className="text-xs text-[var(--color-text-faint)]">{g.required ? 'yes' : 'no'}</TD>
                <TD>
                  <VerdictBadge value={g.status} />
                </TD>
                <TD className="text-sm text-[var(--color-text-muted)]">{g.detail}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
        {readiness.nextSteps.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-text-faint)]">Next steps</p>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              {readiness.nextSteps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </div>
        )}
        <p className="text-xs text-[var(--color-text-faint)]">
          Gates decide readiness, not the score: a payment service with a duplicate-charge bug is not “87% ready”.
        </p>
      </CardContent>
    </Card>
  );
}
