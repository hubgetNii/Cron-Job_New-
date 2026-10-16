import { lazy, Suspense, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, FlaskConical } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { StatTile } from '@/components/stat-tile';
import { EnvTag, VerdictBadge } from '@/components/loadtest/verdict';
import { verdictColor } from '@/lib/verdict-states';
import { FindingsList } from '@/components/loadtest/findings';
import { ReadinessPanel } from '@/components/loadtest/readiness-panel';
import { ReportActions } from '@/components/loadtest/report-actions';
import {
  loadTestApi,
  type Decision,
  type LoadRunReport,
  type ReadinessReport,
  type ReportCheck,
  type ReportMeta,
  type SuiteDigest,
  type SuiteReport,
  type TimelineEntry,
} from '@/lib/loadtest';
import { cn } from '@/lib/utils';

const RunChart = lazy(() => import('@/components/loadtest/run-chart'));

const DECISION: Record<Decision, string> = {
  GO: 'Go — the service met every objective at this volume.',
  GO_WITH_CONDITIONS: 'Go with conditions — it met the objectives, but with thin margins to address.',
  NO_GO: 'No-go — the service missed an objective at this volume.',
  RE_RUN: 'Re-run — this run does not prove anything either way.',
};

type View = 'summary' | 'technical';

function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const opts: { v: View; label: string; hint: string }[] = [
    { v: 'summary', label: 'Summary', hint: 'For everyone' },
    { v: 'technical', label: 'Technical', hint: 'For engineers' },
  ];
  return (
    <div className="inline-flex rounded-md border border-[var(--color-border)] p-0.5" role="tablist" aria-label="Report view">
      {opts.map((o) => (
        <button
          key={o.v}
          role="tab"
          aria-selected={view === o.v}
          onClick={() => onChange(o.v)}
          className={cn(
            'rounded px-3 py-1 text-sm transition-colors',
            view === o.v ? 'bg-[var(--color-surface-2)] font-medium text-[var(--color-text)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
          )}
        >
          {o.label} <span className="hidden text-xs text-[var(--color-text-faint)] sm:inline">· {o.hint}</span>
        </button>
      ))}
    </div>
  );
}

function Header({ meta, verdict }: { meta: ReportMeta; verdict: string }) {
  return (
    <div className="space-y-2">
      <Link to="/app/load-tests" className="inline-flex items-center gap-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
        <ArrowLeft className="size-4" /> All load-test reports
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{meta.title}</h1>
        <VerdictBadge value={verdict} />
        <EnvTag label={meta.environment.label} isReal={meta.environment.isReal} />
      </div>
      <p className="text-xs text-[var(--color-text-faint)]">
        {meta.target.name} · {meta.target.host} · generated {new Date(meta.generatedAt).toLocaleString()}
        {meta.requestedBy && ` · requested by ${meta.requestedBy}`}
      </p>
    </div>
  );
}

function SimulatorBanner({ meta }: { meta: ReportMeta }) {
  if (meta.environment.isReal || meta.kind === 'readiness') return null;
  return (
    <div className="flex items-start gap-2 rounded-md border border-[var(--color-degraded)]/50 bg-[var(--color-degraded)]/10 p-3 text-sm">
      <FlaskConical className="mt-0.5 size-4 shrink-0 text-[var(--color-degraded)]" />
      <p>
        <b>Simulator evidence.</b> This run exercised our own mock of the iSmartPay API. It shows the tests work; it is not evidence about the real
        service, and it can never make a service “ready”.
      </p>
    </div>
  );
}

function Hero({ verdict, headline, summary, decision }: { verdict: string; headline: string; summary: string; decision?: Decision }) {
  return (
    <Card style={{ borderLeft: `4px solid ${verdictColor(verdict)}` }}>
      <CardContent className="space-y-2 p-4">
        <p className="text-base font-semibold leading-snug">{headline}</p>
        {decision && <p className="text-sm font-medium">{DECISION[decision]}</p>}
        <p className="text-sm text-[var(--color-text-muted)]">{summary}</p>
      </CardContent>
    </Card>
  );
}

