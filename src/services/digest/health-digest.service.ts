import { env } from '../../config/index.js';
import { componentLogger } from '../../lib/logger.js';
import { getTargetStatusBoard } from '../../repositories/dashboard.repo.js';
import {
  latestDigest,
  saveDigest,
  type AffectedService,
  type HealthDigest,
  type SystemHealthLevel,
} from '../../repositories/health-digests.repo.js';
import { channelFor } from '../alert/channels.js';

const log = componentLogger('health-digest');

export interface DigestSnapshot {
  overallLevel: SystemHealthLevel;
  previousLevel: SystemHealthLevel | null;
  totalServices: number;
  healthyServices: number;
  degradedServices: number;
  downServices: number;
  affected: AffectedService[];
  /** Whether Rule A (overall state change) says to send an SMS this run. */
  shouldSend: boolean;
  reason: string;
  message: string;
  nextCheckAt: Date;
}

const LEVEL_META: Record<SystemHealthLevel, { icon: string; word: string }> = {
  HEALTHY: { icon: '✅', word: 'HEALTHY' },
  DEGRADED: { icon: '⚠️', word: 'DEGRADED' },
  CRITICAL: { icon: '🔴', word: 'CRITICAL' },
};

/** A service counts as "attention needed" unless its last check was UP. */
function isHealthy(status: string | null): boolean {
  return status === 'UP';
}

/**
 * Rolls per-service status up to one system level:
 *  - CRITICAL  — a money-moving or CRITICAL-severity service is DOWN
 *  - DEGRADED  — any service is DOWN / DEGRADED / UNKNOWN, none critical
 *  - HEALTHY   — every checked service is UP
 */
export function rollUp(
  services: { status: string | null; isMoneyMoving: boolean; endpointClass: string }[],
): SystemHealthLevel {
  const anyCriticalDown = services.some(
    (s) => s.status === 'DOWN' && (s.isMoneyMoving || s.endpointClass === 'payment_status'),
  );
  if (anyCriticalDown) return 'CRITICAL';
  const anyAttention = services.some((s) => !isHealthy(s.status));
  return anyAttention ? 'DEGRADED' : 'HEALTHY';
}

function formatTime(at: Date): string {
  const tz = env().SMS_DIGEST_TIMEZONE;
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...(tz ? { timeZone: tz } : {}),
  }).format(at);
}

/** Builds the SMS text — a summary, matching the format in the vault. */
export function composeMessage(s: {
  now: Date;
  nextCheckAt: Date;
  overallLevel: SystemHealthLevel;
  previousLevel: SystemHealthLevel | null;
  totalServices: number;
  healthyServices: number;
  affected: AffectedService[];
}): string {
  const label = env().SMS_DIGEST_LABEL;
  const meta = LEVEL_META[s.overallLevel];
  const lines = [`${label} – ${formatTime(s.now)}`, `Status: ${meta.icon} ${meta.word}`];

  if (s.overallLevel === 'HEALTHY') {
    lines.push(`All ${s.totalServices} services healthy.`);
    if (s.previousLevel && s.previousLevel !== 'HEALTHY') {
      lines.push(`Recovered from ${s.previousLevel}.`);
    }
  } else {
    lines.push(`${s.healthyServices}/${s.totalServices} services healthy.`);
    const down = s.affected.filter((a) => a.status === 'DOWN').map((a) => a.name);
    const other = s.affected.filter((a) => a.status !== 'DOWN').map((a) => a.name);
    if (s.overallLevel === 'CRITICAL' && down.length > 0) {
      lines.push(`Critical: ${down.join(', ')} DOWN.`);
      if (other.length > 0) lines.push(`Also degraded: ${other.join(', ')}.`);
    } else {
      const names = [...down, ...other];
      const n = names.length;
      lines.push(
        `${n} service${n === 1 ? '' : 's'} ${n === 1 ? 'needs' : 'need'} attention: ${names.join(', ')}.`,
      );
    }
  }
  lines.push(`Next check: ${formatTime(s.nextCheckAt)}.`);
  return lines.join('\n');
}

/**
 * Rule A — send an SMS only when the *overall* level changes. A same-level run
 * (still DEGRADED, still CRITICAL, …) is suppressed — "service remains down"
 * does not re-notify; escalation is the primary alert engine's job.
 */
