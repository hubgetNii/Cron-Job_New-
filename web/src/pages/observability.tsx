import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, Eye, EyeOff, Search } from 'lucide-react';
import {
  useHealthCheckRun,
  useHealthCheckRuns,
  useLatency,
  useLatencyAll,
  useTrace,
  useTraces,
} from '@/lib/queries';
import { api, downloadWithAuth, traceQuery } from '@/lib/api';
import { authStore } from '@/lib/auth';
import { Card } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { HealthBadge } from '@/components/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import type {
  LatencyAssessment,
  RawTrace,
  SystemHealthLevel,
  TraceRow,
  TraceSearchParams,
} from '@/lib/types';

const ASSESS_COLOR: Record<LatencyAssessment, string> = {
  NORMAL: 'var(--color-up)',
  ELEVATED: 'var(--color-series-1)',
  HIGH: 'var(--color-degraded)',
  CRITICAL: 'var(--color-down)',
  NO_DATA: 'var(--color-unknown)',
};

function AssessPill({ a }: { a: LatencyAssessment }) {
  return (
    <span
      className="rounded-full border px-2 py-0.5 text-xs font-semibold"
      style={{ color: ASSESS_COLOR[a], borderColor: 'var(--color-border)' }}
    >
      {a === 'NO_DATA' ? 'no data' : a}
    </span>
  );
}

const ms = (v: number | null): string => (v == null ? '—' : `${v.toLocaleString()} ms`);

