import { createHmac } from 'node:crypto';
import { request } from 'undici';
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/index.js';
import { componentLogger } from '../../lib/logger.js';
import type { AlertChannel } from '../../domain/enums.js';
import { FcmClient, getFcmClient } from './fcm.js';
import { sendSms, smsConfigured } from './sms-gateway.js';

const log = componentLogger('alert-channel');

/**
 * A channel with no transport configured logs the notification and reports
 * success, rather than failing every alert. Production sets the transport;
 * this keeps dev and staging quiet-but-visible.
 */
function loggedFallback(kind: AlertChannel, n: Notification, reason: string): DeliveryResult {
  log.warn(
    {
      channel: kind,
      alertType: n.alertType,
      severity: n.severity,
      subject: n.subject,
      body: n.body || undefined,
      reason,
    },
    `alert not delivered (${kind} has no transport) — logged only`,
  );
  return { ok: true, detail: `logged only — ${reason}` };
}

export interface Notification {
  alertType: string;
  severity: string;
  subject: string;
  body: string;
  /** Optional HTML alternative — used by the email channel when present. */
  html?: string;
  recipient: string;
  incidentNumber?: string | null;
  targetName?: string | null;
  payload: Record<string, unknown>;
}

export interface DeliveryResult {
  ok: boolean;
  detail: string;
}

export interface Channel {
  readonly kind: AlertChannel;
  send(n: Notification): Promise<DeliveryResult>;
}

/* -------------------------------------------------------------------------- */

class WebhookChannel implements Channel {
  readonly kind: AlertChannel = 'WEBHOOK';
  constructor(private readonly url: string | undefined) {}

