import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OctagonX, Play, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api';
import { authStore } from '@/lib/auth';
import {
  isLive,
  runApi,
  useRunMetrics,
  useRuns,
  useSuiteRuns,
  type LoadRunInfo,
  type MetricPoint,
  type PackInfo,
  type Profile,
  type RunStatus,
  type Safety,
  type SuiteRunInfo,
} from '@/lib/loadrun';
import { reportRoute } from '@/lib/loadtest';

const PROFILES: Profile[] = ['SMOKE', 'LOAD', 'STRESS', 'SPIKE', 'SOAK', 'BREAKPOINT'];
const STATUS_COLOR: Record<RunStatus, string> = {
  QUEUED: 'var(--color-unknown)',
  PREFLIGHT: 'var(--color-degraded)',
  RUNNING: 'var(--color-brand)',
  COMPLETED: 'var(--color-up)',
  ABORTED: 'var(--color-degraded)',
  FAILED: 'var(--color-down)',
};
const errText = (e: unknown): string => (e instanceof Error ? e.message : 'Failed');

function StatusTag({ s }: { s: RunStatus }) {
  return (
    <Badge
      style={{
        color: STATUS_COLOR[s],
        borderColor: `color-mix(in oklab, ${STATUS_COLOR[s]} 45%, transparent)`,
      }}
    >
      {s.toLowerCase()}
    </Badge>
  );
}

function Spark({
  points,
  pick,
  label,
  unit,
}: {
  points: MetricPoint[];
  pick: (p: MetricPoint) => number;
  label: string;
  unit: string;
}) {
  const vals = points.map(pick);
  const max = Math.max(1, ...vals);
  const w = 300;
  const h = 56;
  const path = vals
    .map(
      (v, i) =>
        `${i === 0 ? 'M' : 'L'}${((i / Math.max(1, vals.length - 1)) * w).toFixed(1)},${(h - (v / max) * (h - 4) - 2).toFixed(1)}`,
    )
    .join(' ');
  return (
    <div>
      <div className="flex justify-between text-xs text-[var(--color-text-muted)]">
        <span>{label}</span>
        <span className="tabular-nums">
          {vals.length
            ? `${Math.round(vals[vals.length - 1] ?? 0)} ${unit} (peak ${Math.round(max)})`
            : '—'}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-14 w-full" role="img" aria-label={label}>
        <path d={path} fill="none" stroke="var(--color-brand)" strokeWidth="1.5" />
      </svg>
    </div>
  );
}

