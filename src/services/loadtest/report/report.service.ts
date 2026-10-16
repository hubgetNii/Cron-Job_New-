import { NotFoundError } from '../../../lib/errors.js';
import { query } from '../../../lib/db.js';
import { findTargetById } from '../../../repositories/monitored-apis.repo.js';
import * as runs from '../../../repositories/load-test-runs.repo.js';
import * as suites from '../../../repositories/load-test-correctness.repo.js';
import { getDataSet } from '../../../repositories/load-test-data-sets.repo.js';
import { PlanConfigSchema, buildStages, type PlanConfig } from '../../../domain/load-plan.js';
import {
  evaluateRunSlo,
  resolveSlo,
  type RunNumbers,
  type SloEvaluation,
} from '../../../domain/load-slo.js';
import {
  CONTROL_INFO,
  describeFindings,
  findingsFromSlo,
  findingsFromSuite,
  sortFindings,
  type Finding,
} from '../../../domain/load-findings.js';
import {
  assessReadiness,
  type LoadEvidence,
  type Readiness,
  type SuiteEvidence,
} from '../../../domain/load-readiness.js';
import { packById } from '../../../loadtest/packs/packs.js';
import type { RunSummary } from '../metrics-aggregator.js';
import type { CheckResult, SuiteSummary } from '../../../loadtest/correctness/suite.js';
import {
  GLOSSARY,
  decisionFor,
  describeScenario,
  describeShape,
  environmentLabel,
  errorsPlain,
  keyNumbers,
  loadHeadline,
} from './humanize.js';
import type {
  LoadRunReport,
  ReadinessReport,
  ReportCheck,
  ReportIndexItem,
  ReportMeta,
  SuiteDigest,
  SuiteReport,
  TimelineEntry,
  TrendPoint,
} from './report.types.js';

/* ── helpers ───────────────────────────────────────────────────────────── */

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

async function requesterLabel(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const { rows } = await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [
    userId,
  ]);
  return rows[0]?.email ?? null;
}

async function auditTimeline(entityType: string, id: string): Promise<TimelineEntry[]> {
  const { rows } = await query<{
    created_at: Date;
    action: string;
    actor_label: string | null;
    summary: string | null;
  }>(
    `SELECT created_at, action, actor_label, summary FROM audit_logs
      WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at, id`,
    [entityType, id],
  );
  return rows.map((r) => ({
    at: r.created_at.toISOString(),
    event: r.action.replace(/^load_test\./, '').replace(/[._]/g, ' '),
    detail: r.summary ?? '',
    actor: r.actor_label,
  }));
}

const numbersOf = (s: RunSummary | null): RunNumbers | null => (s ? s : null);

const sloScore = (e: SloEvaluation): number => {
  const graded = e.checks.filter((c) => c.status !== 'INFO');
  if (graded.length === 0) return 0;
  return (
    graded.reduce((n, c) => n + (c.status === 'PASS' ? 1 : c.status === 'WARN' ? 0.6 : 0), 0) /
    graded.length
  );
};

export function evaluate(run: runs.LoadRun): { cfg: PlanConfig; evaluation: SloEvaluation } {
  const cfg = PlanConfigSchema.parse(run.snapshot.config);
  return {
    cfg,
    evaluation: evaluateRunSlo({
      config: cfg,
      numbers: numbersOf(run.summary),
      runStatus: run.status,
      finishedReason: run.finishedReason,
    }),
  };
}

function suiteVerdict(run: suites.CorrectnessRun): 'PASS' | 'FAIL' | 'INCONCLUSIVE' {
  if (run.status !== 'COMPLETED' || !run.summary) return 'INCONCLUSIVE';
  return run.summary.verdict;
}

