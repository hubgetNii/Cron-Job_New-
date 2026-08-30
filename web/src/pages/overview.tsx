import { lazy, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { Activity, CheckCircle2, Siren, Timer, Banknote, XCircle, Sparkles } from 'lucide-react';
import {
  useAnomalies,
  useIncidents,
  usePerformance,
  useSummary,
  useTargetBoard,
} from '@/lib/queries';
import { Badge } from '@/components/ui/badge';
import { StatTile } from '@/components/stat-tile';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { HealthBadge, IncidentStatusBadge, SeverityBadge } from '@/components/status-badge';

// Recharts is heavy — keep it out of the initial bundle.
const PerformanceChart = lazy(() =>
  import('@/components/charts/performance-chart').then((m) => ({ default: m.PerformanceChart })),
);

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

export function OverviewPage() {
  const summary = useSummary();
  const perf = usePerformance(6);
  const board = useTargetBoard();
  const incidents = useIncidents('?status=OPEN&limit=8');
  const anomalies = useAnomalies(24);

  const s = summary.data;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-6">
        {summary.isLoading || !s ? (
          Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[104px]" />)
        ) : (
          <>
            <StatTile
              label="Targets up"
              value={`${s.targets.byStatus.UP}/${s.targets.active}`}
              hint={`${s.targets.total} registered · ${s.targets.moneyMoving} money-moving`}
              accent="var(--color-up)"
              icon={<CheckCircle2 className="size-4" />}
            />
            <StatTile
              label="Down"
              value={s.targets.byStatus.DOWN}
              hint={`${s.targets.byStatus.DEGRADED} degraded`}
              accent={s.targets.byStatus.DOWN > 0 ? 'var(--color-down)' : undefined}
              icon={<XCircle className="size-4" />}
            />
            <StatTile
              label="Open incidents"
              value={s.incidents.open}
              hint={`${s.incidents.acknowledged} acked · ${s.incidents.flapping} flapping`}
              accent={s.incidents.open > 0 ? 'var(--color-down)' : undefined}
              icon={<Siren className="size-4" />}
            />
            <StatTile
              label="Uptime · 24h"
              value={s.uptime24h == null ? '—' : `${s.uptime24h.toFixed(2)}%`}
              hint={`${s.checks24h.toLocaleString()} checks`}
              icon={<Timer className="size-4" />}
            />
            <StatTile
              label="Alerts pending"
              value={s.alerts.pending}
              hint={`${s.alerts.failed24h} failed · ${s.alerts.suppressed24h} suppressed`}
              icon={<Activity className="size-4" />}
            />
            <StatTile
              label="Missed runs"
              value={s.scheduler.missedRunTotal}
              hint={
                s.scheduler.heartbeat
                  ? `tick ${Math.round(s.scheduler.heartbeat.ageMs / 1000)}s ago`
                  : 'scheduler not running'
              }
              accent={s.scheduler.missedRunTotal > 0 ? 'var(--color-degraded)' : undefined}
              icon={<Banknote className="size-4" />}
            />
          </>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Response latency · last 6h</CardTitle>
          </CardHeader>
          <CardContent>
            {perf.isLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <Suspense fallback={<Skeleton className="h-64 w-full" />}>
                <PerformanceChart data={perf.data ?? []} />
              </Suspense>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Open incidents</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {incidents.isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : (incidents.data ?? []).length === 0 ? (
              <p className="py-8 text-center text-sm text-[var(--color-text-faint)]">
                Nothing on fire.
              </p>
            ) : (
              (incidents.data ?? []).map((inc) => (
                <Link
                  key={inc.id}
                  to={`/app/incidents?id=${inc.id}`}
                  className="flex items-center gap-2 rounded-md border border-[var(--color-border)]/60 p-2 text-sm hover:bg-[var(--color-surface-2)]"
                >
                  <SeverityBadge severity={inc.severity} />
                  <span className="font-mono text-xs text-[var(--color-text-muted)]">
                    {inc.incidentNumber}
                  </span>
                  <IncidentStatusBadge status={inc.status} type={inc.incidentType} />
                  <span className="ml-auto text-xs text-[var(--color-text-faint)]">
                    {relTime(inc.startedAt)}
                  </span>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {(anomalies.data ?? []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="size-4 text-[var(--color-brand)]" />
              Anomalies · last 24h
              <Badge
                className="border-[var(--color-brand)] text-[var(--color-brand)]"
                title="Statistical signal, advisory only. Never opens an incident or changes a target."
              >
                ASSISTIVE
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(anomalies.data ?? []).map((a) => {
              const c = a.content as {
                targetName?: string;
                kind?: string;
                note?: string;
              };
              return (
                <div
                  key={a.id}
                  className="flex items-start gap-3 rounded-md border border-[var(--color-border)]/60 p-2 text-sm"
                >
                  <Badge className="border-[var(--color-degraded)] text-[var(--color-degraded)]">
                    {c.kind === 'error_rate' ? 'error rate' : 'latency'}
                  </Badge>
                  <div className="min-w-0">
                    <p className="font-medium">{c.targetName ?? 'target'}</p>
                    <p className="text-xs text-[var(--color-text-muted)]">{c.note}</p>
                  </div>
                  <span className="ml-auto shrink-0 text-xs text-[var(--color-text-faint)]">
                    {relTime(a.createdAt)}
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Money-moving targets</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {(board.data ?? [])
            .filter((t) => t.isMoneyMoving || t.endpointClass === 'payment_status')
            .slice(0, 9)
            .map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-3 rounded-md border border-[var(--color-border)]/60 p-3"
              >
                <HealthBadge status={t.status} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{t.name}</p>
                  <p className="text-xs text-[var(--color-text-faint)]">
                    {t.endpointClass} · {t.lastResponseMs ?? '—'}ms ·{' '}
                    {t.uptime24h == null ? '—' : `${t.uptime24h}%`}
                  </p>
                </div>
              </div>
            ))}
          {(board.data ?? []).length === 0 && !board.isLoading && (
            <p className="col-span-full py-6 text-center text-sm text-[var(--color-text-faint)]">
              No targets registered yet.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
