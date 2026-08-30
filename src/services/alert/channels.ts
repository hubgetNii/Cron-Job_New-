import { createHmac } from 'node:crypto';
import { request } from 'undici';
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/index.js';
import { componentLogger } from '../../lib/logger.js';
import type { AlertChannel } from '../../domain/enums.js';

const log = componentLogger('alert-channel');

export interface Notification {
  alertType: string;
  severity: string;
  subject: string;
  body: string;
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
    if (!this.url) return { ok: false, detail: 'ALERT_WEBHOOK_URL not configured' };
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
    if (!this.url) return { ok: false, detail: 'ALERT_SLACK_WEBHOOK_URL not configured' };
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
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD } = env();
    if (!SMTP_HOST) return null;
    this.transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      ...(SMTP_USER && SMTP_PASSWORD ? { auth: { user: SMTP_USER, pass: SMTP_PASSWORD } } : {}),
    });
    return this.transporter;
  }

  async send(n: Notification): Promise<DeliveryResult> {
    const to = env().ALERT_EMAIL_TO;
    if (!to) return { ok: false, detail: 'ALERT_EMAIL_TO not configured' };
    const transporter = this.getTransporter();
    if (!transporter) {
      log.warn({ alertType: n.alertType }, 'SMTP not configured — email not sent');
      return { ok: false, detail: 'SMTP_HOST not configured' };
    }
    try {
      const info = (await transporter.sendMail({
        from: env().ALERT_EMAIL_FROM ?? 'cron-monitor@localhost',
        to,
        subject: `[${n.severity}] ${n.subject}`,
        text: `${n.body}\n\nRecipient group: ${n.recipient}\nIncident: ${n.incidentNumber ?? 'n/a'}`,
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
    const to = env().ALERT_SMS_TO;
    const url = env().SMS_PROVIDER_URL;
    const key = env().SMS_PROVIDER_API_KEY;
    if (!to || !url || !key) {
      log.warn({ alertType: n.alertType }, 'SMS provider not configured — SMS not sent');
      return {
        ok: false,
        detail: 'SMS provider not configured (SMS_PROVIDER_URL/API_KEY/ALERT_SMS_TO)',
      };
    }
    try {
      const res = await request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ to, message: `[${n.severity}] ${n.subject}` }),
        signal: AbortSignal.timeout(10_000),
      });
      await res.body.dump();
      return res.statusCode < 300
        ? { ok: true, detail: `HTTP ${res.statusCode}` }
        : { ok: false, detail: `SMS provider HTTP ${res.statusCode}` };
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
      ['PUSH', new LogChannel('PUSH')],
      ['PHONE', new LogChannel('PHONE')],
    ]);
  }
  return registry.get(kind) ?? new LogChannel(kind);
}

/** Test seam. */
export function setChannelRegistry(map: Map<AlertChannel, Channel> | undefined): void {
  registry = map;
}