function digest(run: suites.CorrectnessRun, now: Date): SuiteDigest {
  const env = environmentLabel(run.effectiveClass);
  const s: SuiteSummary | null = run.summary;
  const results: CheckResult[] = run.results ?? [];
  const verdict = suiteVerdict(run);
  const failedChecks = results
    .filter((r) => r.status === 'FAIL' || r.status === 'ERROR')
    .map((r) => {
      const info = r.controls.map((c) => CONTROL_INFO[c]).find(Boolean);
      return {
        id: r.id,
        title: r.title,
        why: info?.impact ?? 'A protection the programme expects did not hold.',
      };
    });
  const total = s?.total ?? results.length;
  const name = run.suite === 'security' ? 'security' : 'money-safety';
  const age = run.finishedAt
    ? Math.floor((now.getTime() - new Date(run.finishedAt).getTime()) / 86_400_000)
    : 0;
  return {
    runId: run.id,
    suite: run.suite,
    finishedAt: run.finishedAt ?? run.queuedAt,
    environmentLabel: env.label + (age > 30 ? ` — ${age} days old` : ''),
    verdict,
    passed: s?.passed ?? 0,
    failed: (s?.failed ?? 0) + (s?.errored ?? 0),
    warnings: s?.warnings ?? 0,
    skipped: s?.skipped ?? 0,
    total,
    headline:
      verdict === 'INCONCLUSIVE' && (s?.blocked ?? 0) > 0
        ? `${s?.blocked} of ${total} ${name} checks could not run because the test key lacks ${(s?.missingPermissions ?? []).join(', ')}. Nothing was found wrong with the service; issue a fuller key and re-run.`
        : verdict === 'INCONCLUSIVE'
          ? `The ${name} run did not complete, so it proves nothing.`
          : failedChecks.length === 0
            ? `All ${s?.passed ?? 0} ${name} checks passed${s?.skipped ? ` (${s.skipped} could not run in this environment)` : ''}${s?.warnings ? `, with ${s.warnings} hardening suggestion(s)` : ''}.`
            : `${failedChecks.length} of ${total} ${name} checks failed: ${failedChecks.map((c) => c.title.toLowerCase()).join('; ')}.`,
    failedChecks,
  };
}

async function latestSuite(
  apiId: string,
  suite: 'correctness' | 'security',
): Promise<suites.CorrectnessRun | null> {
  const list = await suites.listCorrectnessRuns({ apiId, suite, limit: 20 });
  return list.find((r) => r.status === 'COMPLETED') ?? null;
}

function suiteEvidence(run: suites.CorrectnessRun | null): SuiteEvidence | null {
  if (!run || run.status !== 'COMPLETED' || !run.summary) return null;
  const a = run.summary.assertions;
  return {
    id: run.id,
    verdict: run.summary.verdict,
    warnings: run.summary.warnings ?? 0,
    skipped: run.summary.skipped,
    finishedAt: run.finishedAt ?? run.queuedAt,
    environmentClass: run.effectiveClass,
    assertionPassRatio: a.total === 0 ? 0 : (a.total - a.failed) / a.total,
  };
}

async function readinessFor(
  apiId: string,
  now: Date,
): Promise<{
  readiness: Readiness;
  loadEvidence: LoadEvidence[];
  correctness: suites.CorrectnessRun | null;
  security: suites.CorrectnessRun | null;
}> {
  const recent = (await runs.listRuns({ apiId, limit: 60 })).filter((r) =>
    ['COMPLETED', 'ABORTED', 'FAILED'].includes(r.status),
  );
  const loadEvidence: LoadEvidence[] = recent.map((r) => {
    const { cfg, evaluation } = evaluate(r);
    return {
      id: r.id,
      profile: cfg.profile,
      verdict: evaluation.verdict,
      finishedAt: r.finishedAt ?? r.queuedAt,
      environmentClass: r.effectiveClass,
      sloScore: sloScore(evaluation),
    };
  });
  const [correctness, security] = await Promise.all([
    latestSuite(apiId, 'correctness'),
    latestSuite(apiId, 'security'),
  ]);
  const readiness = assessReadiness({
    now,
    load: loadEvidence,
    correctness: suiteEvidence(correctness),
    security: suiteEvidence(security),
  });
  return { readiness, loadEvidence, correctness, security };
}

async function metaFor(
  kind: ReportMeta['kind'],
  id: string,
  title: string,
  apiId: string,
  cls: ReportMeta['environment']['class'],
  requestedBy: string | null,
): Promise<ReportMeta> {
  const target = await findTargetById(apiId);
  const env = environmentLabel(cls);
  return {
    kind,
    id,
    title,
    generatedAt: new Date().toISOString(),
    target: {
      id: apiId,
      name: target?.name ?? 'Unknown target',
      host: target ? hostOf(target.url) : '',
    },
    environment: { class: cls, label: env.label, isReal: env.isReal },
    requestedBy: await requesterLabel(requestedBy),
  };
}

