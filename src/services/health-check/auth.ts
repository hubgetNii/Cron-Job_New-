import type { AuthType } from '../../domain/enums.js';

/**
 * Builds the auth headers (and query params, for schemes that use them) for an
 * outbound health check. Credentials are the already-decrypted values from the
 * credential envelope; they are never logged.
 *
 * Conventions per credential key:
 *   API_KEY        -> { header?, query?, value }         (default header: X-API-Key)
 *   BEARER         -> { token }
 *   BASIC          -> { username, password }
 *   CUSTOM_HEADER  -> { name, value }
 *   iSmartPay merchant integration uses API_KEY-style { apiId, apiSecret }.
 */
export interface AuthMaterial {
  headers: Record<string, string>;
  query: Record<string, string>;
}

const EMPTY: AuthMaterial = { headers: {}, query: {} };

export function buildAuthMaterial(
  type: AuthType,
  creds: Record<string, string> | null,
): AuthMaterial {
  if (type === 'NONE' || type === 'OAUTH2' || !creds) return { headers: {}, query: {} };

  switch (type) {
    case 'API_KEY': {
      if (creds['apiId'] && creds['apiSecret']) {
        return { headers: { apiId: creds['apiId'], apiSecret: creds['apiSecret'] }, query: {} };
      }
      const value = creds['value'] ?? creds['apiKey'] ?? creds['key'] ?? '';
      if (!value) return EMPTY;
      if (creds['query']) return { headers: {}, query: { [creds['query']]: value } };
      return { headers: { [creds['header'] ?? 'X-API-Key']: value }, query: {} };
    }
    case 'BEARER': {
      const token = creds['token'] ?? creds['accessToken'] ?? '';
      return token ? { headers: { Authorization: `Bearer ${token}` }, query: {} } : EMPTY;
    }
    case 'BASIC': {
      const user = creds['username'] ?? '';
      const pass = creds['password'] ?? '';
      const encoded = Buffer.from(`${user}:${pass}`).toString('base64');
      return { headers: { Authorization: `Basic ${encoded}` }, query: {} };
    }
    case 'CUSTOM_HEADER': {
      const name = creds['name'] ?? creds['header'];
      const value = creds['value'];
      return name && value ? { headers: { [name]: value }, query: {} } : EMPTY;
    }
    default:
      return EMPTY;
  }
}
