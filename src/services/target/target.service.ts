import { withTransaction } from '../../lib/db.js';
import { env } from '../../config/index.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { assertValidCron, InvalidCronError, intervalSeconds } from '../../lib/cron.js';
import { assertUrlAllowed, SsrfBlockedError } from '../../lib/ssrf.js';
import { encryptCredentials, type CredentialEnvelope } from '../../lib/crypto/credential-cipher.js';
import { DEFAULT_SEVERITY_BY_CLASS } from '../../domain/enums.js';
import {
  MONEY_MOVING_MIN_INTERVAL_SECONDS,
  type MonitoredApi,
  type RetryConfig,
  type ValidationRule,
} from '../../domain/target.js';
import {
  createTarget as createTargetRow,
  deleteTarget as deleteTargetRow,
  findTargetById,
  findTargetCredentialEnvelope,
  listTargets as listTargetRows,
  setTargetActive,
  updateTarget as updateTargetRow,
  type ListTargetFilters,
  type TargetWriteModel,
} from '../../repositories/monitored-apis.repo.js';
import { recordAudit, type AuditActor } from '../audit/audit.service.js';
import {
  createTargetSchema,
  updateTargetSchema,
  type CreateTargetPayload,
  type UpdateTargetPayload,
} from './target.validation.js';

const DEFAULT_SLA_TARGET_PERCENT = 99.95;
const DEFAULT_RETRY: RetryConfig = {
  count: 2,
  baseDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 5000,
};

interface PartialRetry {
  count?: number | undefined;
  baseDelayMs?: number | undefined;
  backoffMultiplier?: number | undefined;
  maxDelayMs?: number | undefined;
}

function mergeRetry(base: RetryConfig, patch: PartialRetry | undefined): RetryConfig {
  return {
    count: patch?.count ?? base.count,
    baseDelayMs: patch?.baseDelayMs ?? base.baseDelayMs,
    backoffMultiplier: patch?.backoffMultiplier ?? base.backoffMultiplier,
    maxDelayMs: patch?.maxDelayMs ?? base.maxDelayMs,
  };
}

interface CredentialDecision {
  /** undefined = leave as-is, null = clear, envelope = replace. */
  envelope: CredentialEnvelope | null | undefined;
}

function resolveCredentials(
  payloadCredentials: Record<string, string> | null | undefined,
): CredentialDecision {
  if (payloadCredentials === undefined) return { envelope: undefined };
  if (payloadCredentials === null) return { envelope: null };
  if (Object.keys(payloadCredentials).length === 0) return { envelope: null };
  return { envelope: encryptCredentials(payloadCredentials) };
}

/** Validates the cron expression and enforces the money-moving frequency floor. */
function assertScheduleAllowed(frequencyCron: string, isMoneyMoving: boolean): void {
  try {
    assertValidCron(frequencyCron);
  } catch (err) {
    if (err instanceof InvalidCronError) throw new ValidationError(err.message);
    throw err;
  }
  if (isMoneyMoving) {
    const seconds = intervalSeconds(frequencyCron);
    if (seconds > MONEY_MOVING_MIN_INTERVAL_SECONDS) {
      throw new ValidationError(
        `Money-moving targets must be checked at least every ${MONEY_MOVING_MIN_INTERVAL_SECONDS}s ` +
          `(spec Rule 16); "${frequencyCron}" runs every ${seconds}s.`,
      );
    }
  }
}

async function assertUrlAllowedOrThrow(url: string, allowPrivateNetwork: boolean): Promise<void> {
  try {
    await assertUrlAllowed(url, { allowPrivateNetwork });
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      throw new ValidationError(err.message, {
        hint: 'set allowPrivateNetwork=true to override (audited)',
      });
    }
    throw err;
  }
}

function buildCreateModel(payload: CreateTargetPayload): TargetWriteModel {
  const endpointClass = payload.endpointClass;
  return {
    name: payload.name,
    description: payload.description ?? null,
    environment: payload.environment ?? 'production',
    endpointClass,
    severityDefault: payload.severityDefault ?? DEFAULT_SEVERITY_BY_CLASS[endpointClass],
    isMoneyMoving: payload.isMoneyMoving ?? false,
    url: payload.url,
    method: payload.method ?? 'GET',
    authenticationType: payload.authenticationType ?? 'NONE',
    encryptedCredentials: resolveCredentials(payload.credentials).envelope ?? null,
    headers: payload.headers ?? {},
    requestBody: payload.requestBody,
    expectedStatus: payload.expectedStatus ?? null,
    expectedResponse: (payload.expectedResponse as ValidationRule | undefined) ?? null,
    timeoutMs: payload.timeoutMs ?? env().DEFAULT_CHECK_TIMEOUT_MS,
    frequencyCron: payload.frequencyCron,
    retry: mergeRetry(DEFAULT_RETRY, payload.retry),
    slaTargetPercent: payload.slaTargetPercent ?? DEFAULT_SLA_TARGET_PERCENT,
    ownerId: payload.ownerId ?? null,
    teamId: payload.teamId ?? null,
    escalationPolicyId: payload.escalationPolicyId ?? null,
    tags: payload.tags ?? [],
    isActive: payload.isActive ?? true,
    allowPrivateNetwork: payload.allowPrivateNetwork ?? false,
  };
}