/* ── load run report ───────────────────────────────────────────────────── */

export async function buildLoadRunReport(
  runId: string,
  now: Date = new Date(),
): Promise<LoadRunReport> {
  const run = await runs.getRun(runId);
  if (!run) throw new NotFoundError('Run not found');
  const plan = await runs.getPlan(run.planId);
  const { cfg, evaluation } = evaluate(run);
  const slo = resolveSlo(cfg);
  const pack = cfg.packId ? packById(cfg.packId) : undefined;
  const meta = await metaFor(
    'load',
    run.id,
    `${plan?.name ?? 'Load test'} — ${cfg.profile} run`,
    run.apiId,
    run.effectiveClass,
    run.requestedBy,
  );
  const n = numbersOf(run.summary);
  const total = n?.totalRequests ?? 0;
  const serverErrorRate = n
    ? (n.errorClasses.server5xx + n.errorClasses.networkOrTimeout) / Math.max(1, total)
    : 0;

  const findings = sortFindings([...findingsFromSlo(evaluation, { targetRps: cfg.targetRps })]);
  if (evaluation.verdict === 'INCONCLUSIVE' && findings.length === 0) {
    findings.push({
      id: 'perf.inconclusive',
      source: 'performance',
      severity: 'INFO',
      title: 'This run is not valid evidence',
      impact: 'No conclusion about the service can be drawn from it.',
      cause: evaluation.reason,
      recommendation: 'Fix the cause above and repeat the run.',
      reference: 'inconclusive',
      advisory: false,
    });
  }

  const [correctnessRun, securityRun, dataSet, metricRows, timeline, siblings, readyCtx] =
    await Promise.all([
      latestSuite(run.apiId, 'correctness'),
      latestSuite(run.apiId, 'security'),
      cfg.dataSetId ? getDataSet(cfg.dataSetId) : Promise.resolve(null),
      runs.listMetrics(run.id),
      auditTimeline('load_test_run', run.id),
      runs.listRuns({ planId: run.planId, limit: 12 }),
      readinessFor(run.apiId, now),
    ]);

  const trend: TrendPoint[] = siblings
    .filter((r) => ['COMPLETED', 'ABORTED', 'FAILED'].includes(r.status) && r.summary)
    .map((r) => {
      const ev = evaluate(r);
      const s = r.summary!;
      return {
        runId: r.id,
        finishedAt: r.finishedAt ?? r.queuedAt,
        verdict: ev.evaluation.verdict,
        p95Ms: s.latencyMs.p95,
        errorRate:
          (s.errorClasses.server5xx + s.errorClasses.networkOrTimeout) /
          Math.max(1, s.totalRequests),
        achievedRps: s.achievedAvgRps,
        current: r.id === run.id,
      };
    })
    .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));

  const stages = buildStages(cfg);
  const flags: string[] = [];
  if (cfg.moneyMoving) flags.push('Moves (test) money');
  if (cfg.realSideEffects) flags.push('Real-world side effects even in test');
  if (cfg.fanout > 1) flags.push(`Batch of ${cfg.fanout} payments per request`);
  if (!meta.environment.isReal)
    flags.push('Run against the simulator — not evidence about the real service');

  const lifecycle: TimelineEntry[] = [
    {
      at: run.queuedAt,
      event: 'queued',
      detail: `${cfg.profile} plan queued`,
      actor: meta.requestedBy,
    },
    ...(run.startedAt
      ? [
          {
            at: run.startedAt,
            event: 'started',
            detail: `worker ${run.workerId ?? 'unknown'} began; k6 ${run.k6Version ?? ''}`.trim(),
            actor: null,
          },
        ]
      : []),
    ...(run.finishedAt
      ? [
          {
            at: run.finishedAt,
            event: run.status.toLowerCase(),
            detail: run.finishedReason ?? '',
            actor: null,
          },
        ]
      : []),
  ];
  // The audit trail already records "run queued" / "run started"; keep the lifecycle rows only
  // where the audit trail has no equivalent (the completion reason lives only on the run).
  const audited = new Set(timeline.map((e) => e.event));
  const lifecycleOnly = lifecycle.filter(
    (e) =>
      !(e.event === 'queued' && audited.has('run queued')) &&
      !(e.event === 'started' && audited.has('run started')),
  );
  const merged = [...lifecycleOnly, ...timeline].sort((a, b) => a.at.localeCompare(b.at));
  const seen = new Set<string>();
  const dedupedTimeline = merged.filter((e) => {
    const k = `${e.at}|${e.event}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });

  const seconds =
    run.startedAt && run.finishedAt
      ? Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)
      : null;
  const headline = loadHeadline({
    verdict: evaluation.verdict,
    cfg,
    evaluation,
    totalRequests: total,
    p95Ms: n?.latencyMs.p95 ?? 0,
    serverErrorRate,
    maxSustainedRps: n?.maxSustainedRps ?? 0,
    targetName: meta.target.name,
    env: meta.environment.label,
  });

  return {
    meta,
    executive: {
      verdict: evaluation.verdict,
      decision: decisionFor(evaluation.verdict),
      headline,
      summary: `${describeFindings(findings)}${meta.environment.isReal ? '' : ' Note: this evidence comes from the simulator, so it demonstrates the tests, not the vendor’s service.'}`,
      keyNumbers: n
        ? keyNumbers({
            totalRequests: total,
            serverErrorRate,
            p95Ms: n.latencyMs.p95,
            p99Ms: n.latencyMs.p99,
            achievedAvgRps: n.achievedAvgRps,
            peakRps: n.peakRps,
            fanout: cfg.fanout,
          })
        : [],
      topRisks: findings.filter((f) => !f.advisory).slice(0, 3),
    },
    tested: {
      scenario: describeScenario(cfg, pack?.title ?? null, meta.target.name),
      shape: describeShape(cfg),
      profile: cfg.profile,
      planName: plan?.name ?? 'Unnamed plan',
      packId: cfg.packId ?? null,
      dataSet: dataSet ? { name: dataSet.name, records: dataSet.recordCount } : null,
      stages,
      slo,
      flags,
      window: {
        queuedAt: run.queuedAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        seconds,
      },
    },
    results: {
      slo: evaluation.checks,
      verdictReason: evaluation.reason,
      latency: {
        avgMs: run.summary?.latencyMs.avg ?? 0,
        p50Ms: run.summary?.latencyMs.p50 ?? 0,
        p90Ms: run.summary?.latencyMs.p90 ?? 0,
        p95Ms: run.summary?.latencyMs.p95 ?? 0,
        p99Ms: run.summary?.latencyMs.p99 ?? 0,
        maxMs: run.summary?.latencyMs.max ?? 0,
      },
      throughput: {
        totalRequests: total,
        expectedRequests: evaluation.expectedRequests,
        achievedAvgRps: n?.achievedAvgRps ?? 0,
        peakRps: n?.peakRps ?? 0,
        maxSustainedRps: n?.maxSustainedRps ?? 0,
      },
      errors: {
        classes: (run.summary?.errorClasses as unknown as Record<string, number>) ?? {},
        statusCounts: run.summary?.statusCounts ?? {},
        plain: run.summary
          ? errorsPlain(run.summary.errorClasses, total)
          : 'No requests were recorded.',
      },
      series: metricRows.map((m) => ({
        at: m.bucketStart,
        requests: m.requests,
        failures: m.failures,
        rps: m.rps,
        p50Ms: m.p50Ms,
        p95Ms: m.p95Ms,
        p99Ms: m.p99Ms,
        maxMs: m.maxMs,
        statusCounts: m.statusCounts,
      })),
    },
    moneySafety: correctnessRun ? digest(correctnessRun, now) : null,
    security: securityRun ? digest(securityRun, now) : null,
    findings,
    trend,
    logs: {
      timeline: dedupedTimeline,
      runConfig: run.snapshot.config,
      reproduce: [
        `POST /api/v1/load-tests/plans/${run.planId}/runs   — re-run this exact plan`,
        `GET  /api/v1/load-tests/runs/${run.id}/metrics     — the 5-second time series`,
        `GET  /api/v1/load-tests/runs/${run.id}/report?format=xlsx   — this report as a workbook`,
      ],
      generator: {
        saturated: run.summary?.generatorSaturated ?? false,
        droppedIterations: run.summary?.droppedIterations ?? 0,
        k6Version: run.k6Version,
      },
      finishedReason: run.finishedReason,
      error: run.error,
    },
    readiness: readyCtx.readiness,
    glossary: GLOSSARY,
  };
}

/* ── correctness / security suite report ───────────────────────────────── */

export async function buildSuiteReport(
  suiteRunId: string,
  now: Date = new Date(),
): Promise<SuiteReport> {
  const run = await suites.getCorrectnessRun(suiteRunId);
  if (!run) throw new NotFoundError('Suite run not found');
  const label = run.suite === 'security' ? 'Security (OWASP API Top 10)' : 'Money correctness';
  const meta = await metaFor(
    run.suite,
    run.id,
    `${label} run`,
    run.apiId,
    run.effectiveClass,
    run.requestedBy,
  );
  const results: CheckResult[] = run.results ?? [];
  const verdict = suiteVerdict(run);
  const findings = sortFindings(findingsFromSuite(results, run.suite));
  const s = run.summary;

  const checks: ReportCheck[] = results.map((r) => ({
    id: r.id,
    title: r.title,
    owasp: r.owasp ?? null,
    controls: r.controls,
    status: r.status,
    whyItMatters:
      r.controls.map((c) => CONTROL_INFO[c]).find(Boolean)?.impact ??
      'A protection the programme expects.',
    assertions: r.assertions.map((a) => ({
      name: a.name,
      pass: a.pass,
      detail: a.detail ?? null,
      advisory: a.advisory ?? false,
    })),
    warnings: r.warnings,
    durationMs: r.durationMs,
    evidenceCount: r.evidence.length,
    note: r.note ?? null,
  }));

  const timeline = await auditTimeline('load_test_correctness_run', run.id);
  const readyCtx = await readinessFor(run.apiId, now);
  const d = digest(run, now);
  const total = s?.total ?? results.length;

  return {
    meta,
    suite: run.suite,
    executive: {
      verdict,
      headline: d.headline,
      summary:
        verdict === 'PASS'
          ? `${run.suite === 'security' ? 'Every protection tested held.' : 'Every money-safety property held.'}${meta.environment.isReal ? '' : ' Note: this evidence comes from the simulator.'}`
          : verdict === 'FAIL'
            ? `${describeFindings(findings)} Fix these before relying on the service for real payments.`
            : 'The run did not complete, so it proves nothing either way.',
      keyNumbers: [
        {
          label: 'Checks passed',
          value: `${s?.passed ?? 0} / ${total}`,
          caption: 'Each check proves one protection holds.',
        },
        {
          label: 'Checks failed',
          value: String((s?.failed ?? 0) + (s?.errored ?? 0)),
          caption: 'A failed check is a defect to fix.',
        },
        {
          label: 'Hardening suggestions',
          value: String(s?.warnings ?? 0),
          caption: 'Advisory items that do not change the verdict.',
        },
        {
          label: 'Could not run here',
          value: String(s?.skipped ?? 0),
          caption:
            'Skipped because the environment lacks a prerequisite — listed below, never hidden.',
        },
        {
          label: 'Assertions',
          value: `${(s?.assertions.total ?? 0) - (s?.assertions.failed ?? 0)} / ${s?.assertions.total ?? 0}`,
          caption: 'Individual facts verified across all checks.',
        },
      ],
      topRisks: findings.filter((f) => !f.advisory).slice(0, 3),
    },
    checks,
    findings,
    coverageGaps: results
      .filter((r) => r.status === 'SKIPPED')
      .map((r) => ({ id: r.id, title: r.title, reason: r.note ?? 'Skipped.' })),
    evidence: results
      .flatMap((r) => r.evidence.map((e) => ({ ...e, checkId: r.id })))
      .slice(0, 3000),
    logs: {
      timeline,
      finishedReason: run.status === 'COMPLETED' ? 'completed' : run.status.toLowerCase(),
      error: run.error,
    },
    readiness: readyCtx.readiness,
    glossary: GLOSSARY,
  };
}

/* ── readiness report ──────────────────────────────────────────────────── */

export async function buildReadinessReport(
  apiId: string,
  now: Date = new Date(),
): Promise<ReadinessReport> {
  const target = await findTargetById(apiId);
  if (!target) throw new NotFoundError('Target not found');
  const ctx = await readinessFor(apiId, now);
  const meta = await metaFor(
    'readiness',
    apiId,
    'Production-readiness assessment',
    apiId,
    null,
    null,
  );
  const findings: Finding[] = [];
  for (const r of [ctx.correctness, ctx.security]) {
    if (r?.results) findings.push(...findingsFromSuite(r.results, r.suite));
  }
  const latestLoad = new Map<string, LoadEvidence>();
  for (const e of [...ctx.loadEvidence].sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))) {
    if (!latestLoad.has(e.profile)) latestLoad.set(e.profile, e);
  }
  const r = ctx.readiness;
  const headlineBy: Record<Readiness['status'], string> = {
    READY: `${target.name} is ready: every gate has passing evidence from the real service.`,
    READY_WITH_WARNINGS: `${target.name} is ready with conditions: the gates pass, but there are warnings to address.`,
    NOT_READY: `${target.name} is NOT ready: ${r.reasons[0] ?? 'a gate failed.'}`,
    INCOMPLETE: `${target.name}: readiness cannot be decided yet — ${r.reasons[0] ?? 'evidence is missing.'}`,
  };
  return {
    meta,
    readiness: r,
    headline: headlineBy[r.status],
    evidence: {
      load: [...latestLoad.values()].map((e) => ({
        id: e.id,
        profile: e.profile,
        verdict: e.verdict,
        finishedAt: e.finishedAt,
        environmentLabel: environmentLabel(e.environmentClass).label,
      })),
      correctness: ctx.correctness ? digest(ctx.correctness, now) : null,
      security: ctx.security ? digest(ctx.security, now) : null,
    },
    findings: sortFindings(findings).slice(0, 25),
    glossary: GLOSSARY,
  };
}

/* ── index ─────────────────────────────────────────────────────────────── */

export async function listReports(
  filter: { apiId?: string; limit?: number } = {},
  now: Date = new Date(),
): Promise<ReportIndexItem[]> {
  const limit = Math.min(filter.limit ?? 40, 100);
  const [loadRuns, suiteRuns] = await Promise.all([
    runs.listRuns({ apiId: filter.apiId, limit }),
    suites.listCorrectnessRuns({ apiId: filter.apiId, limit }),
  ]);
  const names = new Map<string, string>();
  const nameOf = async (id: string): Promise<string> => {
    if (!names.has(id)) names.set(id, (await findTargetById(id))?.name ?? 'Unknown target');
    return names.get(id)!;
  };
  const items: ReportIndexItem[] = [];
  for (const r of loadRuns) {
    const { cfg, evaluation } = evaluate(r);
    const env = environmentLabel(r.effectiveClass);
    const done = ['COMPLETED', 'ABORTED', 'FAILED'].includes(r.status);
    items.push({
      kind: 'load',
      id: r.id,
      title: `${cfg.profile} — ${packById(cfg.packId ?? '')?.title ?? `${cfg.method} ${cfg.path ?? ''}`.trim()}`,
      targetId: r.apiId,
      targetName: await nameOf(r.apiId),
      status: r.status,
      verdict: done ? evaluation.verdict : null,
      environmentLabel: env.label,
      isReal: env.isReal,
      finishedAt: r.finishedAt,
      queuedAt: r.queuedAt,
      headline: done ? evaluation.reason : `Run is ${r.status.toLowerCase()}.`,
    });
  }
  for (const r of suiteRuns) {
    const env = environmentLabel(r.effectiveClass);
    const done = ['COMPLETED', 'ABORTED', 'FAILED'].includes(r.status);
    items.push({
      kind: r.suite,
      id: r.id,
      title:
        r.suite === 'security' ? 'Security suite (OWASP API Top 10)' : 'Money-correctness suite',
      targetId: r.apiId,
      targetName: await nameOf(r.apiId),
      status: r.status,
      verdict: done ? suiteVerdict(r) : null,
      environmentLabel: env.label,
      isReal: env.isReal,
      finishedAt: r.finishedAt,
      queuedAt: r.queuedAt,
      headline: done ? digest(r, now).headline : `Run is ${r.status.toLowerCase()}.`,
    });
  }
  return items.sort((a, b) => b.queuedAt.localeCompare(a.queuedAt)).slice(0, limit);
}
