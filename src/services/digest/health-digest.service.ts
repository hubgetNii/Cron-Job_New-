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
  environment: string;
  isMoneyMoving: boolean;
  uptime24h: number | null;
  lastResponseMs: number | null;
  lastRunAt: Date | null;
  openIncident: boolean;
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
const STATUS_COLOR: Record<string, string> = {
  UP: '#1a8f4e',
  DEGRADED: '#c98a10',
  DOWN: '#cf3f39',
  UNKNOWN: '#6b7280',
};

function fmtUptime(v: number | null): string {
  return v == null ? '—' : `${v.toFixed(2)}%`;
}
function fmtMs(v: number | null): string {
  return v == null ? '—' : `${v} ms`;
}
function sortServices(list: ServiceStatus[]): ServiceStatus[] {
  return [...list].sort(
    (a, b) =>
      Number(b.isMoneyMoving) - Number(a.isMoneyMoving) ||
      (a.status === 'UP' ? 1 : 0) - (b.status === 'UP' ? 1 : 0) ||
      a.name.localeCompare(b.name),
  );
}

export interface EmailReportInput {
  now: Date;
  nextCheckAt: Date;
  overallLevel: SystemHealthLevel;
  previousLevel: SystemHealthLevel | null;
  services: ServiceStatus[];
  healthyServices: number;
  degradedServices: number;
  downServices: number;
  openIncidents: number;
}

/**
 * The email report — the full platform status: every monitored system with its
 * status, 24h uptime, last response time and whether it has an open incident.
 * Returns a plain-text body and an HTML alternative.
 */
