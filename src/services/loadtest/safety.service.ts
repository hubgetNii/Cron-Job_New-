import { env } from '../../config/index.js';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { findTargetById } from '../../repositories/monitored-apis.repo.js';
import {
  createAuthorization,
  findRelevantAuthorization,
  getAuthorization,
  getKillSwitch,
  getTargetConfig,
  reviewAuthorization,
  revokeAuthorization,
  setKillSwitch,
  upsertTargetConfig,
  type LoadAuthorization,
  type LoadTargetConfig,
} from '../../repositories/load-test-safety.repo.js';
import {
  evaluateLoadSafety,
  hostOf,
  parseCeilings,
  parseHostList,
  type HostLists,
  type LoadCeilings,
  type SafetyDecision,
} from '../../domain/load-safety.js';
import type { LoadEnvironmentClass } from '../../domain/enums.js';
import { recordAudit, type AuditActor } from '../audit/audit.service.js';

export function loadHosts(): HostLists {
  const e = env();
  return {
    production: parseHostList(e.LOAD_TEST_PRODUCTION_HOSTS),
    sandbox: parseHostList(e.LOAD_TEST_SANDBOX_HOSTS),
    mock: parseHostList(e.LOAD_TEST_MOCK_HOSTS),
  };
}

export function loadCeilings(): LoadCeilings {
  return parseCeilings(env().LOAD_TEST_CEILINGS);
}

export interface PreflightPlan {
  rps: number;
  vus: number;
  durationSeconds: number;
  /** True when the plan sends any non-GET/HEAD request or declares money movement. */
  mutating: boolean;
  /** The plan itself declares real-world side effects (airtime delivered, real SMS, …). */
  realSideEffects?: boolean;
}

/** The single entry point every run must pass before any traffic is generated. */
export async function runPreflight(
  apiId: string,
  plan: PreflightPlan,
  now: Date = new Date(),
): Promise<SafetyDecision> {
  const target = await findTargetById(apiId);
  if (!target) throw new NotFoundError('Target not found');
  const [config, authorization, kill] = await Promise.all([
    getTargetConfig(apiId),
    findRelevantAuthorization(apiId, now),
    getKillSwitch(),
  ]);
  return evaluateLoadSafety({
    now,
    enabled: env().LOAD_TEST_ENABLED,
    killSwitch: kill.engaged,
    target: {
      url: target.url,
      isMoneyMoving: target.isMoneyMoving,
      environment: target.environment,
    },
    config: config
      ? { environmentClass: config.environmentClass, hasRealSideEffects: config.hasRealSideEffects }
      : null,
    authorization,
    plan,
    hosts: loadHosts(),
    ceilings: loadCeilings(),
    realSideEffectMaxRps: env().LOAD_TEST_REAL_SIDE_EFFECT_MAX_RPS,
  });
}

export async function setTargetConfig(
  apiId: string,
  environmentClass: LoadEnvironmentClass,
  hasRealSideEffects: boolean,
  actor: AuditActor,
): Promise<LoadTargetConfig> {
  const target = await findTargetById(apiId);
  if (!target) throw new NotFoundError('Target not found');
  const host = hostOf(target.url);
  const hosts = loadHosts();
  const productionLike =
    target.environment === 'production' || (host !== null && hosts.production.includes(host));
  if (productionLike && environmentClass !== 'PRODUCTION') {
    throw new ValidationError(
      'This target is production (by environment or host); it can only be classified PRODUCTION.',
    );
  }
  if (environmentClass === 'MOCK' && (host === null || !hosts.mock.includes(host))) {
    throw new ValidationError('MOCK is only valid for allow-listed simulator hosts.');
  }
  const before = await getTargetConfig(apiId);
  const saved = await upsertTargetConfig(
    apiId,
    environmentClass,
    hasRealSideEffects,
    actor.userId ?? null,
  );
  await recordAudit({
    actor,
    action: 'load_test.target_config.set',
    entityType: 'monitored_api',
    entityId: apiId,
    summary: `Load class ${environmentClass}, real side effects ${hasRealSideEffects}`,
    changes: { before, after: saved },
  });
  return saved;
}

export interface ProposeInput {
  apiId: string;
  reference: string;
  scope: string;
  windowStart: Date;
  windowEnd: Date;
  maxRps: number;
  maxVus: number;
  maxDurationSeconds: number;
  allowRealSideEffects: boolean;
}

