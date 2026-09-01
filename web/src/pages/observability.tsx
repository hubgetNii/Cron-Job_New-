import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, Eye, EyeOff, Search } from 'lucide-react';
import { useTrace, useTraces } from '@/lib/queries';
import { api, downloadWithAuth, traceQuery } from '@/lib/api';
import { authStore } from '@/lib/auth';
import { Card } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { HealthBadge } from '@/components/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import type { RawTrace, TraceRow, TraceSearchParams } from '@/lib/types';

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
    </div>
  );
}
