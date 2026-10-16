import { NotFoundError, ValidationError } from '../../lib/errors.js';
import * as runs from '../../repositories/load-test-runs.repo.js';
import type { DataSetSummary } from '../../repositories/load-test-data-sets.repo.js';
import type { AuditActor } from '../audit/audit.service.js';
import { createValidatedDataSet } from './data-set.service.js';
import { runSalt } from './run.service.js';

/**
 * Reference harvesting (B6). The k6 script derives every reference as
 * `LT-<run salt>-<iteration>`, so the references a finished run created can be
 * rebuilt exactly — no response capture needed. They feed the status-poll packs
 * (collection / payout / utility lookups) that need ids from an earlier run.
 */

export const HARVEST_MAX = 2000;

export interface HarvestPlan {
  references: string[];
  /** Iterations that may have been rejected by the target, so some lookups can 404. */
  caveat: string | null;
}

/** Pure: which references a run created. */
export function referencesFor(
  runId: string,
  iterations: number,
  limit: number,
  errorRate: number,
): HarvestPlan {
  const count = Math.max(0, Math.min(iterations, limit, HARVEST_MAX));
  const salt = runSalt(runId);
  const references = Array.from({ length: count }, (_, n) => `LT-${salt}-${n}`);
  const caveat =
    errorRate > 0.01
      ? `${(errorRate * 100).toFixed(1)}% of that run's requests failed, so some of these references were never created and may return 404 when polled.`
      : null;
  return { references, caveat };
}

const isRefTemplate = (body: unknown): boolean =>
  typeof body === 'object' &&
  body !== null &&
  !Array.isArray(body) &&
  (body as Record<string, unknown>)['reference'] === '{{ref}}';

export async function harvestReferences(
  runId: string,
  limit: number,
  actor: AuditActor,
): Promise<DataSetSummary & { caveat: string | null }> {
  const run = await runs.getRun(runId);
  if (!run) throw new NotFoundError('Run not found');
  if (!run.summary || !['COMPLETED', 'ABORTED'].includes(run.status)) {
    throw new ValidationError('Only a finished run with results can be harvested.');
  }
  const cfg = run.snapshot.config;
  if (cfg.method !== 'POST' || !isRefTemplate(cfg.body)) {
    throw new ValidationError(
      'This run did not create top-level references (its body has no `reference: {{ref}}`).',
    );
  }
  const iterations = Math.max(0, run.summary.totalRequests - run.summary.authRequests);
  const plan = referencesFor(run.id, iterations, limit, run.summary.errorRate);
  if (plan.references.length === 0) throw new ValidationError('The run created no references.');

  const environment = (run.effectiveClass ?? 'SANDBOX').toLowerCase();
  const created = await createValidatedDataSet(
    {
      name: `refs-${runSalt(run.id)}-${run.snapshot.target.name}`.slice(0, 200),
      environment,
      description: `References created by run ${run.id}${plan.caveat ? ` — ${plan.caveat}` : ''}`,
      records: plan.references.map((reference, n) => ({
        test_data: true,
        test_case_id: `HARVEST-${n}`,
        environment,
        reference,
      })),
    },
    actor,
  );
  return { ...created, caveat: plan.caveat };
}