function LiveConsole({ run, canAbort }: { run: LoadRunInfo; canAbort: boolean }) {
  const qc = useQueryClient();
  const live = isLive(run.status);
  const { data: pts = [] } = useRunMetrics(run.id, live);
  const [reason, setReason] = useState('');
  const abort = useMutation({
    mutationFn: () => runApi.abort(run.id, reason.trim()),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['lt-runs'] }),
  });
  const total = pts.reduce((a, p) => a + p.requests, 0);
  const failed = pts.reduce((a, p) => a + p.failures, 0);
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          {run.snapshot.name ?? 'Load run'} <StatusTag s={run.status} />
          {run.abortRequested && live && <Badge>abort requested</Badge>}
        </CardTitle>
        {!live && run.status !== 'QUEUED' && (
          <Link className="text-sm underline" to={reportRoute('load', run.id)}>
            Open the report →
          </Link>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-[var(--color-text-muted)]">
          {total.toLocaleString()} requests · {failed.toLocaleString()} failed
          {total > 0 ? ` (${((failed / total) * 100).toFixed(1)}%)` : ''}
          {run.effectiveClass ? ` · ${run.effectiveClass.toLowerCase()}` : ''}
        </p>
        {run.error && <p className="text-sm text-[var(--color-down)]">{run.error}</p>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Spark points={pts} pick={(p) => p.rps} label="Requests per second" unit="rps" />
          <Spark points={pts} pick={(p) => p.p95Ms} label="Response time p95" unit="ms" />
          <Spark
            points={pts}
            pick={(p) => (p.requests ? (p.failures / p.requests) * 100 : 0)}
            label="Failure rate"
            unit="%"
          />
        </div>
        {live && canAbort && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="h-9 min-w-56 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 text-sm"
              placeholder="Reason for stopping (3+ characters)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <Button
              variant="danger"
              size="sm"
              disabled={reason.trim().length < 3 || abort.isPending}
              onClick={() => abort.mutate()}
            >
              <OctagonX /> Stop this run
            </Button>
            {abort.error && (
              <span className="text-xs text-[var(--color-down)]">{errText(abort.error)}</span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SafetyBox({ s }: { s: Safety }) {
  return s.allowed ? (
    <p className="flex items-center gap-2 text-sm text-[var(--color-up)]">
      <ShieldCheck className="size-4" /> Allowed by the safety gate
      {s.effectiveClass ? ` (${s.effectiveClass.toLowerCase()})` : ''}.
    </p>
  ) : (
    <div className="rounded-md border border-[var(--color-down)]/50 bg-[var(--color-down)]/10 p-3 text-sm">
      <p className="mb-1 font-medium text-[var(--color-down)]">Blocked by the safety gate</p>
      <ul className="list-disc space-y-0.5 pl-5">
        {s.violations.map((v) => (
          <li key={v.code}>{v.message}</li>
        ))}
      </ul>
    </div>
  );
}

function LoadForm({
  apiId,
  pack,
  onStarted,
}: {
  apiId: string;
  pack: PackInfo;
  onStarted: (r: LoadRunInfo) => void;
}) {
  const qc = useQueryClient();
  const rec = pack.recommended;
  const [profile, setProfile] = useState<Profile>(rec.profile);
  const [rps, setRps] = useState(rec.targetRps);
  const [dur, setDur] = useState(rec.durationSeconds);
  const [vus, setVus] = useState(rec.maxVus);
  const [dataSetId, setDataSetId] = useState('');
  const [ack, setAck] = useState(false);
  const [safety, setSafety] = useState<Safety | null>(null);
  const needsData = pack.dataFields.length > 0;
  const risky = pack.realSideEffects || pack.moneyMoving;
  const { data: dataSets = [] } = useQuery({ queryKey: ['lt-datasets'], queryFn: runApi.dataSets });

  const check = useMutation({
    mutationFn: () =>
      runApi.preflight(apiId, rps, vus, dur, pack.moneyMoving || pack.realSideEffects),
    onSuccess: setSafety,
  });
  const makeExample = useMutation({
    mutationFn: (name: string) => runApi.exampleDataSet(pack.id, name),
    onSuccess: (d) => {
      setDataSetId(d.id);
      void qc.invalidateQueries({ queryKey: ['lt-datasets'] });
    },
  });
  const start = useMutation({
    mutationFn: async () => {
      const plan = await runApi.createPlan(pack.id, {
        apiId,
        profile,
        targetRps: rps,
        durationSeconds: dur,
        maxVus: vus,
        ...(dataSetId ? { dataSetId } : {}),
      });
      return runApi.queue(plan.id);
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['lt-runs'] });
      onStarted(r);
    },
  });
  const num = (v: string): number => Math.max(0, Number(v) || 0);
  const field =
    'h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 text-sm';
  const ready = (!needsData || dataSetId !== '') && (!risky || ack);

  return (
    <div className="space-y-3">
      <div className="text-sm text-[var(--color-text-muted)]">
        <p>{pack.description}</p>
        {pack.notes.map((n) => (
          <p key={n} className="text-xs">
            • {n}
          </p>
        ))}
      </div>
      {pack.caution && (
        <p className="flex gap-2 text-sm text-[var(--color-degraded)]">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          {pack.caution}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="text-xs">
          Profile
          <select
            className={field}
            value={profile}
            onChange={(e) => setProfile(e.target.value as Profile)}
          >
            {PROFILES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          Requests / second
          <input
            className={field}
            type="number"
            min={1}
            value={rps}
            onChange={(e) => setRps(num(e.target.value))}
          />
        </label>
        <label className="text-xs">
          Duration (seconds)
          <input
            className={field}
            type="number"
            min={5}
            value={dur}
            onChange={(e) => setDur(num(e.target.value))}
          />
        </label>
        <label className="text-xs">
          Max virtual users
          <input
            className={field}
            type="number"
            min={1}
            value={vus}
            onChange={(e) => setVus(num(e.target.value))}
          />
        </label>
      </div>
      {needsData && (
        <div className="space-y-2 rounded-md border border-[var(--color-border)] p-3">
          <label className="block text-xs">
            Test data (needs: {pack.dataFields.join(', ')})
            <select
              className={field}
              value={dataSetId}
              onChange={(e) => setDataSetId(e.target.value)}
            >
              <option value="">Choose a data set…</option>
              {dataSets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.recordCount} records · {d.environment}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            {pack.exampleDataSets.map((e) => (
              <Button
                key={e.name}
                size="sm"
                variant="outline"
                disabled={e.needsEdit || makeExample.isPending}
                title={
                  e.needsEdit
                    ? 'Contains placeholders — upload your own records via the API'
                    : e.description
                }
                onClick={() => makeExample.mutate(e.name)}
              >
                Create “{e.name}”{e.needsEdit ? ' (needs editing)' : ''}
              </Button>
            ))}
          </div>
          {makeExample.error && (
            <p className="text-xs text-[var(--color-down)]">{errText(makeExample.error)}</p>
          )}
        </div>
      )}
      {risky && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
          />
          <span>
            I understand this{' '}
            {pack.realSideEffects
              ? 'sends REAL airtime/data even in the test environment'
              : 'moves test money'}{' '}
            and that the safety gate needs an approved authorization.
          </span>
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={check.isPending}
          onClick={() => check.mutate()}
        >
          <ShieldCheck /> Check safety
        </Button>
        <Button size="sm" disabled={!ready || start.isPending} onClick={() => start.mutate()}>
          <Play /> {start.isPending ? 'Queuing…' : 'Start load test'}
        </Button>
      </div>
      {safety && <SafetyBox s={safety} />}
      {check.error && <p className="text-sm text-[var(--color-down)]">{errText(check.error)}</p>}
      {start.error && <p className="text-sm text-[var(--color-down)]">{errText(start.error)}</p>}
    </div>
  );
}

function SuiteRunsTable({ rows }: { rows: SuiteRunInfo[] }) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Queued</TH>
          <TH>Suite</TH>
          <TH>Status</TH>
          <TH>Result</TH>
          <TH />
        </TR>
      </THead>
      <TBody>
        {rows.map((r) => (
          <TR key={r.id}>
            <TD className="whitespace-nowrap text-xs">{new Date(r.queuedAt).toLocaleString()}</TD>
            <TD className="text-sm">
              {r.suite}
              {r.mode ? ` · ${r.mode}` : ''}
            </TD>
            <TD>
              <StatusTag s={r.status} />
            </TD>
            <TD className="text-xs">
              {r.error ??
                (r.summary
                  ? `${r.summary.passed ?? 0} passed · ${r.summary.failed ?? 0} failed`
                  : '—')}
            </TD>
            <TD>
              {!isLive(r.status) && r.status !== 'FAILED' && (
                <Link className="text-xs underline" to={reportRoute(r.suite, r.id)}>
                  Report
                </Link>
              )}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export function LoadTestLaunchPage() {
  const roles = authStore.user()?.roles ?? [];
  const canRun = roles.includes('ADMIN') || roles.includes('OPERATOR');
  const qc = useQueryClient();
  const { data: targets = [] } = useQuery({ queryKey: ['targets'], queryFn: api.targets });
  const { data: packs = [] } = useQuery({ queryKey: ['lt-packs'], queryFn: runApi.packs });
  const runs = useRuns();
  const corr = useSuiteRuns('correctness');
  const sec = useSuiteRuns('security');
  const [apiPick, setApiPick] = useState('');
  const [kind, setKind] = useState<'correctness' | 'security' | 'load'>('correctness');
  const [packId, setPackId] = useState('');
  const [watch, setWatch] = useState<string | null>(null);
  const apiId = apiPick || targets[0]?.id || '';
  const pack = packs.find((p) => p.id === packId);
  const watched =
    (runs.data ?? []).find((r) => r.id === watch) ??
    (runs.data ?? []).find((r) => isLive(r.status)) ??
    null;
  const suiteRows = useMemo(
    () =>
      [...(corr.data ?? []), ...(sec.data ?? [])]
        .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))
        .slice(0, 10),
    [corr.data, sec.data],
  );
  const suite = useMutation({
    mutationFn: () => runApi.queueSuite(kind as 'correctness' | 'security', apiId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lt-suite-runs'] });
    },
  });
  const field =
    'h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 text-sm';

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Run a test</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Start a correctness, security or load test and watch it live. Every run goes through the
          safety gate — nothing starts unless it is allowed.{' '}
          <Link className="underline" to="/app/load-tests">
            Back to reports
          </Link>
        </p>
      </div>
      {!canRun && (
        <p className="rounded-md border border-[var(--color-border)] p-3 text-sm">
          Your role can view runs but not start them. Starting tests needs ADMIN or OPERATOR.
        </p>
      )}
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <select
              className={field}
              value={apiId}
              onChange={(e) => setApiPick(e.target.value)}
              aria-label="Service"
            >
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} · {t.environment}
                </option>
              ))}
            </select>
            {(['correctness', 'security', 'load'] as const).map((k) => (
              <Button
                key={k}
                size="sm"
                variant={kind === k ? 'default' : 'outline'}
                onClick={() => setKind(k)}
              >
                {k === 'correctness'
                  ? 'Money correctness'
                  : k === 'security'
                    ? 'Security'
                    : 'Load test'}
              </Button>
            ))}
          </div>
          {kind !== 'load' ? (
            <div className="space-y-2">
              <p className="text-sm text-[var(--color-text-muted)]">
                {kind === 'correctness'
                  ? 'Checks that money-moving calls behave exactly as documented: idempotency, duplicate references, statuses, fees.'
                  : 'OWASP API Top 10 checks: authorization, tokens, rate limiting, input handling, error leakage.'}{' '}
                Runs against the chosen service through the safety gate.
              </p>
              <Button
                size="sm"
                disabled={!canRun || !apiId || suite.isPending}
                onClick={() => suite.mutate()}
              >
                <Play /> {suite.isPending ? 'Queuing…' : `Start ${kind} suite`}
              </Button>
              {suite.error && (
                <p className="text-sm text-[var(--color-down)]">{errText(suite.error)}</p>
              )}
              {suite.isSuccess && (
                <p className="text-sm text-[var(--color-up)]">
                  Queued. A worker will pick it up; progress shows below.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <select
                className={field}
                value={packId}
                onChange={(e) => setPackId(e.target.value)}
                aria-label="Scenario"
              >
                <option value="">Choose a scenario…</option>
                {packs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                    {p.realSideEffects
                      ? ' — REAL side effects'
                      : p.moneyMoving
                        ? ' — moves money'
                        : ''}
                  </option>
                ))}
              </select>
              {pack && canRun && apiId && (
                <LoadForm
                  key={`${pack.id}:${apiId}`}
                  apiId={apiId}
                  pack={pack}
                  onStarted={(r) => setWatch(r.id)}
                />
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {watched && <LiveConsole run={watched} canAbort={canRun} />}

      <Card>
        <CardHeader>
          <CardTitle>Recent load runs</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <THead>
              <TR>
                <TH>Queued</TH>
                <TH>Scenario</TH>
                <TH>Status</TH>
                <TH>Requests</TH>
                <TH>p95</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {(runs.data ?? []).map((r) => (
                <TR key={r.id}>
                  <TD className="whitespace-nowrap text-xs">
                    {new Date(r.queuedAt).toLocaleString()}
                  </TD>
                  <TD className="text-sm">{r.snapshot.name ?? r.id.slice(0, 8)}</TD>
                  <TD>
                    <StatusTag s={r.status} />
                  </TD>
                  <TD className="text-xs tabular-nums">
                    {r.summary ? r.summary.totalRequests.toLocaleString() : '—'}
                  </TD>
                  <TD className="text-xs tabular-nums">
                    {r.summary ? `${Math.round(r.summary.latencyMs.p95)} ms` : '—'}
                  </TD>
                  <TD className="space-x-3 whitespace-nowrap text-xs">
                    <button className="underline" onClick={() => setWatch(r.id)}>
                      Watch
                    </button>
                    {!isLive(r.status) && (
                      <Link className="underline" to={reportRoute('load', r.id)}>
                        Report
                      </Link>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          {runs.data?.length === 0 && (
            <p className="p-4 text-sm text-[var(--color-text-faint)]">No load runs yet.</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recent correctness and security runs</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <SuiteRunsTable rows={suiteRows} />
          {suiteRows.length === 0 && (
            <p className="p-4 text-sm text-[var(--color-text-faint)]">None yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
