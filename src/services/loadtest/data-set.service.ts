import { env } from '../../config/index.js';
import { AppError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { validateDataSet } from '../../domain/load-test-data.js';
import {
  createDataSet,
  deleteDataSet,
  getDataSet,
  plansUsingDataSet,
  type DataSetSummary,
} from '../../repositories/load-test-data-sets.repo.js';
import { recordAudit, type AuditActor } from '../audit/audit.service.js';

const approvedFixtures = (): string[] =>
  env()
    .LOAD_TEST_APPROVED_CARD_FIXTURES.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Stores a data set ONLY if it satisfies iSmartPay's test-data rules. A set that
 * fails is never persisted, and the violations never echo the offending values.
 */
export async function createValidatedDataSet(
  input: {
    name: string;
    environment: string;
    description?: string | undefined;
    records: unknown[];
  },
  actor: AuditActor,
): Promise<DataSetSummary> {
  const result = validateDataSet(
    { name: input.name, environment: input.environment, records: input.records },
    { approvedCardFixtures: approvedFixtures() },
  );
  if (!result.valid) {
    throw new ValidationError('Data set violates the test-data rules', {
      violations: result.violations,
    });
  }
  const created = await createDataSet({
    name: input.name,
    environment: input.environment.toLowerCase(),
    records: input.records as Record<string, unknown>[],
    description: input.description,
    createdBy: actor.userId ?? null,
  });
  await recordAudit({
    actor,
    action: 'load_test.data_set.created',
    entityType: 'load_test_data_set',
    entityId: created.id,
    summary: `${created.name} (${created.recordCount} records)`,
  });
  return created;
}

export async function removeDataSet(id: string, actor: AuditActor): Promise<void> {
  const ds = await getDataSet(id);
  if (!ds) throw new NotFoundError('Data set not found');
  const used = await plansUsingDataSet(id);
  if (used > 0) {
    throw new AppError(`Data set is used by ${used} plan(s); delete those first.`, {
      statusCode: 409,
      code: 'CONFLICT',
    });
  }
  await deleteDataSet(id);
  await recordAudit({
    actor,
    action: 'load_test.data_set.deleted',
    entityType: 'load_test_data_set',
    entityId: id,
    summary: ds.name,
  });
}
