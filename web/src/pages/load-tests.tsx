import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { StatTile } from '@/components/stat-tile';
import { EnvTag, VerdictBadge } from '@/components/loadtest/verdict';
import { ReadinessPanel } from '@/components/loadtest/readiness-panel';
import { ReportActions } from '@/components/loadtest/report-actions';
import { FindingsList } from '@/components/loadtest/findings';
import {
  loadTestApi,
  reportRoute,
  useCatalog,
  useReportIndex,
  type CatalogEntry,
  type ReportIndexItem,
} from '@/lib/loadtest';
import { cn } from '@/lib/utils';

const KIND: Record<ReportIndexItem['kind'], string> = {
  load: 'Load test',
  correctness: 'Money correctness',
  security: 'Security',
};

type Tab = 'reports' | 'readiness' | 'catalog';
const TABS: { id: Tab; label: string; blurb: string }[] = [
  { id: 'reports', label: 'Reports', blurb: 'Every test run with its verdict, in plain language.' },
  {
    id: 'readiness',
    label: 'Readiness',
    blurb: 'Is each service ready for real payments? Decided by gates, not a score.',
  },
  {
    id: 'catalog',
    label: 'API catalog',
    blurb: 'Every documented iSmartPay endpoint and whether it can be load tested.',
  },
];

