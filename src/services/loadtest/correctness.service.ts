import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { componentLogger } from '../../lib/logger.js';
import { scrubPci } from '../../lib/pci.js';
import { findTargetById } from '../../repositories/monitored-apis.repo.js';
import { getKillSwitch } from '../../repositories/load-test-safety.repo.js';
import * as repo from '../../repositories/load-test-correctness.repo.js';
import { CHECK_IDS } from '../../loadtest/correctness/checks.js';
import { runSuite } from '../../loadtest/correctness/suite.js';
import { recordAudit, type AuditActor } from '../audit/audit.service.js';
import { runPreflight } from './safety.service.js';
import { authSetup, runSalt } from './run.service.js';

const log = componentLogger('correctness');

/**
 * A correctness suite sends a few dozen REAL requests (10 concurrent at most),
 * so it is judged by the same safety gate as load: classification,
 * authorization, window, caps, kill switch. The figures below are its peak.
 */
const SUITE_PEAK = { rps: 10, vus: 10, durationSeconds: 300 } as const;

export async function queueCorrectnessRun(
  apiId: string,
  checks: string[] | undefined,
  actor: AuditActor,
): Promise<repo.CorrectnessRun> {
  const target = await findTargetById(apiId);
  if (!target) throw new NotFoundError('Target not found');
  const unknown = (checks ?? []).filter((c) => !CHECK_IDS.includes(c));
  if (unknown.length > 0) throw new ValidationError(`Unknown checks: ${unknown.join(', ')}`);

  const decision = await runPreflight(apiId, {
    ...SUITE_PEAK,
    mutating: true,
    realSideEffects: false,
  });
  if (!decision.allowed) {
    throw new ValidationError('Correctness run refused by the load-test safety gate', {
      violations: decision.violations,
    });
  }
  const run = await repo.createCorrectnessRun({
    apiId,
    checks: checks ?? [],
    effectiveClass: decision.effectiveClass,
    requestedBy: actor.userId ?? null,
  });
  await recordAudit({
    actor,
    action: 'load_test.correctness.queued',
    entityType: 'load_test_correctness_run',
    entityId: run.id,
    summary: `${checks?.length ? checks.length : 'all'} checks on ${target.name}`,
  });
  return run;
}

export async function executeCorrectnessRun(
  run: repo.CorrectnessRun,
  opts: { workerId: string },
): Promise<void> {
  const runLog = log.child({ correctnessRunId: run.id, apiId: run.apiId });
  const actor: AuditActor = { label: `system:loadtest-worker:${opts.workerId}` };
  try {
    const target = await findTargetById(run.apiId);
    if (!target) throw new Error('Target no longer exists.');
    const decision = await runPreflight(run.apiId, {
      ...SUITE_PEAK,
      mutating: true,
      realSideEffects: false,
    });
    if (!decision.allowed) {
      const why = decision.violations.map((v) => v.code).join(', ');
      await repo.finishCorrectnessRun(run.id, 'ABORTED', null, null, `safety gate: ${why}`);
      runLog.warn({ violations: decision.violations }, 'correctness run refused at execution time');
      return;
    }

    const auth = await authSetup(run.apiId, decision.effectiveClass);
    if (auth.mode !== 'form') {
      throw new Error(
        'The correctness suite speaks the iSmartPay contract and needs an OAUTH2 target with tokenMode "form".',
      );
    }
    const origin = new URL(target.url).origin;
    const simulator = decision.effectiveClass === 'MOCK';
    await repo.markCorrectnessRunning(run.id, simulator ? 'simulator' : 'live');
    await recordAudit({
      actor,
      action: 'load_test.correctness.started',
      entityType: 'load_test_correctness_run',
      entityId: run.id,
      summary: `${simulator ? 'simulator' : 'live'} on ${target.name} (${decision.effectiveClass})`,
    });

    const report = await runSuite({
      client: {
        baseUrl: origin,
        tokenUrl: auth.env['LT_TOKEN_URL']!,
        clientId: auth.env['LT_TOKEN_USER']!,
        clientSecret: auth.env['LT_TOKEN_PASS']!,
        ...(auth.env['LT_TOKEN_RESOURCE'] ? { resource: auth.env['LT_TOKEN_RESOURCE'] } : {}),
      },
      simBaseUrl: simulator ? origin : undefined,
      only: run.selectedChecks.length > 0 ? run.selectedChecks : undefined,
      salt: runSalt(run.id),
      shouldStop: async () => {
        await repo.correctnessHeartbeat(run.id);
        const kill = await getKillSwitch();
        return kill.engaged ? `kill switch engaged: ${kill.reason ?? ''}`.trim() : null;
      },
    });
    const stopped = report.results.some(
      (r) => r.status === 'SKIPPED' && r.note?.startsWith('suite stopped'),
    );
    await repo.finishCorrectnessRun(
      run.id,
      stopped ? 'ABORTED' : 'COMPLETED',
      report.results,
      report.summary,
      null,
    );
    runLog.info(
      { verdict: report.summary.verdict, failed: report.summary.failed },
      'correctness run finished',
    );
  } catch (err) {
    runLog.error({ err }, 'correctness run failed');
    const message = scrubPci(err instanceof Error ? err.message : String(err)).slice(0, 1500);
    await repo.finishCorrectnessRun(run.id, 'FAILED', null, null, message).catch(() => undefined);
  } finally {
    await recordAudit({
      actor,
      action: 'load_test.correctness.finished',
      entityType: 'load_test_correctness_run',
      entityId: run.id,
    }).catch(() => undefined);
  }
}
