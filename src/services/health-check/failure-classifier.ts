import type { CheckFailureType } from '../../domain/enums.js';

/** Failure types that a retry might clear (see vault: "Failure Classification and Retry Backoff"). */
export const RETRYABLE_FAILURES: ReadonlySet<CheckFailureType> = new Set<CheckFailureType>([
  'TIMEOUT',
  'DNS_ERROR',
  'CONNECTION_ERROR',
  'TLS_ERROR',
  'HTTP_5XX',
  'RATE_LIMITED',
]);

/** Maps a thrown transport error to a failure type. */
export function classifyTransportError(err: unknown): CheckFailureType {
  if (typeof err === 'object' && err !== null) {
    const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string } };
    const code = e.code ?? e.cause?.code ?? '';
    const message = (e.message ?? '').toLowerCase();

    if (
      e.name === 'AbortError' ||
      e.name === 'TimeoutError' ||
      code === 'UND_ERR_HEADERS_TIMEOUT' ||
      code === 'UND_ERR_BODY_TIMEOUT' ||
      code === 'UND_ERR_CONNECT_TIMEOUT'
    ) {
      return 'TIMEOUT';
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || message.includes('getaddrinfo')) {
      return 'DNS_ERROR';
    }
    if (
      code.startsWith('ERR_TLS') ||
      code === 'CERT_HAS_EXPIRED' ||
      code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
      code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
      message.includes('certificate') ||
      message.includes('tls')
    ) {
      return 'TLS_ERROR';
    }
    if (
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET' ||
      code === 'EHOSTUNREACH' ||
      code === 'ENETUNREACH' ||
      code === 'EPIPE' ||
      code === 'UND_ERR_SOCKET'
    ) {
      return 'CONNECTION_ERROR';
    }
  }
  return 'UNKNOWN';
}

/** Maps an HTTP status code to a failure type (only called for non-passing responses). */
export function classifyHttpStatus(status: number): CheckFailureType {
  if (status === 401 || status === 403) return 'AUTHENTICATION_ERROR';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'HTTP_5XX';
  if (status >= 400) return 'HTTP_4XX';
  return 'VALIDATION_ERROR';
}