function Tiles({ items }: { items: { label: string; value: string; caption: string }[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {items.map((k) => (
        <StatTile key={k.label} label={k.label} value={k.value} hint={k.caption} />
      ))}
    </div>
  );
}

function DigestCard({ title, digest }: { title: string; digest: SuiteDigest | null }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-3">
        <CardTitle>{title}</CardTitle>
        {digest && <VerdictBadge value={digest.verdict} />}
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {!digest ? (
          <p className="text-[var(--color-text-faint)]">No run yet — this area is unverified.</p>
        ) : (
          <>
            <p>{digest.headline}</p>
            <p className="text-xs text-[var(--color-text-faint)]">
              {digest.environmentLabel} · {new Date(digest.finishedAt).toLocaleDateString()}
            </p>
            {digest.failedChecks.map((c) => (
              <p key={c.id} className="rounded border border-[var(--color-down)]/40 p-2">
                <b>{c.title}</b> — {c.why}
              </p>
            ))}
            <Link className="inline-block text-xs underline" to={`/app/load-tests/${digest.suite}/${digest.runId}`}>
              Open the full {digest.suite === 'security' ? 'security' : 'money-safety'} report
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function EventLog({ rows }: { rows: TimelineEntry[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Event log</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <THead>
            <TR>
              <TH>When</TH>
              <TH>Event</TH>
              <TH>Detail</TH>
              <TH>By</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((e, i) => (
              <TR key={`${e.at}-${i}`}>
                <TD className="whitespace-nowrap font-mono text-xs">{new Date(e.at).toLocaleTimeString()}</TD>
                <TD className="text-sm font-medium">{e.event}</TD>
                <TD className="text-sm text-[var(--color-text-muted)]">{e.detail}</TD>
                <TD className="text-xs text-[var(--color-text-faint)]">{e.actor ?? ''}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Glossary({ items }: { items: Record<string, string> }) {
  return (
    <details className="rounded-[var(--radius)] border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4">
      <summary className="cursor-pointer text-sm font-medium">Glossary — what these terms mean</summary>
      <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
        {Object.entries(items).map(([t, m]) => (
          <div key={t}>
            <dt className="font-medium">{t}</dt>
            <dd className="text-[var(--color-text-muted)]">{m}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/* ── Load run ──────────────────────────────────────────────────────────── */

function LoadRunView({ r, view }: { r: LoadRunReport; view: View }) {
  const ms = (n: number): string => `${n} ms`;
  if (view === 'summary') {
    return (
      <div className="space-y-4">
        <SimulatorBanner meta={r.meta} />
        <Hero verdict={r.executive.verdict} headline={r.executive.headline} summary={r.executive.summary} decision={r.executive.decision} />
        <Tiles items={r.executive.keyNumbers} />
        {r.executive.topRisks.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-sm font-medium">Top risks</h2>
            <FindingsList findings={r.executive.topRisks} />
          </div>
        )}
        <Card>
          <CardHeader>
            <CardTitle>What was tested</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            <p>{r.tested.scenario}</p>
            <p className="text-[var(--color-text-muted)]">{r.tested.shape}</p>
            <p className="text-xs text-[var(--color-text-faint)]">
              Plan “{r.tested.planName}”{r.tested.dataSet && ` · data set “${r.tested.dataSet.name}” (${r.tested.dataSet.records} records)`}
              {r.tested.window.seconds != null && ` · ran for ${r.tested.window.seconds} s`}
            </p>
            {r.tested.flags.length > 0 && <p className="flex flex-wrap gap-1">{r.tested.flags.map((f) => <span key={f} className="rounded border border-[var(--color-border)] px-1.5 text-xs">{f}</span>)}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Did it meet its objectives?</CardTitle>
            <p className="text-sm">{r.results.verdictReason}</p>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <THead>
                <TR>
                  <TH>Objective</TH>
                  <TH>Target</TH>
                  <TH>Actual</TH>
                  <TH>Result</TH>
                  <TH>In plain words</TH>
                </TR>
              </THead>
              <TBody>
                {r.results.slo.map((c) => (
                  <TR key={c.id}>
                    <TD className="font-medium">{c.name}</TD>
                    <TD className="text-xs text-[var(--color-text-faint)]">{c.target}</TD>
                    <TD className="text-sm tabular-nums">{c.actual}</TD>
                    <TD>
                      <VerdictBadge value={c.status} />
                    </TD>
                    <TD className="max-w-md text-sm text-[var(--color-text-muted)]">{c.why}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
        <div className="grid gap-4 lg:grid-cols-2">
          <DigestCard title="Money safety (latest correctness run)" digest={r.moneySafety} />
          <DigestCard title="Security (latest OWASP run)" digest={r.security} />
        </div>
        <ReadinessPanel readiness={r.readiness} />
        <div className="space-y-2">
          <h2 className="text-sm font-medium">All findings</h2>
          <FindingsList findings={r.findings} />
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Speed and volume over time</CardTitle>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<Skeleton className="h-64" />}>
            <RunChart data={r.results.series} />
          </Suspense>
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Latency</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <TR>{['Average', 'P50', 'P90', 'P95', 'P99', 'Slowest'].map((h) => <TH key={h}>{h}</TH>)}</TR>
              </THead>
              <TBody>
                <TR>
                  {[r.results.latency.avgMs, r.results.latency.p50Ms, r.results.latency.p90Ms, r.results.latency.p95Ms, r.results.latency.p99Ms, r.results.latency.maxMs].map((n, i) => (
                    <TD key={i} className="tabular-nums">{ms(n)}</TD>
                  ))}
                </TR>
              </TBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Throughput</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <TR>{['Requests', 'Planned', 'Avg/s', 'Peak/s', 'Clean max/s'].map((h) => <TH key={h}>{h}</TH>)}</TR>
              </THead>
              <TBody>
                <TR>
                  {[r.results.throughput.totalRequests, r.results.throughput.expectedRequests, r.results.throughput.achievedAvgRps, r.results.throughput.peakRps, r.results.throughput.maxSustainedRps].map((n, i) => (
                    <TD key={i} className="tabular-nums">{n.toLocaleString()}</TD>
                  ))}
                </TR>
              </TBody>
            </Table>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Errors and status codes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>{r.results.errors.plain}</p>
          <p className="flex flex-wrap gap-2">
            {Object.entries(r.results.errors.statusCounts).map(([s, c]) => (
              <span key={s} className="rounded border border-[var(--color-border)] px-2 py-0.5 font-mono text-xs">
                {s}: {c.toLocaleString()}
              </span>
            ))}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>History of this plan</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <THead>
              <TR>
                <TH>Finished</TH>
                <TH>Verdict</TH>
                <TH>P95</TH>
                <TH>Failure rate</TH>
                <TH>Avg/s</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {r.trend.map((t) => (
                <TR key={t.runId} className={t.current ? 'bg-[var(--color-surface-2)]/60' : undefined}>
                  <TD className="text-xs">{new Date(t.finishedAt).toLocaleString()}</TD>
                  <TD><VerdictBadge value={t.verdict} /></TD>
                  <TD className="tabular-nums">{ms(t.p95Ms)}</TD>
                  <TD className="tabular-nums">{(t.errorRate * 100).toFixed(2)}%</TD>
                  <TD className="tabular-nums">{t.achievedRps}</TD>
                  <TD className="text-xs text-[var(--color-text-faint)]">{t.current ? '← this run' : ''}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
      <EventLog rows={r.logs.timeline} />
      <Card>
        <CardHeader>
          <CardTitle>Run configuration and how to reproduce</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <pre className="overflow-x-auto rounded bg-[var(--color-surface-2)] p-3 text-xs">{JSON.stringify(r.logs.runConfig, null, 2)}</pre>
          <pre className="overflow-x-auto rounded bg-[var(--color-surface-2)] p-3 text-xs">{r.logs.reproduce.join('\n')}</pre>
          <p className="text-xs text-[var(--color-text-faint)]">
            Load generator: {r.logs.generator.k6Version ?? 'k6'} · {r.logs.generator.saturated ? 'SATURATED' : 'kept up'} · dropped iterations {r.logs.generator.droppedIterations}
            {r.logs.error && ` · error: ${r.logs.error}`}
          </p>
        </CardContent>
      </Card>
      <Glossary items={r.glossary} />
    </div>
  );
}

/* ── Suites (money correctness / security) ─────────────────────────────── */

function CheckRow({ c, security }: { c: ReportCheck; security: boolean }) {
  return (
    <details className="rounded-[var(--radius)] border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
        <VerdictBadge value={c.status} />
        <span className="font-medium">{c.title}</span>
        {c.warnings > 0 && <span className="text-xs text-[var(--color-degraded)]">{c.warnings} suggestion(s)</span>}
        {security && c.owasp && <span className="ml-auto rounded border border-[var(--color-border)] px-1.5 text-[11px] text-[var(--color-text-faint)]">{c.owasp.split(' ')[0]}</span>}
      </summary>
      <p className="mt-2 text-sm text-[var(--color-text-muted)]">
        <b>Why it matters:</b> {c.whyItMatters}
      </p>
      {c.note && <p className="mt-1 text-sm text-[var(--color-text-faint)]">{c.note}</p>}
      <ul className="mt-2 space-y-1 text-sm">
        {c.assertions.map((a, i) => (
          <li key={i} className="flex gap-2">
            <span style={{ color: a.pass ? 'var(--color-up)' : a.advisory ? 'var(--color-degraded)' : 'var(--color-down)' }}>{a.pass ? '✓' : a.advisory ? '!' : '✗'}</span>
            <span>
              {a.name}
              {a.detail && <span className="text-[var(--color-text-faint)]"> — {a.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function SuiteView({ r, view }: { r: SuiteReport; view: View }) {
  const security = r.suite === 'security';
  if (view === 'summary') {
    return (
      <div className="space-y-4">
        <SimulatorBanner meta={r.meta} />
        <Hero verdict={r.executive.verdict} headline={r.executive.headline} summary={r.executive.summary} />
        <Tiles items={r.executive.keyNumbers} />
        {r.executive.topRisks.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-sm font-medium">Top risks</h2>
            <FindingsList findings={r.executive.topRisks} />
          </div>
        )}
        {r.coverageGaps.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>What could not be checked here</CardTitle>
              <p className="text-xs text-[var(--color-text-faint)]">Listed so the gap is visible, not hidden.</p>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {r.coverageGaps.map((g) => (
                <p key={g.id}>
                  <b>{g.title}</b> — <span className="text-[var(--color-text-muted)]">{g.reason}</span>
                </p>
              ))}
            </CardContent>
          </Card>
        )}
        <div className="space-y-2">
          <h2 className="text-sm font-medium">Every check</h2>
          {r.checks.map((c) => <CheckRow key={c.id} c={c} security={security} />)}
        </div>
        <ReadinessPanel readiness={r.readiness} />
        <div className="space-y-2">
          <h2 className="text-sm font-medium">All findings</h2>
          <FindingsList findings={r.findings} />
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Evidence — {r.evidence.length} API calls (ids and statuses only; no bodies or secrets)</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <THead>
              <TR>
                <TH>Check</TH>
                <TH>Call</TH>
                <TH>Status</TH>
                <TH>ms</TH>
                <TH>Request-Id</TH>
                <TH>Reference</TH>
              </TR>
            </THead>
            <TBody>
              {r.evidence.slice(0, 300).map((e, i) => (
                <TR key={i}>
                  <TD className="font-mono text-[11px]">{e.checkId}</TD>
                  <TD className="font-mono text-xs"><span className="text-[var(--color-text-faint)]">{e.method}</span> {e.path}</TD>
                  <TD className="tabular-nums" style={{ color: e.status >= 500 || e.status === 0 ? 'var(--color-down)' : undefined }}>{e.status}</TD>
                  <TD className="tabular-nums text-xs">{e.ms}</TD>
                  <TD className="font-mono text-[11px] text-[var(--color-text-faint)]">{e.requestId ?? ''}</TD>
                  <TD className="font-mono text-[11px]">{e.reference ?? ''}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          {r.evidence.length > 300 && <p className="p-3 text-xs text-[var(--color-text-faint)]">First 300 shown. The Excel export contains all {r.evidence.length}.</p>}
        </CardContent>
      </Card>
      <EventLog rows={r.logs.timeline} />
      <Glossary items={r.glossary} />
    </div>
  );
}

function ReadinessView({ r }: { r: ReadinessReport }) {
  return (
    <div className="space-y-4">
      <Hero verdict={r.readiness.status} headline={r.headline} summary={r.readiness.reasons[0] ?? 'Every gate has passing evidence.'} />
      <ReadinessPanel readiness={r.readiness} />
      <Card>
        <CardHeader>
          <CardTitle>Evidence used</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <THead>
              <TR><TH>Area</TH><TH>Latest result</TH><TH>Environment</TH><TH>Date</TH></TR>
            </THead>
            <TBody>
              {r.evidence.load.map((l) => (
                <TR key={l.id}><TD>Load — {l.profile}</TD><TD><VerdictBadge value={l.verdict} /></TD><TD className="text-sm">{l.environmentLabel}</TD><TD className="text-xs">{new Date(l.finishedAt).toLocaleDateString()}</TD></TR>
              ))}
              {[r.evidence.correctness, r.evidence.security].filter(Boolean).map((d) => (
                <TR key={d!.runId}><TD>{d!.suite === 'security' ? 'Security' : 'Money correctness'}</TD><TD><VerdictBadge value={d!.verdict} /></TD><TD className="text-sm">{d!.environmentLabel}</TD><TD className="text-xs">{new Date(d!.finishedAt).toLocaleDateString()}</TD></TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
      <div className="space-y-2">
        <h2 className="text-sm font-medium">Open findings</h2>
        <FindingsList findings={r.findings} />
      </div>
      <Glossary items={r.glossary} />
    </div>
  );
}

/* ── Route ─────────────────────────────────────────────────────────────── */

export function LoadTestReportPage() {
  const { kind = 'run', id = '' } = useParams();
  const [view, setView] = useState<View>('summary');
  const q = useQuery({
    queryKey: ['lt-report', kind, id],
    queryFn: (): Promise<LoadRunReport | SuiteReport | ReadinessReport> =>
      kind === 'run' ? loadTestApi.runReport(id) : kind === 'readiness' ? loadTestApi.readiness(id) : loadTestApi.suiteReport(kind === 'security' ? 'security' : 'correctness', id),
  });

  if (q.isLoading) return <Skeleton className="h-96" />;
  if (q.error || !q.data) {
    return (
      <div className="space-y-3">
        <Link to="/app/load-tests" className="text-sm underline">← Back to reports</Link>
        <p className="text-sm text-[var(--color-down)]">{q.error instanceof Error ? q.error.message : 'Report not found.'}</p>
      </div>
    );
  }
  const r = q.data;
  const verdict = 'executive' in r ? r.executive.verdict : r.readiness.status;
  return (
    <div className="space-y-4">
      <Header meta={r.meta} verdict={verdict} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        {r.meta.kind !== 'readiness' ? <ViewToggle view={view} onChange={setView} /> : <span />}
        <ReportActions kind={r.meta.kind} id={r.meta.id} />
      </div>
      {r.meta.kind === 'load' && <LoadRunView r={r as LoadRunReport} view={view} />}
      {(r.meta.kind === 'correctness' || r.meta.kind === 'security') && <SuiteView r={r as SuiteReport} view={view} />}
      {r.meta.kind === 'readiness' && <ReadinessView r={r as ReadinessReport} />}
    </div>
  );
}
