import { randomUUID } from 'node:crypto';
import { request } from 'undici';
import { getByPath } from '../../lib/json-path.js';
import { substituteUuid } from '../../lib/templating.js';
import { maskInlineSecrets } from '../../lib/masking.js';
import { scrubPci } from '../../lib/pci.js';
import { componentLogger } from '../../lib/logger.js';

const log = componentLogger('oauth2-token-cache');

/**
 * Generic "fetch a bearer token via HTTP Basic auth, cache it until it's
 * nearly expired" helper for the `OAUTH2` auth type. Modeled on the FCM
 * client's token cache (`src/services/alert/fcm.ts`), but vendor-agnostic:
 * any target can use it by pointing `tokenUrl`/`tokenUsername`/`tokenPassword`
 * at its own token endpoint.
 *
 * Cached in-memory only (like FCM) — a process restart just triggers one more
 * (cheap, non-money-moving) token fetch, not a persisted write.
 */

export interface OAuth2Credentials {
  tokenUrl: string;
  tokenUsername: string;
  tokenPassword: string;
  /** Dotted path to the token in the token endpoint's JSON response. */
  tokenPath?: string;
  /** Dotted path to the expiry (epoch seconds) in that same response. */
  tokenExpiryPath?: string;
  /**
   * Raw JSON body to POST to `tokenUrl`, e.g. `'{"trackid":"{{uuid}}"}'` for
   * vendors that require a per-request id even on the token handshake (MPSMS
   * does). `{{uuid}}` is replaced with a fresh id on every fetch. Defaults to
   * `'{}'` when omitted.
   */
  tokenBody?: string;
}

interface CachedToken {
  value: string;
  /** epoch ms this token must be treated as expired at (with safety margin). */
  expiresAt: number;
}

const DEFAULT_TOKEN_PATH = 'data.token';
const DEFAULT_TOKEN_EXPIRY_PATH = 'data.expiry';
/** Used when the response carries no usable expiry — refresh often rather than risk a stale token. */
const FALLBACK_TTL_MS = 60 * 60 * 1000;
const SAFETY_MARGIN_MS = 60_000;

const cache = new Map<string, CachedToken>();

function cacheKey(creds: OAuth2Credentials): string {
  return `${creds.tokenUrl}::${creds.tokenUsername}`;
}

async function fetchToken(creds: OAuth2Credentials): Promise<CachedToken> {
  const encoded = Buffer.from(`${creds.tokenUsername}:${creds.tokenPassword}`).toString('base64');
  const body = substituteUuid(creds.tokenBody ?? '{}', randomUUID());
  const res = await request(creds.tokenUrl, {
    method: 'POST',
    headers: {
      authorization: `Basic ${encoded}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.body.text();
  // Never put the raw response body in a thrown Error: it becomes
  // `health_check_results.error_message`, which — unlike the masked trace —
  // isn't behind the ADMIN-only reveal gate. Log a scrubbed copy server-side
  // instead (matches the FCM client's `token exchange failed (HTTP ...)`
  // pattern, which also omits the body).
  if (res.statusCode >= 300) {
    log.warn(
      { tokenUrl: creds.tokenUrl, statusCode: res.statusCode, body: scrubPci(maskInlineSecrets(text.slice(0, 300))) },
      'OAuth2 token fetch failed',
    );
    throw new Error(`OAuth2 token fetch failed (HTTP ${res.statusCode})`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    log.warn(
      { tokenUrl: creds.tokenUrl, body: scrubPci(maskInlineSecrets(text.slice(0, 300))) },
      'OAuth2 token endpoint returned a non-JSON response',
    );
    throw new Error('OAuth2 token endpoint returned a non-JSON response');
  }

  const tokenLookup = getByPath(json, creds.tokenPath ?? DEFAULT_TOKEN_PATH);
  if (!tokenLookup.found || typeof tokenLookup.value !== 'string' || !tokenLookup.value) {
    throw new Error(
      `OAuth2 token not found at "${creds.tokenPath ?? DEFAULT_TOKEN_PATH}" in token response`,
    );
  }

  const expiryLookup = getByPath(json, creds.tokenExpiryPath ?? DEFAULT_TOKEN_EXPIRY_PATH);
  const expirySeconds =
    expiryLookup.found && typeof expiryLookup.value === 'number' ? expiryLookup.value : null;
  const expiresAt =
    expirySeconds !== null
      ? expirySeconds * 1000 - SAFETY_MARGIN_MS
      : Date.now() + FALLBACK_TTL_MS - SAFETY_MARGIN_MS;

  return { value: tokenLookup.value, expiresAt };
}

/** Returns a cached, still-fresh token, or fetches and caches a new one. */
export async function getOAuth2Token(creds: OAuth2Credentials): Promise<string> {
  const key = cacheKey(creds);
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  const token = await fetchToken(creds);
  cache.set(key, token);
  return token.value;
}

/** Test seam — drop all cached tokens. */
export function resetOAuth2TokenCache(): void {
  cache.clear();
}