function decide(
  current: SystemHealthLevel,
  previous: SystemHealthLevel | null,
): { shouldSend: boolean; reason: string } {
  if (previous === null) {
    return current === 'HEALTHY'
      ? { shouldSend: false, reason: 'first digest — system HEALTHY, no routine SMS' }
      : { shouldSend: true, reason: `first digest — system is ${current}` };
  }
  if (previous === current) {
    return { shouldSend: false, reason: `no change (still ${current})` };
  }
  return { shouldSend: true, reason: `${previous} → ${current}` };
}

/** Builds the digest snapshot without persisting or sending — for previews/tests. */
export async function buildDigest(now: Date = new Date()): Promise<DigestSnapshot> {
  const board = (await getTargetStatusBoard()).filter(
    (t) => t.isActive && t.status !== null, // only active, already-checked services
  );
  const services = board.map((t) => ({
    name: t.name,
    status: t.status,
    endpointClass: t.endpointClass,
    isMoneyMoving: t.isMoneyMoving,
  }));

  const overallLevel = rollUp(services);
  const previous = await latestDigest();
  const previousLevel = previous?.overallLevel ?? null;

  const healthyServices = services.filter((s) => isHealthy(s.status)).length;
  const downServices = services.filter((s) => s.status === 'DOWN').length;
  const degradedServices = services.filter(
    (s) => s.status === 'DEGRADED' || s.status === 'UNKNOWN',
  ).length;
  const affected: AffectedService[] = services
    .filter((s) => !isHealthy(s.status))
    .map((s) => ({
      name: s.name,
      status: s.status ?? 'UNKNOWN',
      endpointClass: s.endpointClass,
      isMoneyMoving: s.isMoneyMoving,
    }))
    .sort((a, b) => {
      if (a.isMoneyMoving !== b.isMoneyMoving) return a.isMoneyMoving ? -1 : 1; // money-moving first
      const rank = (x: AffectedService): number => (x.status === 'DOWN' ? 0 : 1);
      return rank(a) - rank(b); // DOWN before DEGRADED/UNKNOWN
    });

  const { shouldSend, reason } = decide(overallLevel, previousLevel);
  const nextCheckAt = new Date(now.getTime() + env().SMS_DIGEST_INTERVAL_MINUTES * 60_000);
  const message = composeMessage({
    now,
    nextCheckAt,
    overallLevel,
    previousLevel,
    totalServices: services.length,
    healthyServices,
    affected,
  });

  return {
    overallLevel,
    previousLevel,
    totalServices: services.length,
    healthyServices,
    degradedServices,
    downServices,
    affected,
    shouldSend,
    reason,
    message,
    nextCheckAt,
  };
}

/**
 * One digest run: snapshot health, record it, and send ONE SMS if Rule A says
 * the overall level changed. Always records the snapshot for history.
 */
export async function evaluateDigest(now: Date = new Date()): Promise<HealthDigest> {
  const snap = await buildDigest(now);
  const recipients = (env().SMS_DIGEST_RECIPIENTS ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);

  let smsSent = false;
  let reason = snap.reason;

  if (env().SMS_DIGEST_ENABLED && snap.shouldSend) {
    if (recipients.length === 0) {
      reason = `${snap.reason} — would send SMS, but SMS_DIGEST_RECIPIENTS is empty`;
    } else {
      const sms = channelFor('SMS');
      const outcomes = await Promise.all(
        recipients.map((to) =>
          sms.send({
            alertType: 'HEALTH_DIGEST',
            severity: snap.overallLevel,
            subject: `${env().SMS_DIGEST_LABEL}: ${snap.overallLevel}`,
            body: snap.message,
            recipient: to,
            incidentNumber: null,
            targetName: null,
            payload: { digest: true, level: snap.overallLevel },
          }),
        ),
      );
      smsSent = outcomes.some((o) => o.ok);
      reason = `${snap.reason} — SMS to ${recipients.length} recipient(s): ${outcomes
        .map((o) => o.detail)
        .join('; ')}`;
      log.info(
        { level: snap.overallLevel, previous: snap.previousLevel, recipients: recipients.length },
        'health digest SMS sent',
      );
    }
  }

  return saveDigest({
    overallLevel: snap.overallLevel,
    previousLevel: snap.previousLevel,
    totalServices: snap.totalServices,
    healthyServices: snap.healthyServices,
    degradedServices: snap.degradedServices,
    downServices: snap.downServices,
    affected: snap.affected,
    smsSent,
    smsRecipients: smsSent ? recipients.length : 0,
    reason,
    nextCheckAt: snap.nextCheckAt,
  });
}