  async send(n: Notification): Promise<DeliveryResult> {
    if (!this.url) return loggedFallback('WEBHOOK', n, 'ALERT_WEBHOOK_URL not set');
    const bodyStr = JSON.stringify({
      alert_type: n.alertType,
      severity: n.severity,
      subject: n.subject,
      body: n.body,
      recipient: n.recipient,
      incident_number: n.incidentNumber ?? null,
      target: n.targetName ?? null,
      ...n.payload,
      sent_at: new Date().toISOString(),
    });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const secret = env().WEBHOOK_SIGNING_SECRET;
    if (secret) {
      headers['x-signature'] =
        `sha256=${createHmac('sha256', secret).update(bodyStr).digest('hex')}`;
    }
    try {
      const res = await request(this.url, {
        method: 'POST',
        headers,
        body: bodyStr,
        signal: AbortSignal.timeout(10_000),
      });
      await res.body.dump();
      return res.statusCode < 300
        ? { ok: true, detail: `HTTP ${res.statusCode}` }
        : { ok: false, detail: `webhook returned HTTP ${res.statusCode}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

class SlackChannel implements Channel {
  readonly kind: AlertChannel = 'SLACK';
  constructor(private readonly url: string | undefined) {}

  async send(n: Notification): Promise<DeliveryResult> {
    if (!this.url) return loggedFallback('SLACK', n, 'ALERT_SLACK_WEBHOOK_URL not set');
    const text = `*${n.severity} · ${n.alertType}*\n${n.subject}\n${n.body}`;
    try {
      const res = await request(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(10_000),
      });
      await res.body.dump();
      return res.statusCode < 300
        ? { ok: true, detail: `HTTP ${res.statusCode}` }
        : { ok: false, detail: `slack returned HTTP ${res.statusCode}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

class EmailChannel implements Channel {
  readonly kind: AlertChannel = 'EMAIL';
  private transporter: Transporter | null = null;

  private getTransporter(): Transporter | null {
    if (this.transporter) return this.transporter;
    const { SMTP_SERVICE, SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD } = env();
    if (!SMTP_SERVICE && !SMTP_HOST) return null;
    // A well-known service (gmail, …) always needs credentials; a bare host may
    // be an unauthenticated local relay.
    if (SMTP_SERVICE && !(SMTP_USER && SMTP_PASSWORD)) return null;
    const auth =
      SMTP_USER && SMTP_PASSWORD ? { auth: { user: SMTP_USER, pass: SMTP_PASSWORD } } : {};
    this.transporter = nodemailer.createTransport(
      SMTP_SERVICE
        ? { service: SMTP_SERVICE, ...auth }
        : { host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE ?? SMTP_PORT === 465, ...auth },
    );
    return this.transporter;
  }

  async send(n: Notification): Promise<DeliveryResult> {
    // An address on the notification wins (digest / contact-list recipients);
    // ALERT_EMAIL_TO is the fallback for per-event alerts.
    const to = n.recipient.includes('@') ? n.recipient : env().ALERT_EMAIL_TO;
    const transporter = this.getTransporter();
    if (!to || !transporter) {
      return loggedFallback('EMAIL', n, !to ? 'no recipient address' : 'SMTP not configured');
    }
    // Summary / report notifications carry a fully-formed subject + body (+ html).
    const isSummary = Boolean(n.body) && n.incidentNumber == null;
    try {
      const info = (await transporter.sendMail({
        from: env().ALERT_EMAIL_FROM ?? 'cron-monitor@localhost',
        to,
        subject: isSummary ? n.subject : `[${n.severity}] ${n.subject}`,
        text: isSummary
          ? n.body
          : `${n.body}\n\nRecipient group: ${n.recipient}\nIncident: ${n.incidentNumber ?? 'n/a'}`,
        ...(n.html ? { html: n.html } : {}),
      })) as { messageId?: string };
      return { ok: true, detail: `queued ${info.messageId ?? 'ok'}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

class SmsChannel implements Channel {
  readonly kind: AlertChannel = 'SMS';

  async send(n: Notification): Promise<DeliveryResult> {
    // The recipient on the notification wins (digest recipients, escalation
    // tiers); ALERT_SMS_TO is the fallback for one-off per-event SMS.
    const to = n.recipient && n.recipient !== 'ops' ? n.recipient : env().ALERT_SMS_TO;
    if (!to) return loggedFallback('SMS', n, 'no recipient');
    if (!smsConfigured()) {
      return loggedFallback('SMS', n, 'SMS_GATEWAY_URL / SMS_API_ID / SMS_API_PASSWORD not set');
    }
    // Digest and other summary notifications carry the full text in `body`.
    const message = n.body && n.body.length > 0 ? n.body : `[${n.severity}] ${n.subject}`;
    const result = await sendSms({ to, message });
    return { ok: result.ok, detail: result.detail };
  }
}

class FcmPushChannel implements Channel {
  readonly kind: AlertChannel = 'PUSH';

  async send(n: Notification): Promise<DeliveryResult> {
    if (!FcmClient.configured()) {
      return loggedFallback('PUSH', n, 'FCM_SERVICE_ACCOUNT_FILE not set');
    }
    const str = (v: unknown): string =>
      v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    try {
      const res = await getFcmClient().send({
        recipient: n.recipient,
        title: `[${n.severity}] ${n.subject}`,
        body: n.body,
        // FCM data values must all be strings.
        data: {
          alert_type: n.alertType,
          severity: n.severity,
          incident_number: n.incidentNumber ?? '',
          target: n.targetName ?? '',
          incident_id: str(n.payload['incident_id']),
          api_id: str(n.payload['api_id']),
        },
      });
      return { ok: true, detail: `FCM ${res.name.split('/').pop() ?? 'sent'}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Logs the notification instead of delivering it — the last-resort transport. */
class LogChannel implements Channel {
  constructor(readonly kind: AlertChannel) {}
  send(n: Notification): Promise<DeliveryResult> {
    log.info(
      { alertType: n.alertType, severity: n.severity, recipient: n.recipient, subject: n.subject },
      `alert (${this.kind}, log-only)`,
    );
    return Promise.resolve({ ok: true, detail: 'logged (no transport configured)' });
  }
}

/* -------------------------------------------------------------------------- */

let registry: Map<AlertChannel, Channel> | undefined;

export function channelFor(kind: AlertChannel): Channel {
  if (!registry) {
    registry = new Map<AlertChannel, Channel>([
      ['WEBHOOK', new WebhookChannel(env().ALERT_WEBHOOK_URL)],
      ['SLACK', new SlackChannel(env().ALERT_SLACK_WEBHOOK_URL)],
      ['EMAIL', new EmailChannel()],
      ['SMS', new SmsChannel()],
      ['TEAMS', new LogChannel('TEAMS')],
      ['PUSH', new FcmPushChannel()],
      ['PHONE', new LogChannel('PHONE')],
    ]);
  }
  return registry.get(kind) ?? new LogChannel(kind);
}

/** Test seam. */
export function setChannelRegistry(map: Map<AlertChannel, Channel> | undefined): void {
  registry = map;
}
