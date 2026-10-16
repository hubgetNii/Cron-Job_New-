import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { VerdictBadge } from '@/components/loadtest/verdict';
import { comparability, fmt, metricDiffs, type Change } from '@/lib/compare';
import { loadTestApi, reportRoute, useReportIndex, type LoadRunReport } from '@/lib/loadtest';

const COLOR: Record<Change, string> = {
  better: 'var(--color-up)',
  worse: 'var(--color-down)',
  same: 'var(--color-text-faint)',
};
const WORD: Record<Change, string> = { better: 'Better', worse: 'Worse', same: 'About the same' };
const when = (r: LoadRunReport): string => new Date(r.meta.generatedAt).toLocaleString();

export function LoadTestComparePage() {
  const [params, setParams] = useSearchParams();
  const { data: index = [] } = useReportIndex();
  const runs = useMemo(() => index.filter((r) => r.kind === 'load' && r.finishedAt), [index]);
  const a = params.get('a') ?? runs[1]?.id ?? '';
  const b = params.get('b') ?? runs[0]?.id ?? '';
  const set = (k: 'a' | 'b', v: string): void => setParams({ a, b, [k]: v });
  const [ra, rb] = useQueries({
    queries: [a, b].map((id) => ({
      queryKey: ['lt-report', 'load', id],
      queryFn: () => loadTestApi.runReport(id),
      enabled: id !== '',
    })),
  });
  const A = ra.data;
  const B = rb.data;
  const diffs = A && B ? metricDiffs(A, B) : [];
  const caveats = A && B ? comparability(A, B) : [];
  const worse = diffs.filter((d) => d.change === 'worse').length;
  const better = diffs.filter((d) => d.change === 'better').length;
  const sloIds = A && B ? [...new Set([...A.results.slo, ...B.results.slo].map((s) => s.id))] : [];
  const field =
    'h-9 min-w-64 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 text-sm';
  const option = (r: (typeof runs)[number]): string =>
    `${r.targetName} · ${r.title} · ${new Date(r.finishedAt!).toLocaleString()} · ${r.environmentLabel}`;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Compare two load runs</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Did a change make the service faster or slower? Pick a baseline and a newer run.
          Differences under 5% are treated as noise.{' '}
          <Link className="underline" to="/app/load-tests">
            Back to reports
          </Link>
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="text-xs">
          Baseline (older)
          <select className={`${field} block`} value={a} onChange={(e) => set('a', e.target.value)}>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {option(r)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          Compare with (newer)
          <select className={`${field} block`} value={b} onChange={(e) => set('b', e.target.value)}>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {option(r)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {runs.length < 2 && (
        <p className="text-sm text-[var(--color-text-faint)]">
          You need at least two finished load runs to compare.
        </p>
      )}
      {a === b && a !== '' && (
        <p className="text-sm text-[var(--color-degraded)]">Both sides are the same run.</p>
      )}
      {(ra.isLoading || rb.isLoading) && <Skeleton className="h-48" />}

      {A && B && (
        <>
          {caveats.length > 0 && (
            <div className="flex gap-2 rounded-md border border-[var(--color-degraded)]/50 bg-[var(--color-degraded)]/10 p-3 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--color-degraded)]" />
              <div>
                <b>These runs are not like for like — treat differences with care.</b>
                <ul className="list-disc pl-5">
                  {caveats.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <Card>
            <CardContent className="grid gap-4 p-4 sm:grid-cols-2">
              {[
                ['Baseline', A],
                ['Newer', B],
              ].map(([label, r]) => {
                const rep = r as LoadRunReport;
                return (
                  <div key={label as string} className="space-y-1">
                    <p className="text-xs uppercase tracking-wide text-[var(--color-text-faint)]">
                      {label as string}
                    </p>
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {rep.tested.scenario} <VerdictBadge value={rep.executive.verdict} />
                    </p>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      {rep.tested.shape} · {rep.meta.environment.label} · {when(rep)}
                    </p>
                    <Link className="text-xs underline" to={reportRoute('load', rep.meta.id)}>
                      Open full report
                    </Link>
                  </div>
                );
              })}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>
                {worse === 0 && better === 0
                  ? 'No material change'
                  : `${worse} worse · ${better} better`}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <THead>
                  <TR>
                    <TH>Measure</TH>
                    <TH>Baseline</TH>
                    <TH>Newer</TH>
                    <TH>Change</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {diffs.map((d) => (
                    <TR key={d.label}>
                      <TD className="text-sm">{d.label}</TD>
                      <TD className="tabular-nums">{fmt(d.a, d.unit)}</TD>
                      <TD className="tabular-nums">{fmt(d.b, d.unit)}</TD>
                      <TD className="tabular-nums text-sm" style={{ color: COLOR[d.change] }}>
                        {d.pct === null
                          ? d.delta === 0
                            ? '—'
                            : 'new'
                          : `${d.pct > 0 ? '+' : ''}${(d.pct * 100).toFixed(1)}%`}
                      </TD>
                      <TD>
                        <Badge
                          style={{
                            color: COLOR[d.change],
                            borderColor: `color-mix(in oklab, ${COLOR[d.change]} 45%, transparent)`,
                          }}
                        >
                          {WORD[d.change]}
                        </Badge>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Pass/fail checks</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <THead>
                  <TR>
                    <TH>Check</TH>
                    <TH>Target</TH>
                    <TH>Baseline</TH>
                    <TH>Newer</TH>
                  </TR>
                </THead>
                <TBody>
                  {sloIds.map((id) => {
                    const x = A.results.slo.find((s) => s.id === id);
                    const y = B.results.slo.find((s) => s.id === id);
                    const cell = (s: typeof x) =>
                      s ? (
                        <span>
                          <b>{s.status}</b>{' '}
                          <span className="text-xs text-[var(--color-text-muted)]">{s.actual}</span>
                        </span>
                      ) : (
                        '—'
                      );
                    return (
                      <TR key={id}>
                        <TD className="text-sm">{(x ?? y)!.name}</TD>
                        <TD className="text-xs text-[var(--color-text-muted)]">
                          {(y ?? x)!.target}
                        </TD>
                        <TD>{cell(x)}</TD>
                        <TD
                          style={x && y && x.status !== y.status ? { fontWeight: 600 } : undefined}
                        >
                          {cell(y)}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
