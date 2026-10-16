import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../../config/index.js';
import { AppError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { componentLogger } from '../../lib/logger.js';
import { scrubPci } from '../../lib/pci.js';
import { substituteUuid } from '../../lib/templating.js';
import { decryptCredentials } from '../../lib/crypto/credential-cipher.js';
import {
  findTargetById,
  findTargetCredentialEnvelope,
} from '../../repositories/monitored-apis.repo.js';
import {
  createMaintenanceWindow,
  deleteMaintenanceWindow,
} from '../../repositories/maintenance-windows.repo.js';
import {
  findRelevantAuthorization,
  getKillSwitch,
} from '../../repositories/load-test-safety.repo.js';
import * as repo from '../../repositories/load-test-runs.repo.js';
import { getDataSet } from '../../repositories/load-test-data-sets.repo.js';
import {
  dataFieldsUsed,
  effectiveRps,
  isStateChanging,
  peakRps,
  PlanConfigSchema,
  type PlanConfig,
} from '../../domain/load-plan.js';
import type { LoadEnvironmentClass } from '../../domain/enums.js';
import { recordAudit, type AuditActor } from '../audit/audit.service.js';
import { assertHostAllowedForClass, runPreflight } from './safety.service.js';
import { renderK6Script, type AuthMode } from './k6-script.js';
import { k6Version, startK6 } from './k6-process.js';
import { BUCKET_MS, RunAggregator, type GuardrailKind } from './metrics-aggregator.js';
import type { LoadRun, LoadPlan } from '../../repositories/load-test-runs.repo.js';

const log = componentLogger('loadtest');
const SYSTEM_ACTOR = (workerId: string): AuditActor => ({
  label: `system:loadtest-worker:${workerId}`,
});

/* ── Plans ─────────────────────────────────────────────────────────────── */

export async function createPlan(
  input: { apiId: string; name: string; config?: unknown },
  actor: AuditActor,
): Promise<LoadPlan & { peakRps: number; effectiveRps: number }> {
  const config = PlanConfigSchema.parse(input.config);
  const target = await findTargetById(input.apiId);
  if (!target) throw new NotFoundError('Target not found');

  // {{data.*}} requires a data set that actually carries every referenced field.
  const needed = dataFieldsUsed(config);
  if (needed.length > 0 && !config.dataSetId) {
    throw new ValidationError(`Plan uses {{data.*}} (${needed.join(', ')}) but has no dataSetId.`);
  }
  if (config.dataSetId) {
    const ds = await getDataSet(config.dataSetId);
    if (!ds) throw new ValidationError('dataSetId does not exist.');
    const missing = needed.filter((f) => !ds.fields.includes(f));
    if (missing.length > 0) {
      throw new ValidationError(
        `Data set "${ds.name}" is missing fields used by the plan: ${missing.join(', ')}.`,
      );
    }
  }

  const plan = await repo.createPlan({
    apiId: input.apiId,
    name: input.name,
    config,
    createdBy: actor.userId ?? null,
  });
  await recordAudit({
    actor,
    action: 'load_test.plan.created',
    entityType: 'load_test_plan',
    entityId: plan.id,
    summary: `${config.profile} ${config.method} ${config.path ?? ''} on ${target.name}`,
  });
  return { ...plan, peakRps: peakRps(config), effectiveRps: effectiveRps(config) };
}

/* ── Queueing ──────────────────────────────────────────────────────────── */

/**
 * Judges the plan's *effective peak* (a SPIKE peaks far above `targetRps`, and a
 * payout batch multiplies each request by its fan-out) against the safety gate
 * and, only if allowed, queues the run. The worker re-checks at execution time.
 */
export async function queueRun(planId: string, actor: AuditActor): Promise<LoadRun> {
  const plan = await repo.getPlan(planId);
  if (!plan) throw new NotFoundError('Plan not found');
  const target = await findTargetById(plan.apiId);
  if (!target) throw new NotFoundError('Target not found');
  const cfg = PlanConfigSchema.parse(plan.config);
  const effective = effectiveRps(cfg);

  const decision = await runPreflight(plan.apiId, {
    rps: effective,
    vus: cfg.maxVus,
    durationSeconds: cfg.durationSeconds,
    mutating: isStateChanging(cfg) || target.isMoneyMoving,
    realSideEffects: cfg.realSideEffects,
  });
  if (!decision.allowed) {
    throw new ValidationError('Run refused by the load-test safety gate', {
      violations: decision.violations,
    });
  }
  const run = await repo.createRun({
    plan,
    snapshot: {
      config: cfg,
      target: {
        name: target.name,
        url: target.url,
        isMoneyMoving: target.isMoneyMoving,
        environment: target.environment,
      },
      peakRps: peakRps(cfg),
    },
    effectiveClass: decision.effectiveClass,
    requestedBy: actor.userId ?? null,
  });
  await recordAudit({
    actor,
    action: 'load_test.run.queued',
    entityType: 'load_test_run',
    entityId: run.id,
    summary: `${cfg.profile} peak ${effective} effects/s for ${cfg.durationSeconds}s on ${target.name}`,
  });
  return run;
}

export async function abortRun(id: string, reason: string, actor: AuditActor): Promise<LoadRun> {
  const run = await repo.requestAbort(id, reason);
  if (!run) {
    throw new AppError('Run not found or already finished.', { statusCode: 409, code: 'CONFLICT' });
  }
  await recordAudit({
    actor,
    action: 'load_test.run.abort_requested',
    entityType: 'load_test_run',
    entityId: id,
    summary: reason,
  });
  return run;
}

/* ── Execution helpers (worker side) ───────────────────────────────────── */

const SECRET_REF = /^\{\{secret:([A-Za-z0-9_.-]+)\}\}$/;
const secretEnvName = (name: string): string => `LT_SECRET_${name.replace(/[^A-Za-z0-9_]/g, '_')}`;

/**
 * Replaces `{{secret:NAME}}` with the worker's `LT_SECRET_NAME` environment
 * variable. Secrets therefore live only on the worker host: never in the
 * database, the plan, the script, or a log line.
 */
export function resolveSecrets<T>(value: T, source: NodeJS.ProcessEnv = process.env): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const m = SECRET_REF.exec(v);
      if (!m) return v;
      const resolved = source[secretEnvName(m[1]!)];
      if (resolved === undefined || resolved === '') {
        throw new Error(
          `Secret "${m[1]}" is not set on the worker (expected ${secretEnvName(m[1]!)}).`,
        );
      }
      return resolved;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}