export function composeEmail(s: EmailReportInput): {
  subject: string;
  body: string;
  html: string;
} {
  const label = env().SMS_DIGEST_LABEL;
  const meta = LEVEL_META[s.overallLevel];
  const when = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(env().SMS_DIGEST_TIMEZONE ? { timeZone: env().SMS_DIGEST_TIMEZONE } : {}),
  }).format(s.now);
  const ordered = sortServices(s.services);
  const wasLine =
    s.previousLevel && s.previousLevel !== s.overallLevel ? `  (was ${s.previousLevel})` : '';

  const subject = `[${s.overallLevel}] ${label} — ${s.healthyServices}/${s.services.length} systems healthy`;

  /* --- plain text --- */
  const namePad = Math.max(4, ...ordered.map((x) => x.name.length));
  const textRows = ordered.map((x) => {
    const icon = STATUS_ICON[x.status ?? 'UNKNOWN'] ?? '❔';
    const st = (x.status ?? 'UNKNOWN').padEnd(9);
    const nm = x.name.padEnd(namePad);
    const extra = [
      `up24h ${fmtUptime(x.uptime24h)}`,
      `resp ${fmtMs(x.lastResponseMs)}`,
      x.openIncident ? 'INCIDENT OPEN' : '',
      x.isMoneyMoving ? 'money-moving' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return `  ${icon} ${st} ${nm}  ${extra}`;
  });
  const body = [
    `${label} — full platform status`,
    when,
    '',
    `Overall: ${meta.icon} ${s.overallLevel}${wasLine}`,
    `Systems: ${s.healthyServices} healthy · ${s.degradedServices} degraded · ${s.downServices} down · ${s.services.length} total`,
    `Open incidents: ${s.openIncidents}`,
    '',
    'All systems:',
    ...(textRows.length > 0 ? textRows : ['  (no systems registered yet)']),
    '',
    `Next check: ${formatTime(s.nextCheckAt)}`,
    '',
    '— FinTech Cron Monitor',
  ].join('\n');

  /* --- HTML --- */
  const esc = (v: string): string =>
    v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const htmlRows = ordered
    .map((x) => {
      const st = x.status ?? 'UNKNOWN';
      const color = STATUS_COLOR[st] ?? '#6b7280';
      const tags = [
        x.openIncident ? '<span style="color:#cf3f39;font-weight:600">incident open</span>' : '',
        x.isMoneyMoving ? '<span style="color:#c98a10">money-moving</span>' : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #eee">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:8px"></span>
          <b style="color:${color}">${st}</b>
        </td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(x.name)}<div style="color:#888;font-size:12px">${esc(x.endpointClass)} · ${esc(x.environment)}${tags ? ' · ' + tags : ''}</div></td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-variant-numeric:tabular-nums">${fmtUptime(x.uptime24h)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-variant-numeric:tabular-nums">${fmtMs(x.lastResponseMs)}</td>
      </tr>`;
    })
    .join('');
  const bannerColor =
    STATUS_COLOR[
      s.overallLevel === 'HEALTHY' ? 'UP' : s.overallLevel === 'DEGRADED' ? 'DEGRADED' : 'DOWN'
    ];
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;color:#1a1d23">
  <h2 style="margin:0 0 2px">${esc(label)} — full platform status</h2>
  <p style="margin:0 0 16px;color:#888;font-size:13px">${esc(when)}</p>
  <div style="background:${bannerColor}1a;border-left:4px solid ${bannerColor};padding:12px 14px;border-radius:6px;margin-bottom:16px">
    <b style="color:${bannerColor};font-size:15px">${meta.icon} ${s.overallLevel}</b>${wasLine ? `<span style="color:#888"> ${esc(wasLine.trim())}</span>` : ''}<br>
    <span style="font-size:13px">${s.healthyServices} healthy · ${s.degradedServices} degraded · ${s.downServices} down · ${s.services.length} total · ${s.openIncidents} open incident${s.openIncidents === 1 ? '' : 's'}</span>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="text-align:left;color:#888;font-size:11px;text-transform:uppercase">
      <th style="padding:6px 10px">Status</th><th style="padding:6px 10px">System</th>
      <th style="padding:6px 10px;text-align:right">Uptime 24h</th><th style="padding:6px 10px;text-align:right">Last response</th>
    </tr></thead>
    <tbody>${htmlRows || '<tr><td colspan="4" style="padding:12px 10px;color:#888">No systems registered yet.</td></tr>'}</tbody>
  </table>
  <p style="color:#888;font-size:12px;margin-top:16px">Next check: ${esc(formatTime(s.nextCheckAt))}<br>— FinTech Cron Monitor</p>
</div>`;

  return { subject, body, html };
}

export interface StatusSmsInput {
  now: Date;
  nextBroadcastAt: Date;
  overallLevel: SystemHealthLevel;
  services: ServiceStatus[];
  healthyServices: number;
  downServices: number;
  degradedServices: number;
  openIncidents: number;
}

/**
 * The routine status SMS — the whole platform's health in a few lines, sent on a
 * fixed cadence (hourly by default) regardless of whether anything changed. This
 * is the SMS counterpart of the every-run email, condensed for a text message.
 */
export function composeStatusSms(s: StatusSmsInput): string {
  const label = env().SMS_DIGEST_LABEL;
  const meta = LEVEL_META[s.overallLevel];
  const total = s.services.length;
  const upnums = s.services.map((x) => x.uptime24h).filter((v): v is number => v != null);
  const avgUptime =
    upnums.length > 0 ? upnums.reduce((a, b) => a + b, 0) / upnums.length : null;

  const lines = [
    `${label} – ${formatTime(s.now)}`,
    `Status: ${meta.icon} ${meta.word}`,
    `Systems: ${total} total · ${s.healthyServices} up · ${s.downServices} down` +
      (s.degradedServices > 0 ? ` · ${s.degradedServices} degraded` : ''),
    `Open incidents: ${s.openIncidents}`,
  ];
  if (avgUptime != null) lines.push(`Uptime 24h (avg): ${avgUptime.toFixed(2)}%`);

  const attention = sortServices(s.services.filter((x) => !isHealthy(x.status)));
  if (attention.length > 0) {
    lines.push('Needs attention:');
    const shown = attention.slice(0, 6);
    for (const x of shown) {
      lines.push(
        `- ${x.name}: ${x.status ?? 'UNKNOWN'}${x.isMoneyMoving ? ' (money-moving)' : ''}`,
      );
    }
    if (attention.length > shown.length) lines.push(`…+${attention.length - shown.length} more`);
  }
  lines.push(`Next SMS: ${formatTime(s.nextBroadcastAt)}.`);
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
  const services: ServiceStatus[] = board.map((t) => ({
    name: t.name,
    status: t.status,
    endpointClass: t.endpointClass,
    environment: t.environment,
    isMoneyMoving: t.isMoneyMoving,
    uptime24h: t.uptime24h,
    lastResponseMs: t.lastResponseMs,
    lastRunAt: t.lastActualRunAt,
    openIncident: t.openIncidentId !== null,
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
      const { subject, body, html } = composeEmail({
        now,
        nextCheckAt: snap.nextCheckAt,
        overallLevel: snap.overallLevel,
        previousLevel: snap.previousLevel,
        services: snap.services,
        healthyServices: snap.healthyServices,
        degradedServices: snap.degradedServices,
        downServices: snap.downServices,
        openIncidents: snap.services.filter((x) => x.openIncident).length,
      });
      const outcomes = await Promise.all(
        emailTargets.map((c) =>
          mail.send({
            alertType: 'HEALTH_DIGEST',
            severity: snap.overallLevel,
            subject,
            body,
            html,
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

/** Builds the routine status SMS text without sending — for previews/tests. */
export async function previewStatusSms(now: Date = new Date()): Promise<{
  message: string;
  recipients: string[];
  overallLevel: SystemHealthLevel;
}> {
  const snap = await buildDigest(now);
  const list = await smsRecipientList();
  const message = composeStatusSms({
    now,
    nextBroadcastAt: new Date(now.getTime() + env().SMS_STATUS_INTERVAL_MINUTES * 60_000),
    overallLevel: snap.overallLevel,
    services: snap.services,
    healthyServices: snap.healthyServices,
    downServices: snap.downServices,
    degradedServices: snap.degradedServices,
    openIncidents: snap.services.filter((x) => x.openIncident).length,
  });
  return { message, recipients: list.map((r) => r.address), overallLevel: snap.overallLevel };
}

/**
 * Routine SMS status broadcast (hourly by default). Sends the full platform
 * status to EVERY SMS digest contact + `SMS_DIGEST_RECIPIENTS`, unconditionally
 * — this is the SMS counterpart of the every-run email, and is independent of
 * Rule A's state-change SMS. The snapshot is recorded in `health_digests` with a
 * `routine SMS status broadcast` marker so it shows in history.
 */
export async function broadcastStatusSms(now: Date = new Date()): Promise<HealthDigest> {
  const snap = await buildDigest(now);
  const nextBroadcastAt = new Date(now.getTime() + env().SMS_STATUS_INTERVAL_MINUTES * 60_000);
  const parts: string[] = ['routine SMS status broadcast'];
  let smsSent = 0;

  if (env().SMS_STATUS_BROADCAST_ENABLED && env().SMS_DIGEST_ENABLED) {
    const recipients = await smsRecipientList();
    if (recipients.length === 0) {
      parts.push('no SMS recipients');
    } else {
      const message = composeStatusSms({
        now,
        nextBroadcastAt,
        overallLevel: snap.overallLevel,
        services: snap.services,
        healthyServices: snap.healthyServices,
        downServices: snap.downServices,
        degradedServices: snap.degradedServices,
        openIncidents: snap.services.filter((x) => x.openIncident).length,
      });
      const sms = channelFor('SMS');
      const outcomes = await Promise.all(
        recipients.map((r) =>
          sms.send({
            alertType: 'HEALTH_DIGEST',
            severity: snap.overallLevel,
            subject: `${env().SMS_DIGEST_LABEL} status: ${snap.overallLevel}`,
            body: message,
            recipient: r.address,
            incidentNumber: null,
            targetName: null,
            payload: { digest: true, routine: true, level: snap.overallLevel },
          }),
        ),
      );
      smsSent = outcomes.filter((o) => o.ok).length;
      parts.push(`SMS → ${smsSent}/${recipients.length}: ${outcomes.map((o) => o.detail).join('; ')}`);
    }
  } else {
    parts.push('broadcast disabled');
  }

  log.info(
    { level: snap.overallLevel, smsSent, recipients: parts.length },
    'routine SMS status broadcast',
  );

  return saveDigest({
    overallLevel: snap.overallLevel,
    // Keep the level chain honest — a broadcast is not a transition.
    previousLevel: snap.overallLevel,
    totalServices: snap.totalServices,
    healthyServices: snap.healthyServices,
    degradedServices: snap.degradedServices,
    downServices: snap.downServices,
    affected: snap.affected,
    smsSent: smsSent > 0,
    smsRecipients: smsSent,
    emailSent: false,
    emailRecipients: 0,
    reason: parts.join(' | '),
    nextCheckAt: nextBroadcastAt,
  });
}
