import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { componentLogger } from '../../lib/logger.js';
import { scrubPci } from '../../lib/pci.js';
import { findTargetById } from '../../repositories/monitored-apis.repo.js';
import { getKillSwitch } from '../../repositories/load-test-safety.repo.js';
import * as webhooks from '../../repositories/load-test-webhooks.repo.js';
import * as repo from '../../repositories/load-test-correctness.repo.js';
import type { SuiteKind } from '../../repositories/load-test-correctness.repo.js';
import { CHECKS, type Check } from '../../loadtest/correctness/checks.js';
import { SECURITY_CHECKS } from '../../loadtest/correctness/security.js';
import { runSuite } from '../../loadtest/correctness/suite.js';
import { recordAudit, type AuditActor } from '../audit/audit.service.js';
import { runPreflight } from './safety.service.js';
import { authSetup, runSalt } from './run.service.js';

const log = componentLogger('correctness');

export const SUITES: Record<SuiteKind, Check[]> = {
  correctness: CHECKS,
  security: SECURITY_CHECKS,
};

/**
 * A suite sends a few dozen REAL requests, so it is judged by the same safety
 * gate as load: classification, authorization, window, caps, kill switch. The
 * figures are each suite's PEAK concurrency — the security suite's rate-limit
 * probe is the burstiest (20 concurrent requests on a live target).
 */
const SUITE_PEAK: Record<SuiteKind, { rps: number; vus: number; durationSeconds: number }> = {
  correctness: { rps: 10, vus: 10, durationSeconds: 300 },
  security: { rps: 20, vus: 20, durationSeconds: 300 },
};

export async function queueCorrectnessRun(
  apiId: string,
  checks: string[] | undefined,
  actor: AuditActor,
  suite: SuiteKind = 'correctness',
): Promise<repo.CorrectnessRun> {
  const target = await findTargetById(apiId);
  if (!target) throw new NotFoundError('Target not found');
  const ids = SUITES[suite].map((c) => c.id);
  const unknown = (checks ?? []).filter((c) => !ids.includes(c));
  if (unknown.length > 0)
    throw new ValidationError(`Unknown ${suite} checks: ${unknown.join(', ')}`);

  const decision = await runPreflight(apiId, {
    ...SUITE_PEAK[suite],
    mutating: true,
    realSideEffects: false,
  });
  if (!decision.allowed) {
    throw new ValidationError(`${suite} run refused by the load-test safety gate`, {
      violations: decision.violations,
    });
  }
  const run = await repo.createCorrectnessRun({
    apiId,
    checks: checks ?? [],
    effectiveClass: decision.effectiveClass,
    requestedBy: actor.userId ?? null,
    suite,
  });
  await recordAudit({
    actor,
    action: `load_test.${suite}.queued`,
    entityType: 'load_test_correctness_run',
    entityId: run.id,
    summary: `${checks?.length ? checks.length : 'all'} ${suite} checks on ${target.name}`,
  });
  return run;
}

export async function executeCorrectnessRun(
  run: repo.CorrectnessRun,
  opts: { workerId: string },
): Promise<void> {
  const runLog = log.child({ correctnessRunId: run.id, apiId: run.apiId, suite: run.suite });
  const actor: AuditActor = { label: `system:loadtest-worker:${opts.workerId}` };
  try {
    const target = await findTargetById(run.apiId);
    if (!target) throw new Error('Target no longer exists.');
    const decision = await runPreflight(run.apiId, {
      ...SUITE_PEAK[run.suite],
      mutating: true,
      realSideEffects: false,
    });
    if (!decision.allowed) {
      const why = decision.violations.map((v) => v.code).join(', ');
      await repo.finishCorrectnessRun(run.id, 'ABORTED', null, null, `safety gate: ${why}`);
      runLog.warn({ violations: decision.violations }, 'run refused at execution time');
      return;
    }

    const auth = await authSetup(run.apiId, decision.effectiveClass);
    if (auth.mode !== 'form') {
      throw new Error(
        'These suites speak the iSmartPay contract and need an OAUTH2 target with tokenMode "form".',
      );
    }
    const origin = new URL(target.url).origin;
    const simulator = decision.effectiveClass === 'MOCK';
    await repo.markCorrectnessRunning(run.id, simulator ? 'simulator' : 'live');
    await recordAudit({
      actor,
      action: `load_test.${run.suite}.started`,
      entityType: 'load_test_correctness_run',
      entityId: run.id,
      summary: `${simulator ? 'simulator' : 'live'} on ${target.name} (${decision.effectiveClass})`,
    });

    const clientBase = {
      baseUrl: origin,
      tokenUrl: auth.env['LT_TOKEN_URL']!,
      ...(auth.env['LT_TOKEN_RESOURCE'] ? { resource: auth.env['LT_TOKEN_RESOURCE'] } : {}),
    };
    // Live runs: if a receiver able to verify signatures exists, let the webhook check look at it.
    const sink = simulator ? null : await webhooks.findUsableSink(run.apiId);
    const liveWebhook = sink
      ? {
          label: sink.label,
          deliveriesFor: async (reference: string) =>
            (await webhooks.deliveriesForReference(sink.id, reference)).map((d) => ({
              eventId: d.eventId,
              envelopeId: d.envelopeId,
              eventType: d.eventType,
              eventStatus: d.eventStatus,
              attempt: d.attempt,
              signatureOk: d.signatureOk,
              reason: d.reason,
              respondedWith: d.respondedWith,
            })),
        }
      : undefined;
    const report = await runSuite({
      liveWebhook,
      client: {
        ...clientBase,
        clientId: auth.env['LT_TOKEN_USER']!,
        clientSecret: auth.env['LT_TOKEN_PASS']!,
      },
      secondClient:
        auth.env['LT_TOKEN_USER_B'] && auth.env['LT_TOKEN_PASS_B']
          ? {
              ...clientBase,
              clientId: auth.env['LT_TOKEN_USER_B'],
              clientSecret: auth.env['LT_TOKEN_PASS_B'],
            }
          : undefined,
      simBaseUrl: simulator ? origin : undefined,
      pool: SUITES[run.suite],
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
      {
        verdict: report.summary.verdict,
        failed: report.summary.failed,
        warnings: report.summary.warnings,
      },
      'run finished',
    );
  } catch (err) {
    runLog.error({ err }, 'run failed');
    const message = scrubPci(err instanceof Error ? err.message : String(err)).slice(0, 1500);
    await repo.finishCorrectnessRun(run.id, 'FAILED', null, null, message).catch(() => undefined);
  } finally {
    await recordAudit({
      actor,
      action: `load_test.${run.suite}.finished`,
      entityType: 'load_test_correctness_run',
      entityId: run.id,
    }).catch(() => undefined);
  }
}