export interface AuthSetup {
  mode: AuthMode;
  env: Record<string, string>;
}

/**
 * Env vars that give k6 the target's token handshake. The secret never touches
 * the script or argv, and the token URL must pass the host allow-list for the
 * run's class before any credential is sent to it.
 */
export async function authSetup(
  apiId: string,
  cls: LoadEnvironmentClass | null,
): Promise<AuthSetup> {
  const target = await findTargetById(apiId);
  if (!target || target.authenticationType === 'NONE') return { mode: 'none', env: {} };
  if (target.authenticationType !== 'OAUTH2') {
    throw new Error(
      `Auth type ${target.authenticationType} is not supported by the load runner yet (use OAUTH2 or NONE).`,
    );
  }
  const envelope = await findTargetCredentialEnvelope(apiId);
  if (!envelope) throw new Error('Target is OAUTH2 but has no stored credentials.');
  const c = decryptCredentials(envelope);
  const { tokenUrl, tokenUsername, tokenPassword } = c;
  if (!tokenUrl || !tokenUsername || !tokenPassword) {
    throw new Error('Stored OAuth2 credentials are incomplete.');
  }
  assertHostAllowedForClass(tokenUrl, cls);
  const mode: AuthMode = c['tokenMode'] === 'form' ? 'form' : 'basic';
  return {
    mode,
    env: {
      LT_TOKEN_URL: tokenUrl,
      LT_TOKEN_USER: tokenUsername,
      LT_TOKEN_PASS: tokenPassword,
      LT_TOKEN_RESOURCE: c['tokenResource'] ?? 'ismartpay',
      // Optional credential for a DIFFERENT account — enables the cross-account (BOLA) checks.
      ...(c['tokenUsernameB'] && c['tokenPasswordB']
        ? { LT_TOKEN_USER_B: c['tokenUsernameB'], LT_TOKEN_PASS_B: c['tokenPasswordB'] }
        : {}),
      LT_TOKEN_BODY: substituteUuid(c['tokenBody'] ?? '{}', randomUUID()),
    },
  };
}

