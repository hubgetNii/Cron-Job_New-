import { readFile } from 'node:fs/promises';
import { request } from 'undici';
import { importPKCS8, SignJWT } from 'jose';
import { env } from '../../config/index.js';
import { componentLogger } from '../../lib/logger.js';

const log = componentLogger('fcm');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

interface CachedToken {
  value: string;
  /** epoch ms this token must be treated as expired at (with safety margin). */
  expiresAt: number;
}

export type FcmTarget = { token: string } | { topic: string };

/**
 * Resolves an alert recipient string to an FCM message target:
 * - `"/topics/foo"` or `"topic:foo"` → that topic
 * - a long opaque string with no spaces (a device registration token) → that token
 * - anything else (e.g. the default `"ops"`) → `defaultTopic`, or an error if unset
 */
export function resolveFcmTarget(recipient: string, defaultTopic: string | undefined): FcmTarget {
  if (recipient.startsWith('/topics/')) return { topic: recipient.slice('/topics/'.length) };
  if (recipient.startsWith('topic:')) return { topic: recipient.slice('topic:'.length) };
  if (recipient.length >= 100 && !recipient.includes(' ')) return { token: recipient };
  if (!defaultTopic) {
    throw new Error(`recipient "${recipient}" is not a token/topic and FCM_DEFAULT_TOPIC is unset`);
  }
  return { topic: defaultTopic };
}

/**
 * Minimal Firebase Cloud Messaging client for the PUSH alert channel.
 *
 * It authenticates the way the Firebase Admin SDK does — a service-account JWT
 * (RS256) exchanged for a short-lived OAuth2 access token — but hand-rolled with
 * `jose`, so no extra dependency. Then it calls the FCM HTTP v1 endpoint
 * (`/v1/projects/{id}/messages:send`).
 */
export class FcmClient {
  private account: ServiceAccount | undefined;
  private token: CachedToken | undefined;

  /** True when a service-account file is configured. */
  static configured(): boolean {
    return Boolean(env().FCM_SERVICE_ACCOUNT_FILE);
  }

  private async loadAccount(): Promise<ServiceAccount> {
    if (this.account) return this.account;
    const file = env().FCM_SERVICE_ACCOUNT_FILE;
    if (!file) throw new Error('FCM_SERVICE_ACCOUNT_FILE not set');
    const raw = JSON.parse(await readFile(file, 'utf8')) as {
      project_id?: string;
      client_email?: string;
      private_key?: string;
    };
    if (!raw.project_id || !raw.client_email || !raw.private_key) {
      throw new Error(`${file} is not a valid Firebase service-account JSON`);
    }
    this.account = {
      projectId: raw.project_id,
      clientEmail: raw.client_email,
      // `.env`-style files often store the key with literal "\n"; normalise.
      privateKey: raw.private_key.replace(/\\n/g, '\n'),
    };
    return this.account;
  }

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt > now) return this.token.value;

    const acct = await this.loadAccount();
    const key = await importPKCS8(acct.privateKey, 'RS256');
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(acct.clientEmail)
      .setSubject(acct.clientEmail)
      .setAudience(TOKEN_URL)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);

    const res = await request(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.body.json()) as { access_token?: string; expires_in?: number };
    if (res.statusCode >= 300 || !body.access_token) {
      throw new Error(`token exchange failed (HTTP ${res.statusCode})`);
    }
    this.token = {
      value: body.access_token,
      expiresAt: now + (body.expires_in ?? 3600) * 1000 - 60_000,
    };
    return this.token.value;
  }

  async send(input: {
    recipient: string;
    title: string;
    body: string;
    data: Record<string, string>;
  }): Promise<{ name: string }> {
    const acct = await this.loadAccount();
    const token = await this.accessToken();
    const message = {
      ...resolveFcmTarget(input.recipient, env().FCM_DEFAULT_TOPIC),
      notification: { title: input.title, body: input.body },
      data: input.data,
      android: { priority: 'high' as const },
      apns: { headers: { 'apns-priority': '10' } },
    };
    const res = await request(
      `https://fcm.googleapis.com/v1/projects/${acct.projectId}/messages:send`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const text = await res.body.text();
    if (res.statusCode >= 300) {
      throw new Error(`FCM HTTP ${res.statusCode}: ${text.slice(0, 300)}`);
    }
    log.debug({ statusCode: res.statusCode }, 'FCM message accepted');
    return JSON.parse(text) as { name: string };
  }

  /** Test seam — drop the cached token/account. */
  reset(): void {
    this.account = undefined;
    this.token = undefined;
  }
}

let singleton: FcmClient | undefined;

export function getFcmClient(): FcmClient {
  singleton ??= new FcmClient();
  return singleton;
}

export function setFcmClient(fake: FcmClient | undefined): void {
  singleton = fake;
}