export async function proposeAuthorization(
  input: ProposeInput,
  actor: AuditActor,
  now: Date = new Date(),
): Promise<LoadAuthorization> {
  if (!actor.userId) {
    throw new ForbiddenError('Load-test authorizations require an authenticated user.');
  }
  const target = await findTargetById(input.apiId);
  if (!target) throw new NotFoundError('Target not found');
  const config = await getTargetConfig(input.apiId);
  if (!config) {
    throw new ValidationError(
      'Classify the target (PUT …/config) before requesting authorization.',
    );
  }
  if (config.environmentClass === 'MOCK') {
    throw new ValidationError('The simulator needs no authorization.');
  }
  if (config.environmentClass === 'PRODUCTION' && target.isMoneyMoving) {
    throw new ValidationError('Money-moving load on PRODUCTION can never be authorized.');
  }
  if (input.windowEnd <= now) throw new ValidationError('Authorization window is already over.');
  const maxMs = env().LOAD_TEST_MAX_WINDOW_DAYS * 86_400_000;
  if (input.windowEnd.getTime() - input.windowStart.getTime() > maxMs) {
    throw new ValidationError(`Window may not exceed ${env().LOAD_TEST_MAX_WINDOW_DAYS} days.`);
  }
  if (input.allowRealSideEffects && !config.hasRealSideEffects) {
    throw new ValidationError('Target is not flagged as having real side effects.');
  }
  const ceiling = loadCeilings()[config.environmentClass];
  if (
    input.maxRps > ceiling.maxRps ||
    input.maxVus > ceiling.maxVus ||
    input.maxDurationSeconds > ceiling.maxDurationSeconds
  ) {
    throw new ValidationError(
      `Requested caps exceed the ${config.environmentClass} ceiling (${ceiling.maxRps} rps / ${ceiling.maxVus} vus / ${ceiling.maxDurationSeconds}s).`,
    );
  }
  const created = await createAuthorization({ ...input, proposedBy: actor.userId });
  await recordAudit({
    actor,
    action: 'load_test.authorization.proposed',
    entityType: 'load_test_authorization',
    entityId: created.id,
    summary: `Proposed ${config.environmentClass} load authorization (ref ${input.reference})`,
    changes: { after: { ...input } },
  });
  return created;
}

export async function reviewProposal(
  id: string,
  decision: 'APPROVED' | 'REJECTED',
  note: string | null,
  actor: AuditActor,
): Promise<LoadAuthorization> {
  if (!actor.userId) throw new ForbiddenError('Reviewing requires an authenticated user.');
  const current = await getAuthorization(id);
  if (!current) throw new NotFoundError('Authorization not found');
  if (current.proposedBy === actor.userId) {
    throw new ForbiddenError('Four-eyes: a different ADMIN must review this authorization.');
  }
  const updated = await reviewAuthorization(id, decision, actor.userId, note);
  if (!updated) {
    throw new AppError('Authorization is no longer pending.', {
      statusCode: 409,
      code: 'CONFLICT',
    });
  }
  await recordAudit({
    actor,
    action: `load_test.authorization.${decision.toLowerCase()}`,
    entityType: 'load_test_authorization',
    entityId: id,
    ...(note ? { summary: note } : {}),
  });
  return updated;
}

export async function revoke(
  id: string,
  reason: string,
  actor: AuditActor,
): Promise<LoadAuthorization> {
  const updated = await revokeAuthorization(id, reason);
  if (!updated) {
    throw new AppError('Authorization not found or already closed.', {
      statusCode: 409,
      code: 'CONFLICT',
    });
  }
  await recordAudit({
    actor,
    action: 'load_test.authorization.revoked',
    entityType: 'load_test_authorization',
    entityId: id,
    summary: reason,
  });
  return updated;
}

export async function engageKillSwitch(engaged: boolean, reason: string | null, actor: AuditActor) {
  const state = await setKillSwitch(engaged, reason, actor.userId ?? null);
  await recordAudit({
    actor,
    action: engaged ? 'load_test.kill_switch.engaged' : 'load_test.kill_switch.released',
    entityType: 'load_test_control',
    ...(reason ? { summary: reason } : {}),
  });
  return state;
}

/**
 * Credentials must only ever be sent to a host the class permits. The token
 * endpoint lives on the same host as the API per the docs, but the URL comes
 * from stored credentials, so it is checked against the same allow-lists.
 */
export function assertHostAllowedForClass(url: string, cls: LoadEnvironmentClass | null): void {
  const host = hostOf(url);
  const hosts = loadHosts();
  const allowed =
    cls === 'MOCK'
      ? hosts.mock
      : cls === 'PRODUCTION'
        ? hosts.production
        : cls
          ? hosts.sandbox
          : [];
  if (!host || !allowed.includes(host)) {
    throw new Error(
      `Refusing to send credentials to ${host ?? 'an unparseable URL'}: not on the ${cls ?? 'unclassified'} host allow-list.`,
    );
  }
}
