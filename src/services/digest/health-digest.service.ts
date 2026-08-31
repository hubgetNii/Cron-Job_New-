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
import { digestContacts } from '../../repositories/notification-contacts.repo.js';
import { channelFor } from '../alert/channels.js';

const log = componentLogger('health-digest');

export interface ServiceStatus {
  name: string;
  status: string | null;
  endpointClass: string;
  isMoneyMoving: boolean;
}

export interface DigestSnapshot {
  overallLevel: SystemHealthLevel;
  previousLevel: SystemHealthLevel | null;
  totalServices: number;
  healthyServices: number;
  degradedServices: number;
  downServices: number;
  affected: AffectedService[];
  /** Full per-service list — used for the email "full status". */
  services: ServiceStatus[];
  /** Whether Rule A (overall state change) says to notify this run. */
  shouldSend: boolean;
  reason: string;
  /** The short SMS text. */
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

const STATUS_ICON: Record<string, string> = {
  UP: '✅',
  DEGRADED: '⚠️',
  DOWN: '🔴',
  UNKNOWN: '❔',
};

/** The email digest — the full platform status, every service listed. */
export function composeEmail(s: {
  now: Date;
  nextCheckAt: Date;
  overallLevel: SystemHealthLevel;
  previousLevel: SystemHealthLevel | null;
  services: ServiceStatus[];
  healthyServices: number;
  degradedServices: number;
  downServices: number;
}): { subject: string; body: string } {
  const label = env().SMS_DIGEST_LABEL;
  const meta = LEVEL_META[s.overallLevel];
  const when = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(env().SMS_DIGEST_TIMEZONE ? { timeZone: env().SMS_DIGEST_TIMEZONE } : {}),
  }).format(s.now);

  const pad = Math.max(0, ...s.services.map((x) => (x.status ?? 'UNKNOWN').length));
  const rows = [...s.services]
    .sort(
      (a, b) =>
        Number(b.isMoneyMoving) - Number(a.isMoneyMoving) ||
        (a.status === 'UP' ? 1 : 0) - (b.status === 'UP' ? 1 : 0) ||
        a.name.localeCompare(b.name),
    )
    .map((x) => {
      const st = (x.status ?? 'UNKNOWN').padEnd(pad);
      const icon = STATUS_ICON[x.status ?? 'UNKNOWN'] ?? '❔';
      const mm = x.isMoneyMoving ? '  [money-moving]' : '';
      return `  ${icon} ${st}  ${x.name}  (${x.endpointClass})${mm}`;
    });

  const subject = `[${s.overallLevel}] ${label} — ${s.healthyServices}/${s.services.length} services healthy`;
  const body = [
    `${label} — full platform status`,
    when,
    '',
    `Overall: ${meta.icon} ${s.overallLevel}${
      s.previousLevel && s.previousLevel !== s.overallLevel ? `  (was ${s.previousLevel})` : ''
    }`,
    `Healthy ${s.healthyServices} · Degraded ${s.degradedServices} · Down ${s.downServices} · Total ${s.services.length}`,
    '',
    'Services:',
    ...(rows.length > 0 ? rows : ['  (no services registered yet)']),
    '',
    `Next check: ${formatTime(s.nextCheckAt)}`,
    '',
    '— FinTech Cron Monitor',
  ].join('\n');
  return { subject, body };
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
    services,
    shouldSend,
    reason,
    message,
    nextCheckAt,
  };
}

/** Deduped list of SMS recipients: env `SMS_DIGEST_RECIPIENTS` ∪ SMS contacts. */
async function smsRecipientList(): Promise<{ address: string; everyRun: boolean }[]> {
  const envList = (env().SMS_DIGEST_RECIPIENTS ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((address) => ({ address, everyRun: false }));
  const contacts = (await digestContacts('SMS')).map((c) => ({
    address: c.address,
    everyRun: c.digestEveryRun,
  }));
  const seen = new Set<string>();
  return [...contacts, ...envList].filter((r) => {
    const key = r.address.replace(/[^\d]/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * One digest run: snapshot health, record it, and notify.
 *
 * - **SMS** — short summary; sent to each SMS recipient when the overall level
 *   changed (Rule A), or every run for a contact flagged `digest_every_run`.
 * - **EMAIL** — full per-service platform status; same trigger, and typically
 *   `digest_every_run = true` so it lands every 30 minutes.
 *
 * The snapshot is always recorded for history, regardless of sends.
 */
export async function evaluateDigest(now: Date = new Date()): Promise<HealthDigest> {
  const snap = await buildDigest(now);
  const parts: string[] = [snap.reason];
  let smsSent = 0;
  let emailSent = 0;

  if (env().SMS_DIGEST_ENABLED) {
    // --- SMS ---
    const smsList = await smsRecipientList();
    const smsTargets = smsList.filter((r) => snap.shouldSend || r.everyRun);
    if (smsTargets.length === 0) {
      parts.push(smsList.length === 0 ? 'no SMS recipients' : 'SMS: nothing to send this run');
    } else {
      const sms = channelFor('SMS');
      const outcomes = await Promise.all(
        smsTargets.map((r) =>
          sms.send({
            alertType: 'HEALTH_DIGEST',
            severity: snap.overallLevel,
            subject: `${env().SMS_DIGEST_LABEL}: ${snap.overallLevel}`,
            body: snap.message,
            recipient: r.address,
            incidentNumber: null,
            targetName: null,
            payload: { digest: true, level: snap.overallLevel },
          }),
        ),
      );
      smsSent = outcomes.filter((o) => o.ok).length;
      parts.push(
        `SMS → ${smsSent}/${smsTargets.length}: ${outcomes.map((o) => o.detail).join('; ')}`,
      );
    }

    // --- EMAIL (full status) ---
    const emailContacts = await digestContacts('EMAIL');
    const emailTargets = emailContacts.filter((c) => snap.shouldSend || c.digestEveryRun);
    if (emailTargets.length > 0) {
      const mail = channelFor('EMAIL');
      const { subject, body } = composeEmail({
        now,
        nextCheckAt: snap.nextCheckAt,
        overallLevel: snap.overallLevel,
        previousLevel: snap.previousLevel,
        services: snap.services,
        healthyServices: snap.healthyServices,
        degradedServices: snap.degradedServices,
        downServices: snap.downServices,
      });
      const outcomes = await Promise.all(
        emailTargets.map((c) =>
          mail.send({
            alertType: 'HEALTH_DIGEST',
            severity: snap.overallLevel,
            subject,
            body,
            recipient: c.address,
            incidentNumber: null,
            targetName: null,
            payload: { digest: true, level: snap.overallLevel },
          }),
        ),
      );
      emailSent = outcomes.filter((o) => o.ok).length;
      parts.push(
        `Email → ${emailSent}/${emailTargets.length}: ${outcomes.map((o) => o.detail).join('; ')}`,
      );
    }
  }

  const reason = parts.join(' | ');
  log.info(
    { level: snap.overallLevel, previous: snap.previousLevel, smsSent, emailSent },
    'health digest evaluated',
  );

  return saveDigest({
    overallLevel: snap.overallLevel,
    previousLevel: snap.previousLevel,
    totalServices: snap.totalServices,
    healthyServices: snap.healthyServices,
    degradedServices: snap.degradedServices,
    downServices: snap.downServices,
    affected: snap.affected,
    smsSent: smsSent > 0,
    smsRecipients: smsSent,
    emailSent: emailSent > 0,
    emailRecipients: emailSent,
    reason,
    nextCheckAt: snap.nextCheckAt,
  });
}