/** Why a running run must stop right now, or null. Checked every couple of seconds. */
export async function controlReason(run: LoadRun, now: Date = new Date()): Promise<string | null> {
  const hb = await repo.heartbeat(run.id);
  if (hb.abortRequested) return `abort requested: ${hb.abortReason ?? 'no reason given'}`;
  const kill = await getKillSwitch();
  if (kill.engaged) return `kill switch engaged: ${kill.reason ?? ''}`.trim();
  if (run.effectiveClass !== 'MOCK') {
    const a = await findRelevantAuthorization(run.apiId, now);
    if (!a || a.status !== 'APPROVED') return 'authorization is no longer approved';
    if (a.windowEnd <= now) return 'authorization window ended';
  }
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Short, run-unique token for references/keys (iSmartPay references are unique FOREVER). */
export const runSalt = (runId: string): string => runId.replace(/-/g, '').slice(0, 8);

export interface ExecuteOptions {
  workerId: string;
  /** Override for tests; defaults to env. */
  k6Bin?: string;
}

/** Runs one claimed run to a terminal state. Never throws; always cleans up. */
export async function executeRun(run: LoadRun, opts: ExecuteOptions): Promise<void> {
  const e = env();
  const bin = opts.k6Bin ?? e.LOAD_TEST_K6_BIN;
  const cfg: PlanConfig = PlanConfigSchema.parse(run.snapshot.config);
  const runLog = log.child({ runId: run.id, apiId: run.apiId });
  let dir: string | null = null;
  let windowId: string | null = null;
  const agg = new RunAggregator();

  try {
    // 1. Fresh safety verdict at the moment of execution, not queue time.
    const target = await findTargetById(run.apiId);
    if (!target) throw new Error('Target no longer exists.');
    const decision = await runPreflight(run.apiId, {
      rps: effectiveRps(cfg),
      vus: cfg.maxVus,
      durationSeconds: cfg.durationSeconds,
      mutating: isStateChanging(cfg) || target.isMoneyMoving,
      realSideEffects: cfg.realSideEffects,
    });
    if (!decision.allowed) {
      const why = decision.violations.map((v) => v.code).join(', ');
      await repo.finishRun(run.id, 'ABORTED', `safety gate: ${why}`, null, null);
      runLog.warn({ violations: decision.violations }, 'run refused at execution time');
      return;
    }

    // 2. Prepare: script, data, credentials, monitor isolation.
    const version = await k6Version(bin);
    const auth = await authSetup(run.apiId, decision.effectiveClass);
    dir = await mkdtemp(join(tmpdir(), `lt-${run.id.slice(0, 8)}-`));

    let hasData = false;
    if (cfg.dataSetId) {
      const ds = await getDataSet(cfg.dataSetId);
      if (!ds) throw new Error('The plan’s data set no longer exists.');
      await writeFile(join(dir, 'data.json'), JSON.stringify(resolveSecrets(ds.records)), {
        mode: 0o600,
      });
      hasData = true;
    }
    // Origin always comes from the target; the plan only supplies a path.
    const origin = new URL(run.snapshot.target.url).origin;
    const url = cfg.path ? `${origin}${cfg.path}` : run.snapshot.target.url;
    const scriptPath = join(dir, 'script.js');
    await writeFile(scriptPath, renderK6Script({ plan: cfg, url, auth: auth.mode, hasData }), {
      mode: 0o600,
    });

    const window = await createMaintenanceWindow({
      targetId: run.apiId,
      startsAt: new Date(),
      endsAt: new Date(Date.now() + (cfg.durationSeconds + 180) * 1000),
      reason: `Load test run ${run.id}`,
      ticketRef: run.id,
      createdBy: run.requestedBy,
    });
    windowId = window.id;
    await repo.markRunning(run.id, version, windowId);
    await recordAudit({
      actor: SYSTEM_ACTOR(opts.workerId),
      action: 'load_test.run.started',
      entityType: 'load_test_run',
      entityId: run.id,
      summary: `${cfg.profile} on ${run.snapshot.target.name} (${decision.effectiveClass})`,
    });

    // 3. Run k6, feeding the aggregator from its JSON stream.
    const k6 = startK6({
      bin,
      scriptPath,
      env: { ...auth.env, LT_RUN_SALT: runSalt(run.id) },
      onLine: (l) => void agg.feed(l),
    });

    let stopReason: string | null = null;
    let guardrailTrip: { kind: GuardrailKind; message: string } | null = null;
    let finished = false;
    void k6.done.finally(() => (finished = true));
    const hardDeadline = Date.now() + (cfg.durationSeconds + 90) * 1000;
    const guard = {
      windowSeconds: e.LOAD_TEST_GUARDRAIL_WINDOW_SECONDS,
      maxErrorRate: e.LOAD_TEST_GUARDRAIL_ERROR_RATE,
      minSamples: e.LOAD_TEST_GUARDRAIL_MIN_SAMPLES,
      maxRefusalRate: e.LOAD_TEST_GUARDRAIL_REFUSAL_RATE,
      maxRateLimitedRate: e.LOAD_TEST_GUARDRAIL_RATE_LIMITED_RATE,
    };
    const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

    for (let tick = 1; !finished; tick++) {
      await sleep(1000);
      const now = Date.now();
      if (!stopReason && !guardrailTrip) {
        const g = agg.guardrail(now, guard);
        if (g.breach && g.kind) {
          const message =
            g.kind === 'auth_refused'
              ? `${pct(g.refusalRate)} of ${g.total} requests were refused with 401/403 (bad or expired key, or a limit/suspension)`
              : g.kind === 'rate_limited'
                ? `${pct(g.rateLimitedRate)} of ${g.total} requests were rate limited (429)`
                : `server failure rate ${pct(g.errorRate)} over ${g.total} requests in ${guard.windowSeconds}s exceeded ${pct(guard.maxErrorRate)}`;
          guardrailTrip = { kind: g.kind, message };
          runLog.warn({ guardrailTrip }, 'guardrail tripped; stopping k6');
          k6.abort();
        } else if (tick % 2 === 0) {
          stopReason = await controlReason(run);
          if (stopReason) {
            runLog.warn({ stopReason }, 'control stop; stopping k6');
            k6.abort();
          }
        }
        if (!stopReason && !guardrailTrip && now > hardDeadline) {
          stopReason = 'hard deadline exceeded';
          k6.abort();
        }
      }
      if (tick % 5 === 0) await repo.insertMetrics(run.id, agg.drain(now - BUCKET_MS));
    }

    const result = await k6.done;
    await repo.insertMetrics(run.id, agg.drain(Infinity));
    const summary = agg.summary();

    // 4. Terminal state. Hitting the target's limit is a *finding* for
    // BREAKPOINT/STRESS; an auth-refusal flood always invalidates the run.
    const limitFinding = cfg.profile === 'BREAKPOINT' || cfg.profile === 'STRESS';
    if (stopReason) {
      await repo.finishRun(run.id, 'ABORTED', stopReason, summary, null);
    } else if (guardrailTrip) {
      if (limitFinding && guardrailTrip.kind !== 'auth_refused') {
        await repo.finishRun(
          run.id,
          'COMPLETED',
          `limit reached: ${guardrailTrip.message}`,
          summary,
          null,
        );
      } else {
        await repo.finishRun(
          run.id,
          'ABORTED',
          `guardrail: ${guardrailTrip.message}`,
          summary,
          null,
        );
      }
    } else if (result.exitCode === 0) {
      await repo.finishRun(run.id, 'COMPLETED', 'completed', summary, null);
    } else {
      const tail = scrubPci(result.stderrTail).slice(-1500);
      await repo.finishRun(
        run.id,
        'FAILED',
        `k6 exited with code ${String(result.exitCode)}`,
        summary,
        tail,
      );
    }
    runLog.info({ requests: summary.totalRequests, errorRate: summary.errorRate }, 'run finished');
  } catch (err) {
    runLog.error({ err }, 'run failed');
    const message = scrubPci(err instanceof Error ? err.message : String(err)).slice(0, 1500);
    try {
      await repo.insertMetrics(run.id, agg.drain(Infinity));
      await repo.finishRun(run.id, 'FAILED', 'runner error', agg.summary(), message);
    } catch (inner) {
      runLog.error({ err: inner }, 'could not record failure');
    }
  } finally {
    if (windowId) await deleteMaintenanceWindow(windowId).catch(() => undefined);
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await recordAudit({
      actor: SYSTEM_ACTOR(opts.workerId),
      action: 'load_test.run.finished',
      entityType: 'load_test_run',
      entityId: run.id,
    }).catch(() => undefined);
  }
}
