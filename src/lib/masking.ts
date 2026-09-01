/**
 * Secret & PII masking for stored observability traces (spec §3–5).
 *
 * The monitor captures the full request it sent and the full response it got.
 * Before any of that is written to the database it passes through here:
 * Authorization headers, API keys, tokens, passwords, PINs, CVV, card numbers,
 * encryption keys and other sensitive fields are replaced with `***MASKED***`.
 * The at-rest "raw" copy is a separate, encrypted, ADMIN-only path — the masked
 * copy is what every normal read returns.
 *
 * Over-masking is the safe failure mode: the platform never needs the secret.
 */

import { scrubPci } from './pci.js';

export const MASK = '***MASKED***';

/** Header names whose *value* is always a secret. */
const SECRET_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'x-api-secret',
  'x-auth-token',
  'x-access-token',
  'x-session-token',
  'x-amz-security-token',
  'x-goog-api-key',
  'x-secret',
  'x-signature',
  'x-hub-signature',
  'x-hub-signature-256',
]);

/** Header names that are safe to keep in the clear (allow-list wins over the fuzzy match). */
const SAFE_HEADER_NAMES = new Set([
  'content-type',
  'content-length',
  'content-encoding',
  'accept',
  'accept-encoding',
  'accept-language',
  'user-agent',
  'date',
  'server',
  'connection',
  'cache-control',
  'etag',
  'vary',
  'api-version',
  'x-api-version',
  'x-request-id',
  'x-correlation-id',
  'x-trace-id',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'retry-after',
]);

const FUZZY_SECRET_HEADER = /(?:auth|token|secret|api[-_]?key|credential|password|signature|bearer)/i;

/** JSON keys whose value is masked wherever they appear, at any depth. */
const SECRET_KEY = new RegExp(
  [
    'password',
    'passwd',
    'pwd',
    'secret',
    'pin',
    'otp',
    'cvv',
    'cvc',
    'cav',
    'token',
    'access[_-]?key',
    'api[_-]?key',
    'apikey',
    'client[_-]?secret',
    'private[_-]?key',
    'encryption[_-]?key',
    'signing[_-]?key',
    'authorization',
    'auth[_-]?token',
    'session[_-]?id',
    'card[_-]?number',
    'cardnumber',
    'pan',
    'account[_-]?number',
    'iban',
    'ssn',
    'national[_-]?id',
  ].join('|'),
  'i',
);

/** `Authorization: Bearer x`, `?api_key=x`, `token=x`, `"password":"x"` inside free text. */
const INLINE_SECRET =
  /(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*|((?:api[_-]?key|apikey|token|access[_-]?token|client[_-]?secret|password|secret|pin|otp|signature)\s*[=:]\s*)(["']?)[^"'&\s]{4,}\3/gi;

export function maskInlineSecrets(text: string): string {
  return text.replace(INLINE_SECRET, (_m, p1: string | undefined, p2: string | undefined, q = '') =>
    p1 ? `${p1}${MASK}` : `${p2 ?? ''}${q}${MASK}${q}`,
  );
}

/** Mask a header bag. Case-insensitive on the name; returns a new lower-cased-key object. */
export function maskHeaders(
  headers: Record<string, string | string[] | undefined> | undefined | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (rawValue == null) continue;
    const name = rawName.toLowerCase();
    const value = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
    if (SAFE_HEADER_NAMES.has(name)) {
      out[name] = scrubPci(value);
    } else if (SECRET_HEADER_NAMES.has(name) || FUZZY_SECRET_HEADER.test(name)) {
      out[name] = MASK;
    } else {
      out[name] = scrubPci(maskInlineSecrets(value));
    }
  }
  return out;
}

/** Mask a decoded query string (the value half of sensitive params). */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (SECRET_KEY.test(key)) u.searchParams.set(key, MASK);
    }
    return u.toString();
  } catch {
    return maskInlineSecrets(url);
  }
}

/** Deep-mask a parsed JSON value by key name, scrubbing PCI from every string leaf. */
export function maskJson(value: unknown, depth = 0): unknown {
  if (depth > 12) return value;
  if (Array.isArray(value)) return value.map((v) => maskJson(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k)
        ? MASK
        : typeof v === 'string'
          ? scrubPci(v)
          : maskJson(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return scrubPci(value);
  return value;
}

/**
 * Mask a body string. If it parses as JSON, mask by key; otherwise scrub PCI and
 * inline secrets. Truncates to `maxBytes` (default 64 KB).
 */
export function maskBody(text: string | null | undefined, maxBytes = 64 * 1024): string | null {
  if (text == null || text === '') return null;
  const clipped = text.length > maxBytes ? `${text.slice(0, maxBytes)}…[truncated]` : text;
  try {
    return JSON.stringify(maskJson(JSON.parse(clipped)));
  } catch {
    return scrubPci(maskInlineSecrets(clipped));
  }
}