function LatencyDetail({ apiId }: { apiId: string }) {
  const { data: s, isLoading } = useLatency(apiId);
  if (isLoading || !s) return <Skeleton className="h-80 w-full" />;
  const dev = s.deviationPercent;
  return (
    <div className="space-y-4 overflow-y-auto">
      <div>
        <SheetTitle>{s.targetName}</SheetTitle>
        <SheetDescription>
          {s.endpointClass} · last {s.window.minutes} min · {s.window.samples} samples
        </SheetDescription>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <AssessPill a={s.assessment} />
        {dev != null && (
          <span
            className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs tabular-nums"
            style={{ color: dev > 0 ? 'var(--color-down)' : 'var(--color-up)' }}
          >
            {dev > 0 ? '+' : ''}
            {dev}% vs {s.baseline.days}-day baseline
          </span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-3 text-sm">
        {(
          [
            ['Current', s.current],
            ['Average', s.avg],
            ['Baseline', s.baseline.avgMs],
            ['Min', s.min],
            ['Max', s.max],
            ['P50', s.p50],
            ['P90', s.p90],
            ['P95', s.p95],
            ['P99', s.p99],
          ] as const
        ).map(([label, val]) => (
          <div key={label} className="rounded-md border border-[var(--color-border)] p-2">
            <div className="text-xs text-[var(--color-text-faint)]">{label}</div>
            <div className="tabular-nums">{ms(val)}</div>
          </div>
        ))}
      </div>
      <div className="rounded-md border border-[var(--color-border)] p-3 text-sm">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs uppercase tracking-wide text-[var(--color-text-faint)]">
            Thresholds
          </span>
          <span className="text-xs text-[var(--color-text-faint)]">{s.thresholds.source}</span>
        </div>
        <div className="flex gap-4 tabular-nums">
          <span style={{ color: 'var(--color-up)' }}>normal &lt; {ms(s.thresholds.normalMs)}</span>
          <span style={{ color: 'var(--color-degraded)' }}>
            high ≥ {ms(s.thresholds.degradedMs)}
          </span>
          <span style={{ color: 'var(--color-down)' }}>
            critical ≥ {ms(s.thresholds.criticalMs)}
          </span>
        </div>
      </div>
    </div>
  );
}

const LEVEL_COLOR: Record<SystemHealthLevel, string> = {
  HEALTHY: 'var(--color-up)',
  DEGRADED: 'var(--color-degraded)',
  CRITICAL: 'var(--color-down)',
};

function LevelPill({ level }: { level: SystemHealthLevel }) {
  return (
    <span
      className="rounded-full border px-2 py-0.5 text-xs font-semibold"
      style={{ color: LEVEL_COLOR[level], borderColor: 'var(--color-border)' }}
    >
      {level}
    </span>
  );
}

function RunDetail({ hcId }: { hcId: string }) {
  const { data: run, isLoading } = useHealthCheckRun(hcId);
  if (isLoading || !run) return <Skeleton className="h-96 w-full" />;
  return (
    <div className="space-y-4 overflow-y-auto">
      <div>
        <SheetTitle className="font-mono text-sm">{run.hcId}</SheetTitle>
        <SheetDescription>
          {new Date(run.windowStart).toLocaleTimeString()} –{' '}
          {new Date(run.windowEnd).toLocaleTimeString()}
          {run.environment ? ` · ${run.environment}` : ''}
        </SheetDescription>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <LevelPill level={run.overallStatus} />
        <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 tabular-nums">
          {run.servicesTested} tested
        </span>
        <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 tabular-nums text-[var(--color-up)]">
          {run.healthy} healthy
        </span>
        <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 tabular-nums text-[var(--color-degraded)]">
          {run.degraded} degraded
        </span>
        <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 tabular-nums text-[var(--color-down)]">
          {run.failed} failed
        </span>
        {run.durationMs != null && (
          <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 tabular-nums">
            {(run.durationMs / 1000).toFixed(2)}s check time · {run.checksTotal} checks
          </span>
        )}
      </div>
      <div className="overflow-x-auto rounded-md border border-[var(--color-border)]">
        <table className="w-full text-xs">
          <tbody>
            {run.services.map((s) => (
              <tr key={s.checkId} className="border-b border-[var(--color-border)] last:border-0">
                <td className="px-2 py-1.5">
                  <HealthBadge status={s.status} />
                </td>
                <td className="px-2 py-1.5 font-medium">
                  {s.targetName}
                  {s.isMoneyMoving && (
                    <span className="ml-1 text-[var(--color-degraded)]">·$</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right font-mono tabular-nums text-[var(--color-text-muted)]">
                  {s.httpStatus ?? '—'}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {s.responseTimeMs ?? '—'} ms
                </td>
                <td className="px-2 py-1.5 text-[var(--color-text-muted)]">{s.errorType ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const RANGES: Record<string, number> = {
  '30m': 30 * 60_000,
  '2h': 2 * 3_600_000,
  '24h': 24 * 3_600_000,
  '7d': 7 * 86_400_000,
};

const STATUS_CLASSES = ['', '2xx', '4xx', '5xx'] as const;
const HEALTH = ['', 'UP', 'DEGRADED', 'DOWN', 'UNKNOWN'] as const;

function statusColor(code: number | null): string {
  if (code == null) return 'var(--color-unknown)';
  if (code >= 500) return 'var(--color-down)';
  if (code >= 400) return 'var(--color-degraded)';
  if (code >= 200 && code < 300) return 'var(--color-up)';
  return 'var(--color-text-muted)';
}

function pretty(body: string | null): string {
  if (!body) return '';
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function HeaderTable({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers);
  if (entries.length === 0) return <p className="text-xs text-[var(--color-text-faint)]">none</p>;
  return (
    <div className="overflow-x-auto rounded-md border border-[var(--color-border)]">
      <table className="w-full text-xs">
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k} className="border-b border-[var(--color-border)] last:border-0">
              <td className="w-40 px-2 py-1 font-mono text-[var(--color-text-muted)]">{k}</td>
              <td className="px-2 py-1 font-mono break-all">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Body({ label, body }: { label: string; body: string | null }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-[var(--color-text-faint)]">{label}</p>
      {body ? (
        <pre className="max-h-72 overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-xs">
          {pretty(body)}
        </pre>
      ) : (
        <p className="text-xs text-[var(--color-text-faint)]">empty</p>
      )}
    </div>
  );
}

function TraceDetail({ checkId }: { checkId: string }) {
  const { data: t, isLoading } = useTrace(checkId);
  const isAdmin = authStore.user()?.roles.includes('ADMIN') ?? false;
  const [raw, setRaw] = useState<RawTrace | null>(null);
  const [revealing, setRevealing] = useState(false);

  if (isLoading || !t) return <Skeleton className="h-96 w-full" />;

  async function reveal(): Promise<void> {
    setRevealing(true);
    try {
      setRaw(await api.revealTrace(checkId));
    } finally {
      setRevealing(false);
    }
  }

  return (
    <div className="space-y-5 overflow-y-auto">
      <div>
        <SheetTitle className="flex items-center gap-2">
          <span className="font-mono text-sm">{t.requestMethod}</span>
          <span className="font-mono text-sm break-all">{t.requestUrlMasked}</span>
        </SheetTitle>
        <SheetDescription>
          {t.targetName ?? t.apiId} · {new Date(t.checkedAt).toLocaleString()}
        </SheetDescription>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <HealthBadge status={t.healthStatus} />
        <span
          className="rounded-full border px-2 py-0.5 font-medium tabular-nums"
          style={{ color: statusColor(t.responseStatus), borderColor: 'var(--color-border)' }}
        >
          HTTP {t.responseStatus ?? '—'}
        </span>
        <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 tabular-nums">
          {t.responseTimeMs ?? '—'} ms
        </span>
        <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 tabular-nums">
          {t.responseBytes ?? 0} B
        </span>
        {t.failureType && (
          <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[var(--color-down)]">
            {t.failureType}
          </span>
        )}
        {t.attempts > 1 && (
          <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5">
            {t.attempts} attempts
          </span>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <div>
          <dt className="text-[var(--color-text-faint)]">Request ID</dt>
          <dd className="font-mono">{t.requestId}</dd>
        </div>
        <div>
          <dt className="text-[var(--color-text-faint)]">Correlation ID</dt>
          <dd className="font-mono break-all">{t.correlationId}</dd>
        </div>
        <div>
          <dt className="text-[var(--color-text-faint)]">Check ID</dt>
          <dd className="font-mono break-all">{t.checkId}</dd>
        </div>
        <div>
          <dt className="text-[var(--color-text-faint)]">Content-Type</dt>
          <dd>{t.responseContentType ?? '—'}</dd>
        </div>
      </dl>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Request</h3>
        <HeaderTable headers={t.requestHeadersMasked} />
        <Body label="Body (masked)" body={t.requestBodyMasked} />
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Response</h3>
        <HeaderTable headers={t.responseHeadersMasked} />
        <Body label="Body (masked)" body={t.responseBodyMasked} />
      </section>

      {t.hasRaw && (
        <section className="space-y-2 rounded-md border border-[var(--color-border)] p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Unmasked (raw)</h3>
            {isAdmin ? (
              raw ? (
                <Button size="sm" variant="ghost" onClick={() => setRaw(null)}>
                  <EyeOff className="mr-1 size-3.5" /> Hide
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled={revealing} onClick={() => void reveal()}>
                  <Eye className="mr-1 size-3.5" /> {revealing ? 'Revealing…' : 'Reveal (audited)'}
                </Button>
              )
            ) : (
              <span className="text-xs text-[var(--color-text-faint)]">ADMIN only</span>
            )}
          </div>
          {isAdmin && !raw && (
            <p className="text-xs text-[var(--color-text-faint)]">
              Every reveal is written to the audit log with your identity.
            </p>
          )}
          {raw && (
            <div className="space-y-2">
              <p className="text-xs font-mono break-all">{raw.requestUrl}</p>
              <HeaderTable headers={raw.requestHeaders} />
              <Body label="Request body" body={raw.requestBody} />
              <HeaderTable headers={raw.responseHeaders} />
              <Body label="Response body" body={raw.responseBody} />
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export function ObservabilityPage() {
  const [params, setParams] = useSearchParams();
  const openCheckId = params.get('check');
  const openHcId = params.get('hc');
  const openLatId = params.get('lat');
  const runs = useHealthCheckRuns(20);
  const latency = useLatencyAll();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [statusClass, setStatusClass] = useState(params.get('statusClass') ?? '');
  const [health, setHealth] = useState(params.get('healthStatus') ?? '');
  const [range, setRange] = useState('2h');
  const [page, setPage] = useState(0);

  const pageSize = 50;
  // Round the window start to the minute so the query key is stable between renders.
  const nowMinute = Math.floor(Date.now() / 60_000) * 60_000;
  const search: TraceSearchParams = useMemo(() => {
    const from = new Date(nowMinute - (RANGES[range] ?? RANGES['2h']!)).toISOString();
    return {
      ...(q ? { q } : {}),
      ...(statusClass ? { statusClass: statusClass as TraceSearchParams['statusClass'] } : {}),
      ...(health ? { healthStatus: health as TraceSearchParams['healthStatus'] } : {}),
      from,
      limit: pageSize,
      offset: page * pageSize,
    };
  }, [q, statusClass, health, range, page, nowMinute]);

  const { data, isLoading, isFetching } = useTraces(search);
  const rows: TraceRow[] = data?.rows ?? [];
  const total = data?.total ?? 0;

  const setOpen = (checkId: string | null): void => {
    const next = new URLSearchParams(params);
    if (checkId) next.set('check', checkId);
    else next.delete('check');
    setParams(next);
  };

  const setOpenHc = (hcId: string | null): void => {
    const next = new URLSearchParams(params);
    if (hcId) next.set('hc', hcId);
    else next.delete('hc');
    setParams(next);
  };

  const setOpenLat = (apiId: string | null): void => {
    const next = new URLSearchParams(params);
    if (apiId) next.set('lat', apiId);
    else next.delete('lat');
    setParams(next);
  };

  async function exportCsv(): Promise<void> {
    const { limit: _l, offset: _o, ...rest } = search;
    await downloadWithAuth(
      `/observability/traces/export${traceQuery(rest as Record<string, unknown>)}`,
      `observability-traces-${new Date().toISOString().slice(0, 10)}.csv`,
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Observability</h1>
        <span className="text-sm text-[var(--color-text-faint)]">
          {total.toLocaleString()} traces{isFetching ? ' · refreshing…' : ''}
        </span>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => void exportCsv()}>
          <Download className="mr-1 size-4" /> Download CSV
        </Button>
      </div>

      <Card>
        <div className="border-b border-[var(--color-border)] px-4 py-2.5 text-sm font-medium">
          Health check runs
          <span className="ml-2 text-xs font-normal text-[var(--color-text-faint)]">
            every {'~'}5 min · click for the per-service breakdown
          </span>
        </div>
        <Table>
          <THead>
            <TR>
              <TH>Health Check ID</TH>
              <TH>Window end</TH>
              <TH>Env</TH>
              <TH>Status</TH>
              <TH className="text-right">Tested</TH>
              <TH className="text-right">Healthy</TH>
              <TH className="text-right">Degraded</TH>
              <TH className="text-right">Failed</TH>
              <TH className="text-right">Check time</TH>
            </TR>
          </THead>
          <TBody>
            {(runs.data ?? []).map((r) => (
              <TR key={r.id} className="cursor-pointer" onClick={() => setOpenHc(r.hcId)}>
                <TD className="font-mono text-xs">{r.hcId}</TD>
                <TD className="whitespace-nowrap text-xs text-[var(--color-text-faint)]">
                  {new Date(r.windowEnd).toLocaleString()}
                </TD>
                <TD className="text-xs text-[var(--color-text-muted)]">{r.environment ?? 'mixed'}</TD>
                <TD>
                  <LevelPill level={r.overallStatus} />
                </TD>
                <TD className="text-right tabular-nums">{r.servicesTested}</TD>
                <TD className="text-right tabular-nums text-[var(--color-up)]">{r.healthy}</TD>
                <TD className="text-right tabular-nums text-[var(--color-degraded)]">
                  {r.degraded}
                </TD>
                <TD className="text-right tabular-nums text-[var(--color-down)]">{r.failed}</TD>
                <TD className="text-right tabular-nums text-[var(--color-text-faint)]">
                  {r.durationMs != null ? `${(r.durationMs / 1000).toFixed(2)}s` : '—'}
                </TD>
              </TR>
            ))}
            {!runs.isLoading && (runs.data ?? []).length === 0 && (
              <TR>
                <TD colSpan={9} className="py-8 text-center text-[var(--color-text-faint)]">
                  No runs yet — the roll-up job records one every few minutes once checks are flowing.
                </TD>
              </TR>
            )}
          </TBody>
        </Table>
      </Card>

      <Card>
        <div className="border-b border-[var(--color-border)] px-4 py-2.5 text-sm font-medium">
          Latency intelligence
          <span className="ml-2 text-xs font-normal text-[var(--color-text-faint)]">
            P50–P99 over the last hour · assessment from P95 vs per-API bands
          </span>
        </div>
        <Table>
          <THead>
            <TR>
              <TH>Service</TH>
              <TH>Assessment</TH>
              <TH className="text-right">Current</TH>
              <TH className="text-right">P95</TH>
              <TH className="text-right">P99</TH>
              <TH className="text-right">Baseline</TH>
              <TH className="text-right">Deviation</TH>
            </TR>
          </THead>
          <TBody>
            {(latency.data ?? []).map((l) => (
              <TR key={l.apiId} className="cursor-pointer" onClick={() => setOpenLat(l.apiId)}>
                <TD className="font-medium">{l.targetName}</TD>
                <TD>
                  <AssessPill a={l.assessment} />
                </TD>
                <TD className="text-right tabular-nums">{ms(l.current)}</TD>
                <TD className="text-right tabular-nums">{ms(l.p95)}</TD>
                <TD className="text-right tabular-nums text-[var(--color-text-faint)]">
                  {ms(l.p99)}
                </TD>
                <TD className="text-right tabular-nums text-[var(--color-text-faint)]">
                  {ms(l.baseline.avgMs)}
                </TD>
                <TD
                  className="text-right tabular-nums"
                  style={{
                    color:
                      l.deviationPercent == null
                        ? undefined
                        : l.deviationPercent > 50
                          ? 'var(--color-down)'
                          : l.deviationPercent > 15
                            ? 'var(--color-degraded)'
                            : 'var(--color-text-muted)',
                  }}
                >
                  {l.deviationPercent == null
                    ? '—'
                    : `${l.deviationPercent > 0 ? '+' : ''}${l.deviationPercent}%`}
                </TD>
              </TR>
            ))}
            {!latency.isLoading && (latency.data ?? []).length === 0 && (
              <TR>
                <TD colSpan={7} className="py-8 text-center text-[var(--color-text-faint)]">
                  No active targets.
                </TD>
              </TR>
            )}
          </TBody>
        </Table>
      </Card>

      <Card className="flex flex-wrap items-end gap-3 p-3">
        <label className="flex-1 text-xs text-[var(--color-text-faint)]">
          Search URL / body
          <div className="mt-1 flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2">
            <Search className="size-3.5 text-[var(--color-text-faint)]" />
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(0);
              }}
              placeholder="/api/v1/payment/status, DB_CONNECTION_ERROR…"
              className="w-full bg-transparent py-1.5 text-sm outline-none"
            />
          </div>
        </label>
        <label className="text-xs text-[var(--color-text-faint)]">
          HTTP
          <select
            value={statusClass}
            onChange={(e) => {
              setStatusClass(e.target.value);
              setPage(0);
            }}
            className="mt-1 block rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
          >
            {STATUS_CLASSES.map((s) => (
              <option key={s || 'all'} value={s}>
                {s || 'All'}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-[var(--color-text-faint)]">
          Health
          <select
            value={health}
            onChange={(e) => {
              setHealth(e.target.value);
              setPage(0);
            }}
            className="mt-1 block rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
          >
            {HEALTH.map((s) => (
              <option key={s || 'all'} value={s}>
                {s || 'All'}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-[var(--color-text-faint)]">
          Range
          <select
            value={range}
            onChange={(e) => {
              setRange(e.target.value);
              setPage(0);
            }}
            className="mt-1 block rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
          >
            {Object.keys(RANGES).map((r) => (
              <option key={r} value={r}>
                Last {r}
              </option>
            ))}
          </select>
        </label>
      </Card>

      <Card>
        <Table>
          <THead>
            <TR>
              <TH>Time</TH>
              <TH>Service</TH>
              <TH>Method</TH>
              <TH>URL (masked)</TH>
              <TH className="text-right">HTTP</TH>
              <TH>Health</TH>
              <TH>Failure</TH>
              <TH className="text-right">Latency</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((t) => (
              <TR key={t.id} className="cursor-pointer" onClick={() => setOpen(t.checkId)}>
                <TD className="whitespace-nowrap text-xs text-[var(--color-text-faint)]">
                  {new Date(t.checkedAt).toLocaleTimeString()}
                </TD>
                <TD className="font-medium">{t.targetName ?? '—'}</TD>
                <TD className="font-mono text-xs">{t.requestMethod}</TD>
                <TD className="max-w-[280px] truncate font-mono text-xs text-[var(--color-text-muted)]">
                  {t.requestUrlMasked}
                </TD>
                <TD
                  className="text-right font-mono text-xs tabular-nums"
                  style={{ color: statusColor(t.responseStatus) }}
                >
                  {t.responseStatus ?? '—'}
                </TD>
                <TD>
                  <HealthBadge status={t.healthStatus} />
                </TD>
                <TD className="text-xs text-[var(--color-text-muted)]">{t.failureType ?? '—'}</TD>
                <TD className="text-right tabular-nums">{t.responseTimeMs ?? '—'} ms</TD>
              </TR>
            ))}
            {isLoading && (
              <TR>
                <TD colSpan={8} className="py-10 text-center">
                  <Skeleton className="mx-auto h-4 w-40" />
                </TD>
              </TR>
            )}
            {!isLoading && rows.length === 0 && (
              <TR>
                <TD colSpan={8} className="py-10 text-center text-[var(--color-text-faint)]">
                  No traces in this window. Checks are captured as the scheduler runs them.
                </TD>
              </TR>
            )}
          </TBody>
        </Table>
      </Card>

      {total > pageSize && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <Button
            size="sm"
            variant="outline"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Previous
          </Button>
          <span className="text-[var(--color-text-faint)]">
            {page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} of {total}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={(page + 1) * pageSize >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}

      <Sheet open={openCheckId != null} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent>{openCheckId && <TraceDetail checkId={openCheckId} />}</SheetContent>
      </Sheet>

      <Sheet open={openHcId != null} onOpenChange={(o) => !o && setOpenHc(null)}>
        <SheetContent>{openHcId && <RunDetail hcId={openHcId} />}</SheetContent>
      </Sheet>

      <Sheet open={openLatId != null} onOpenChange={(o) => !o && setOpenLat(null)}>
        <SheetContent>{openLatId && <LatencyDetail apiId={openLatId} />}</SheetContent>
      </Sheet>
    </div>
  );
}