function mergeUpdateModel(
  existing: MonitoredApi,
  existingEnvelope: CredentialEnvelope | null,
  payload: UpdateTargetPayload,
): TargetWriteModel {
  const credentialDecision = resolveCredentials(payload.credentials);
  const endpointClass = payload.endpointClass ?? existing.endpointClass;
  return {
    name: payload.name ?? existing.name,
    description:
      payload.description === undefined ? existing.description : (payload.description ?? null),
    environment: payload.environment ?? existing.environment,
    endpointClass,
    severityDefault: payload.severityDefault ?? existing.severityDefault,
    isMoneyMoving: payload.isMoneyMoving ?? existing.isMoneyMoving,
    url: payload.url ?? existing.url,
    method: payload.method ?? existing.method,
    authenticationType: payload.authenticationType ?? existing.authenticationType,
    encryptedCredentials:
      credentialDecision.envelope === undefined ? existingEnvelope : credentialDecision.envelope,
    headers: payload.headers ?? existing.headers,
    requestBody: payload.requestBody === undefined ? existing.requestBody : payload.requestBody,
    expectedStatus:
      payload.expectedStatus === undefined
        ? existing.expectedStatus
        : (payload.expectedStatus ?? null),
    expectedResponse:
      payload.expectedResponse === undefined
        ? existing.expectedResponse
        : ((payload.expectedResponse as ValidationRule | null | undefined) ?? null),
    timeoutMs: payload.timeoutMs ?? existing.timeoutMs,
    frequencyCron: payload.frequencyCron ?? existing.frequencyCron,
    retry: mergeRetry(existing.retry, payload.retry),
    slaTargetPercent: payload.slaTargetPercent ?? existing.slaTargetPercent,
    ownerId: payload.ownerId === undefined ? existing.ownerId : (payload.ownerId ?? null),
    teamId: payload.teamId === undefined ? existing.teamId : (payload.teamId ?? null),
    escalationPolicyId:
      payload.escalationPolicyId === undefined
        ? existing.escalationPolicyId
        : (payload.escalationPolicyId ?? null),
    tags: payload.tags ?? existing.tags,
    isActive: payload.isActive ?? existing.isActive,
    allowPrivateNetwork: payload.allowPrivateNetwork ?? existing.allowPrivateNetwork,
  };
}

export async function createTarget(input: unknown, actor: AuditActor): Promise<MonitoredApi> {
  const payload = createTargetSchema.parse(input);
  const model = buildCreateModel(payload);

  assertScheduleAllowed(model.frequencyCron, model.isMoneyMoving);
  await assertUrlAllowedOrThrow(model.url, model.allowPrivateNetwork);

  return withTransaction(async (client) => {
    const created = await createTargetRow(model, client);
    await recordAudit(
      {
        actor,
        action: 'target.created',
        entityType: 'monitored_api',
        entityId: created.id,
        summary: `Registered target "${created.name}" (${created.endpointClass}, ${created.environment})`,
        changes: { after: redact(created) },
      },
      client,
    );
    return created;
  });
}

export async function getTarget(id: string): Promise<MonitoredApi> {
  const target = await findTargetById(id);
  if (!target) throw new NotFoundError(`Target ${id} not found`);
  return target;
}

export function listTargets(filters: ListTargetFilters): Promise<MonitoredApi[]> {
  return listTargetRows(filters);
}

export async function updateTarget(
  id: string,
  input: unknown,
  actor: AuditActor,
): Promise<MonitoredApi> {
  const payload = updateTargetSchema.parse(input);
  const existing = await findTargetById(id);
  if (!existing) throw new NotFoundError(`Target ${id} not found`);
  const existingEnvelope = await findTargetCredentialEnvelope(id);
  const model = mergeUpdateModel(existing, existingEnvelope, payload);

  assertScheduleAllowed(model.frequencyCron, model.isMoneyMoving);
  await assertUrlAllowedOrThrow(model.url, model.allowPrivateNetwork);

  return withTransaction(async (client) => {
    const updated = await updateTargetRow(id, model, client);
    if (!updated) throw new NotFoundError(`Target ${id} not found`);
    await recordAudit(
      {
        actor,
        action: 'target.updated',
        entityType: 'monitored_api',
        entityId: id,
        summary: `Updated target "${updated.name}"`,
        changes: { before: redact(existing), after: redact(updated) },
      },
      client,
    );
    return updated;
  });
}

export async function setTargetEnabled(
  id: string,
  isActive: boolean,
  actor: AuditActor,
): Promise<MonitoredApi> {
  return withTransaction(async (client) => {
    const updated = await setTargetActive(id, isActive, client);
    if (!updated) throw new NotFoundError(`Target ${id} not found`);
    await recordAudit(
      {
        actor,
        action: isActive ? 'target.enabled' : 'target.disabled',
        entityType: 'monitored_api',
        entityId: id,
        summary: `${isActive ? 'Enabled' : 'Disabled'} monitoring for "${updated.name}"`,
      },
      client,
    );
    return updated;
  });
}

export async function deleteTarget(id: string, actor: AuditActor): Promise<void> {
  const existing = await findTargetById(id);
  if (!existing) throw new NotFoundError(`Target ${id} not found`);
  await withTransaction(async (client) => {
    await deleteTargetRow(id, client);
    await recordAudit(
      {
        actor,
        action: 'target.deleted',
        entityType: 'monitored_api',
        entityId: id,
        summary: `Deleted target "${existing.name}"`,
        changes: { before: redact(existing) },
      },
      client,
    );
  });
}

/** Strips fields that should never land in an audit payload. */
function redact(target: MonitoredApi): Record<string, unknown> {
  const { headers, ...rest } = target;
  const safeHeaders = Object.fromEntries(
    Object.keys(headers).map((k) => [
      k,
      /auth|key|secret|token|cookie/i.test(k) ? '[REDACTED]' : headers[k],
    ]),
  );
  return { ...rest, headers: safeHeaders };
}
