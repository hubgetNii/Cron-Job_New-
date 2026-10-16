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
  type ProgrammeTier,
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
  const [tier, setTier] = useState<ProgrammeTier | null>(null);
  const { data: programme } = useQuery({
    queryKey: ['lt-programme'],
    queryFn: runApi.programme,
    staleTime: 300_000,
  });
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
        ...(tier?.plan.spikeMultiplier ? { spikeMultiplier: tier.plan.spikeMultiplier } : {}),
        ...(tier?.plan.requiredCapacityRps
          ? { requiredCapacityRps: tier.plan.requiredCapacityRps }
          : {}),
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
      {programme && (
        <div className="space-y-1 rounded-md border border-[var(--color-border)] p-3">
          <label className="block text-xs">
            Test programme tier (optional)
            <select
              className={field}
              value={tier?.id ?? ''}
              onChange={(e) => {
                const t =
                  programme.programmes
                    .flatMap((p) => p.tiers)
                    .find((x) => x.id === e.target.value) ?? null;
                setTier(t);
                if (t) {
                  setProfile(t.plan.profile);
                  setRps(t.plan.targetRps);
                  setDur(t.plan.durationSeconds);
                  setVus(t.plan.maxVus);
                }
              }}
            >
              <option value="">Custom values</option>
              {programme.programmes.map((p) => (
                <optgroup key={p.id} label={p.title}>
                  {p.tiers.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label} — up to {t.peakRps} req/s{t.fits ? '' : ' (capped)'}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          {tier && (
            <p className="text-xs text-[var(--color-text-muted)]">
              {tier.purpose}.{' '}
              {tier.fits ? (
                'Runs at the full target.'
              ) : (
                <span className="text-[var(--color-degraded)]">
                  Reduced to fit the sandbox limits: {tier.reductions.join('; ')}. Targets are
                  provisional until iSmart confirms what the sandbox can take.
                </span>
              )}
            </p>
          )}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="text-xs">
          Profile
          <select
            className={field}
            value={profile}
            onChange={(e) => {
              setProfile(e.target.value as Profile);
              setTier(null);
            }}
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
            onChange={(e) => {
              setRps(num(e.target.value));
              setTier(null);
            }}
          />
        </label>
        <label className="text-xs">
          Duration (seconds)
          <input
            className={field}
            type="number"
            min={5}
            value={dur}
            onChange={(e) => {
              setDur(num(e.target.value));
              setTier(null);
            }}
          />
        </label>
        <label className="text-xs">
          Max virtual users
          <input
            className={field}
            type="number"
            min={1}
            value={vus}
            onChange={(e) => {
              setVus(num(e.target.value));
              setTier(null);
            }}
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

function HarvestButton({ runId }: { runId: string }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => runApi.harvest(runId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['lt-datasets'] }),
  });
  if (m.isSuccess)
    return (
      <span className="text-xs text-[var(--color-up)]" title={m.data.caveat ?? undefined}>
        Saved “{m.data.name}” ({m.data.recordCount}){m.data.caveat ? ' — see note' : ''}
      </span>
    );
  return (
    <>
      <button
        className="underline disabled:opacity-50"
        disabled={m.isPending}
        title="Save the references this run created as a data set for the status-lookup scenarios"
        onClick={() => m.mutate()}
      >
        {m.isPending ? 'Saving…' : 'Save references'}
      </button>
      {m.error && (
        <span className="ml-1 text-[var(--color-down)]" title={errText(m.error)}>
          not available
        </span>
      )}
    </>
  );
}

const CADENCES: [string, string][] = [
  ['Every 6 hours', '0 */6 * * *'],
  ['Daily at 03:00', '0 3 * * *'],
  ['Weekly, Monday 03:00', '0 3 * * 1'],
];
const OUTCOME_TEXT: Record<string, string> = {
  QUEUED: 'Queued',
  REFUSED: 'Refused by safety gate',
  SKIPPED_BUSY: 'Skipped (previous still running)',
  ERROR: 'Error',
};

function SchedulesCard({
  targets,
  canRun,
}: {
  targets: { id: string; name: string }[];
  canRun: boolean;
}) {
  const qc = useQueryClient();
  const { data = [] } = useQuery({
    queryKey: ['lt-schedules'],
    queryFn: runApi.schedules,
    refetchInterval: 30_000,
  });
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['lt-schedules'] });
  const [api, setApi] = useState('');
  const [suiteKind, setSuiteKind] = useState<'correctness' | 'security'>('correctness');
  const [cron, setCron] = useState(CADENCES[1]![1]);
  const apiId = api || targets[0]?.id || '';
  const save = useMutation({
    mutationFn: () => runApi.saveSchedule(apiId, suiteKind, cron),
    onSuccess: refresh,
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => runApi.setSchedule(v.id, v.enabled),
    onSuccess: refresh,
  });
  const del = useMutation({
    mutationFn: (id: string) => runApi.deleteSchedule(id),
    onSuccess: refresh,
  });
  const field =
    'h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 text-sm';
  return (
    <Card>
      <CardHeader>
        <CardTitle>Scheduled regression</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-[var(--color-text-muted)]">
          Re-runs the correctness and security suites on a cadence so test evidence — and the
          compliance matrix built on it — never goes stale. Every scheduled run passes the same
          safety gate as a manual one, and load tests are never scheduled. Needs the worker running.
        </p>
        <Table>
          <THead>
            <TR>
              <TH>Service</TH>
              <TH>Suite</TH>
              <TH>Cadence</TH>
              <TH>Next</TH>
              <TH>Last</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {data.map((s) => (
              <TR key={s.id} className={s.enabled ? '' : 'opacity-60'}>
                <TD className="text-sm">{s.targetName}</TD>
                <TD className="text-sm">{s.suite}</TD>
                <TD className="font-mono text-xs">{s.cron}</TD>
                <TD className="whitespace-nowrap text-xs">
                  {s.enabled ? new Date(s.nextRunAt).toLocaleString() : 'paused'}
                </TD>
                <TD className="text-xs">
                  {s.lastOutcome ? (
                    <span title={s.lastMessage ?? undefined}>
                      {OUTCOME_TEXT[s.lastOutcome]} ·{' '}
                      {s.lastRunAt ? new Date(s.lastRunAt).toLocaleDateString() : ''}
                    </span>
                  ) : (
                    '—'
                  )}
                </TD>
                <TD className="space-x-3 whitespace-nowrap text-xs">
                  {canRun && (
                    <button
                      className="underline"
                      onClick={() => toggle.mutate({ id: s.id, enabled: !s.enabled })}
                    >
                      {s.enabled ? 'Pause' : 'Resume'}
                    </button>
                  )}
                  {canRun && (
                    <button className="underline" onClick={() => del.mutate(s.id)}>
                      Delete
                    </button>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
        {data.length === 0 && (
          <p className="text-sm text-[var(--color-text-faint)]">Nothing scheduled.</p>
        )}
        {canRun && (
          <div className="flex flex-wrap items-center gap-2">
            <select
              className={field}
              value={apiId}
              onChange={(e) => setApi(e.target.value)}
              aria-label="Service"
            >
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <select
              className={field}
              value={suiteKind}
              onChange={(e) => setSuiteKind(e.target.value as 'correctness' | 'security')}
              aria-label="Suite"
            >
              <option value="correctness">Money correctness</option>
              <option value="security">Security</option>
            </select>
            <select
              className={field}
              value={CADENCES.some(([, c]) => c === cron) ? cron : ''}
              onChange={(e) => e.target.value && setCron(e.target.value)}
              aria-label="Cadence"
            >
              {CADENCES.map(([l, c]) => (
                <option key={c} value={c}>
                  {l}
                </option>
              ))}
              <option value="">Custom…</option>
            </select>
            <input
              className={`${field} w-40 font-mono`}
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              aria-label="Cron expression"
            />
            <Button size="sm" disabled={!apiId || save.isPending} onClick={() => save.mutate()}>
              Schedule
            </Button>
          </div>
        )}
        {[save.error, toggle.error, del.error].filter(Boolean).map((e, i) => (
          <p key={i} className="text-sm text-[var(--color-down)]">
            {errText(e)}
          </p>
        ))}
      </CardContent>
    </Card>
  );
}

function WebhookCard({ canRun }: { canRun: boolean }) {
  const qc = useQueryClient();
  const { data: sinks = [] } = useQuery({
    queryKey: ['lt-sinks'],
    queryFn: runApi.sinks,
    refetchInterval: 10_000,
  });
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['lt-sinks'] });
  const [label, setLabel] = useState('Sandbox load test');
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [base, setBase] = useState(() => {
    try {
      return localStorage.getItem('cronmon.publicBase') ?? '';
    } catch {
      return '';
    }
  });
  const { data: deliveries = [] } = useQuery({
    queryKey: ['lt-deliveries', openId],
    queryFn: () => runApi.deliveries(openId!),
    enabled: openId != null,
    refetchInterval: 5_000,
  });
  const create = useMutation({ mutationFn: () => runApi.createSink(label), onSuccess: refresh });
  const setSecret = useMutation({
    mutationFn: (v: { id: string; secret: string }) => runApi.setSinkSecret(v.id, v.secret),
    onSuccess: (_d, v) => {
      setSecrets((s) => ({ ...s, [v.id]: '' }));
      refresh();
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => runApi.deleteSink(id),
    onSuccess: refresh,
  });
  const field =
    'h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 text-sm';
  const urlFor = (slug: string): string =>
    `${base.replace(/\/$/, '') || 'https://<your-public-api-address>'}/hooks/loadtest/${slug}`;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Webhook receiver</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-[var(--color-text-muted)]">
          A public address iSmart can deliver sandbox webhooks to. It checks every signature the
          documented way, answers 401 to anything it cannot authenticate, and records every delivery
          — including retries, duplicates and forgeries — so the tests can inspect them. Register
          the address in the iSmart test console, then paste the signing secret iSmart gives you
          below.
        </p>
        <label className="block text-xs">
          Public address of this API (so the full webhook URL can be shown)
          <input
            className={`${field} block w-full max-w-md`}
            placeholder="https://monitor.example.com"
            value={base}
            onChange={(e) => {
              setBase(e.target.value);
              try {
                localStorage.setItem('cronmon.publicBase', e.target.value);
              } catch {
                /* optional */
              }
            }}
          />
        </label>
        {sinks.map((s) => (
          <div key={s.id} className="space-y-2 rounded-md border border-[var(--color-border)] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium">{s.label}</span>
              <span className="text-xs text-[var(--color-text-muted)]">
                {s.deliveries} deliveries
                {s.lastDeliveryAt ? ` · last ${new Date(s.lastDeliveryAt).toLocaleString()}` : ''}
              </span>
            </div>
            <code className="block break-all rounded bg-[var(--color-surface-2)] p-2 text-xs">
              {urlFor(s.slug)}
            </code>
            {!s.hasSecret && (
              <p className="text-xs text-[var(--color-degraded)]">
                No signing secret yet — deliveries are recorded but answered 503 until you add it.
              </p>
            )}
            {canRun && (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className={`${field} w-72`}
                  type="password"
                  autoComplete="off"
                  placeholder={
                    s.hasSecret ? 'Replace signing secret…' : 'Signing secret from iSmart'
                  }
                  value={secrets[s.id] ?? ''}
                  onChange={(e) => setSecrets((x) => ({ ...x, [s.id]: e.target.value }))}
                />
                <Button
                  size="sm"
                  disabled={(secrets[s.id] ?? '').length < 8 || setSecret.isPending}
                  onClick={() => setSecret.mutate({ id: s.id, secret: secrets[s.id] ?? '' })}
                >
                  Save secret
                </Button>
                <button
                  className="text-xs underline"
                  onClick={() => setOpenId(openId === s.id ? null : s.id)}
                >
                  {openId === s.id ? 'Hide deliveries' : 'Show deliveries'}
                </button>
                <button className="text-xs underline" onClick={() => del.mutate(s.id)}>
                  Delete
                </button>
              </div>
            )}
            {openId === s.id && (
              <Table>
                <THead>
                  <TR>
                    <TH>Received</TH>
                    <TH>Event</TH>
                    <TH>Reference</TH>
                    <TH>Try</TH>
                    <TH>Signature</TH>
                    <TH>Answered</TH>
                  </TR>
                </THead>
                <TBody>
                  {deliveries.map((d) => (
                    <TR key={d.id}>
                      <TD className="whitespace-nowrap text-xs">
                        {new Date(d.receivedAt).toLocaleTimeString()}
                      </TD>
                      <TD className="text-xs">
                        {d.eventType ?? '—'}
                        <div className="font-mono text-[11px] text-[var(--color-text-faint)]">
                          {d.eventId}
                        </div>
                      </TD>
                      <TD className="font-mono text-xs">{d.reference ?? '—'}</TD>
                      <TD className="text-xs tabular-nums">{d.attempt}</TD>
                      <TD
                        className="text-xs"
                        style={{ color: d.signatureOk ? 'var(--color-up)' : 'var(--color-down)' }}
                        title={d.reason ?? undefined}
                      >
                        {d.signatureOk ? 'valid' : (d.reason ?? 'invalid')}
                      </TD>
                      <TD className="text-xs tabular-nums">{d.respondedWith}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </div>
        ))}
        {sinks.length === 0 && (
          <p className="text-sm text-[var(--color-text-faint)]">No receiver yet.</p>
        )}
        {canRun && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={`${field} w-64`}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              aria-label="Receiver name"
            />
            <Button
              size="sm"
              disabled={label.trim().length < 2 || create.isPending}
              onClick={() => create.mutate()}
            >
              Create receiver
            </Button>
          </div>
        )}
        {[create.error, setSecret.error, del.error].filter(Boolean).map((e, i) => (
          <p key={i} className="text-sm text-[var(--color-down)]">
            {errText(e)}
          </p>
        ))}
      </CardContent>
    </Card>
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
                    {canRun && r.status === 'COMPLETED' && <HarvestButton runId={r.id} />}
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
      <WebhookCard canRun={canRun} />
      <SchedulesCard targets={targets} canRun={canRun} />
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