function ReportsTab() {
  const { data, isLoading } = useReportIndex();
  const nav = useNavigate();
  const [kind, setKind] = useState<'all' | ReportIndexItem['kind']>('all');
  const [target, setTarget] = useState('all');
  const [realOnly, setRealOnly] = useState(false);

  const targets = useMemo(
    () => [...new Map((data ?? []).map((r) => [r.targetId, r.targetName])).entries()],
    [data],
  );
  const rows = (data ?? []).filter(
    (r) =>
      (kind === 'all' || r.kind === kind) &&
      (target === 'all' || r.targetId === target) &&
      (!realOnly || r.isReal),
  );

  const select =
    'h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 text-sm';
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={select}
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
          aria-label="Report type"
        >
          <option value="all">All types</option>
          <option value="load">Load tests</option>
          <option value="correctness">Money correctness</option>
          <option value="security">Security</option>
        </select>
        <select
          className={select}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          aria-label="Service"
        >
          <option value="all">All services</option>
          {targets.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
          <input
            type="checkbox"
            checked={realOnly}
            onChange={(e) => setRealOnly(e.target.checked)}
          />
          Real service only (hide simulator)
        </label>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <THead>
              <TR>
                <TH>When</TH>
                <TH>Test</TH>
                <TH>Service</TH>
                <TH>Environment</TH>
                <TH>Verdict</TH>
                <TH>In one line</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {rows.map((r) => (
                <TR
                  key={`${r.kind}-${r.id}`}
                  className="cursor-pointer"
                  onClick={() => nav(reportRoute(r.kind, r.id))}
                >
                  <TD className="whitespace-nowrap text-xs text-[var(--color-text-faint)]">
                    {new Date(r.finishedAt ?? r.queuedAt).toLocaleString()}
                  </TD>
                  <TD>
                    <div className="font-medium">{r.title}</div>
                    <div className="text-xs text-[var(--color-text-faint)]">{KIND[r.kind]}</div>
                  </TD>
                  <TD className="text-sm">{r.targetName}</TD>
                  <TD>
                    <EnvTag label={r.environmentLabel} isReal={r.isReal} />
                  </TD>
                  <TD>
                    <VerdictBadge value={r.verdict} />
                  </TD>
                  <TD className="max-w-md text-sm text-[var(--color-text-muted)]">{r.headline}</TD>
                  <TD>
                    <ArrowRight className="size-4 text-[var(--color-text-faint)]" />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          {isLoading && <Skeleton className="m-4 h-24" />}
          {!isLoading && rows.length === 0 && (
            <p className="p-6 text-sm text-[var(--color-text-faint)]">
              No reports yet. Run a plan or a suite (or <code>npm run demo:loadtest</code> for
              sample results).
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ReadinessTab() {
  const { data: index } = useReportIndex();
  const targets = useMemo(
    () => [...new Map((index ?? []).map((r) => [r.targetId, r.targetName])).entries()],
    [index],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const apiId = picked ?? targets[0]?.[0] ?? null;
  const { data, isLoading } = useQuery({
    queryKey: ['lt-readiness', apiId],
    queryFn: () => loadTestApi.readiness(apiId!),
    enabled: apiId != null,
  });

  if (targets.length === 0)
    return (
      <p className="text-sm text-[var(--color-text-faint)]">
        No test evidence yet, so there is nothing to assess.
      </p>
    );
  return (
    <div className="space-y-3">
      <select
        className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 text-sm"
        value={apiId ?? ''}
        onChange={(e) => setPicked(e.target.value)}
        aria-label="Service"
      >
        {targets.map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
      {isLoading && <Skeleton className="h-48" />}
      {data && (
        <>
          <Card>
            <CardContent className="space-y-3 p-4">
              <p className="text-base font-medium">{data.headline}</p>
              <ReportActions kind="readiness" id={data.meta.id} />
            </CardContent>
          </Card>
          <ReadinessPanel readiness={data.readiness} />
          {data.findings.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Open findings</CardTitle>
              </CardHeader>
              <CardContent>
                <FindingsList findings={data.findings.slice(0, 8)} />
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

const STATUS: Record<CatalogEntry['loadTest'], { label: string; color: string; hint: string }> = {
  ready: {
    label: 'Ready',
    color: 'var(--color-up)',
    hint: 'A scenario pack exists and needs no prior state.',
  },
  needs_data: {
    label: 'Needs data',
    color: 'var(--color-brand)',
    hint: 'Needs ids/references from an earlier run.',
  },
  caution: {
    label: 'Caution',
    color: 'var(--color-degraded)',
    hint: 'Real-world effects or reaches outside iSmartPay.',
  },
  excluded: {
    label: 'Excluded',
    color: 'var(--color-down)',
    hint: 'Deliberately not load tested.',
  },
  other: { label: 'n/a', color: 'var(--color-unknown)', hint: 'Not an API call we drive.' },
};

function CatalogTab() {
  const { data, isLoading } = useCatalog();
  if (isLoading || !data) return <Skeleton className="h-64" />;
  const areas = [...new Set(data.endpoints.map((e) => e.area))];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {(['ready', 'needs_data', 'caution', 'excluded'] as const).map((s) => (
          <StatTile
            key={s}
            label={STATUS[s].label}
            value={data.summary.byStatus[s] ?? 0}
            hint={STATUS[s].hint}
            accent={STATUS[s].color}
          />
        ))}
        <StatTile
          label="With a pack"
          value={data.summary.withPack}
          hint={`of ${data.summary.apiEndpoints} documented endpoints`}
        />
      </div>
      {areas.map((area) => (
        <Card key={area}>
          <CardHeader>
            <CardTitle>{area}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <THead>
                <TR>
                  <TH>Endpoint</TH>
                  <TH>What it does</TH>
                  <TH>Permission</TH>
                  <TH>Load test</TH>
                  <TH>Notes</TH>
                </TR>
              </THead>
              <TBody>
                {data.endpoints
                  .filter((e) => e.area === area)
                  .map((e) => (
                    <TR key={`${e.method} ${e.path}`}>
                      <TD className="whitespace-nowrap font-mono text-xs">
                        <span className="text-[var(--color-text-faint)]">{e.method}</span>{' '}
                        {e.path.replace('webhook:', '')}
                      </TD>
                      <TD className="text-sm">{e.summary}</TD>
                      <TD className="text-xs text-[var(--color-text-faint)]">
                        {e.permission.join(', ') || '—'}
                      </TD>
                      <TD>
                        <span
                          className="text-xs font-medium"
                          style={{ color: STATUS[e.loadTest].color }}
                        >
                          {STATUS[e.loadTest].label}
                        </span>
                        {e.packId && (
                          <div className="font-mono text-[11px] text-[var(--color-text-faint)]">
                            {e.packId}
                          </div>
                        )}
                      </TD>
                      <TD className="max-w-sm text-xs text-[var(--color-text-muted)]">
                        {e.realSideEffects && (
                          <span className="font-semibold text-[var(--color-degraded)]">
                            REAL side effects in test.{' '}
                          </span>
                        )}
                        {e.note}
                      </TD>
                    </TR>
                  ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function LoadTestsPage() {
  const [tab, setTab] = useState<Tab>('reports');
  const active = TABS.find((t) => t.id === tab)!;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Load tests</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            Is the payment platform ready for real customers? Results are written for business
            readers first, with full technical detail one click away.{' '}
            <Link className="underline" to="/app/reports">
              Operational reports
            </Link>{' '}
            live separately.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-surface-2)]"
            to="/app/load-tests/compare"
          >
            Compare runs
          </Link>
          <Link
            className="rounded-md bg-[var(--color-brand)] px-3 py-2 text-sm font-medium text-[var(--color-brand-fg)] hover:opacity-90"
            to="/app/load-tests/launch"
          >
            Run a test
          </Link>
        </div>
      </div>
      <div className="flex gap-1 border-b border-[var(--color-border)]" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              tab === t.id
                ? 'border-[var(--color-brand)] text-[var(--color-text)]'
                : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="text-sm text-[var(--color-text-faint)]">{active.blurb}</p>
      {tab === 'reports' && <ReportsTab />}
      {tab === 'readiness' && <ReadinessTab />}
      {tab === 'catalog' && <CatalogTab />}
    </div>
  );
}
