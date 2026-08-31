import { randomBytes } from 'node:crypto';
import { request } from 'undici';
import { env } from '../../config/index.js';
import { componentLogger } from '../../lib/logger.js';

const log = componentLogger('sms-gateway');

export interface SmsSendResult {
  ok: boolean;
  detail: string;
  uid: string;
}

/** True when the SMS gateway has enough config to send. */
export function smsConfigured(): boolean {
  const e = env();
  return Boolean(e.SMS_GATEWAY_URL && e.SMS_API_ID && e.SMS_API_PASSWORD);
}

/** Digits only, no leading `+` or `00` — the gateway wants e.g. `233551530764`. */
export function normalizeMsisdn(input: string): string {
  let n = input.replace(/[^\d+]/g, '');
  if (n.startsWith('+')) n = n.slice(1);
  else if (n.startsWith('00')) n = n.slice(2);
  return n;
}

/** A short opaque id per message, matching the gateway's `uid` format. */
export function newUid(): string {
  return randomBytes(4).toString('hex');
}

/**
 * Sends one SMS through the iSmartGhana bulk-SMS gateway.
 *
 * The gateway is a GET with credentials in the query string (its contract, not
 * ours). We never log the built URL — only `{ to, uid, status }` — and
 * `SMS_API_PASSWORD` is on the logger's redact list.
 */
export async function sendSms(input: {
  to: string;
  message: string;
  uid?: string;
}): Promise<SmsSendResult> {
  const e = env();
  const uid = input.uid ?? newUid();
  const to = normalizeMsisdn(input.to);

  if (!e.SMS_GATEWAY_URL || !e.SMS_API_ID || !e.SMS_API_PASSWORD) {
    return { ok: false, detail: 'SMS gateway not configured', uid };
  }

  const url = new URL(e.SMS_GATEWAY_URL);
  const p = url.searchParams;
  p.set('api_id', e.SMS_API_ID);
  p.set('api_password', e.SMS_API_PASSWORD);
  p.set('sms_type', e.SMS_TYPE);
  p.set('encoding', e.SMS_ENCODING);
  p.set('sender_id', e.SMS_SENDER_ID);
  p.set('phonenumber', to);
  p.set('textmessage', input.message);
  p.set('ValidityPeriodInSeconds', String(e.SMS_VALIDITY_SECONDS));
  p.set('uid', uid);
  p.set('isScheduled', 'false');
  if (e.SMS_CALLBACK_URL) p.set('callback_url', e.SMS_CALLBACK_URL);
  if (e.SMS_DLT_ENTITY_ID) p.set('dltEntityId', e.SMS_DLT_ENTITY_ID);
  if (e.SMS_DLT_TEMPLATE_ID) p.set('dltEntityTemplateId', e.SMS_DLT_TEMPLATE_ID);

  try {
    const res = await request(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.body.text()).trim();
    const ok = res.statusCode >= 200 && res.statusCode < 300 && !looksLikeFailure(body);
    // Body may reveal the real response shape — log it (no credentials in it).
    log.info(
      { to, uid, statusCode: res.statusCode, ok, body: body.slice(0, 400) },
      'SMS gateway response',
    );
    return {
      ok,
      detail: ok
        ? `HTTP ${res.statusCode} (uid ${uid})`
        : `HTTP ${res.statusCode}: ${body.slice(0, 200)}`,
      uid,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error({ to, uid, err: detail }, 'SMS gateway request failed');
    return { ok: false, detail, uid };
  }
}

/**
 * Conservative failure sniff on a 2xx body — most gateways still return 200 for
 * auth/credit errors. Treats an explicit error flag / message as a failure;
 * anything ambiguous is left as success so we don't hide real sends.
 */
function looksLikeFailure(body: string): boolean {
  if (!body) return false;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return /invalid|unauthor|failed|error|insufficient|denied/i.test(body);
  }
  if (typeof json !== 'object' || json === null) return false;
  const o = json as Record<string, unknown>;
  const str = (v: unknown): string =>
    typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

  const status = str(o['status'] ?? o['Status']).toLowerCase();
  if (status && /fail|error|invalid|reject/.test(status)) return true;
  const code = str(o['ErrorCode'] ?? o['error_code'] ?? o['code']).toLowerCase();
  if (code && !['0', '00', '000', 'success', 'ok', ''].includes(code)) return true;
  const err = str(o['error'] ?? o['Error'] ?? o['ErrorMessage'] ?? o['ErrorDescription']);
  if (err && !/success|none|ok/i.test(err)) return true;
  return false;
}
