import { describe, expect, it } from 'vitest';
import {
  classifyHttpStatus,
  classifyTransportError,
  RETRYABLE_FAILURES,
} from './failure-classifier.js';

describe('classifyTransportError', () => {
  it.each([
    [{ name: 'TimeoutError' }, 'TIMEOUT'],
    [{ code: 'UND_ERR_HEADERS_TIMEOUT' }, 'TIMEOUT'],
    [{ code: 'ENOTFOUND' }, 'DNS_ERROR'],
    [{ code: 'ECONNREFUSED' }, 'CONNECTION_ERROR'],
    [{ code: 'ECONNRESET' }, 'CONNECTION_ERROR'],
    [{ code: 'CERT_HAS_EXPIRED' }, 'TLS_ERROR'],
    [{ message: 'unable to get local issuer certificate' }, 'TLS_ERROR'],
    [{ code: 'SOMETHING_ELSE' }, 'UNKNOWN'],
  ] as const)('classifies %o as %s', (err, expected) => {
    expect(classifyTransportError(err)).toBe(expected);
  });

  it('reads a nested cause code', () => {
    expect(
      classifyTransportError({ message: 'fetch failed', cause: { code: 'ECONNREFUSED' } }),
    ).toBe('CONNECTION_ERROR');
  });
});

describe('classifyHttpStatus', () => {
  it.each([
    [401, 'AUTHENTICATION_ERROR'],
    [403, 'AUTHENTICATION_ERROR'],
    [429, 'RATE_LIMITED'],
    [404, 'HTTP_4XX'],
    [502, 'HTTP_5XX'],
  ] as const)('maps %i to %s', (status, expected) => {
    expect(classifyHttpStatus(status)).toBe(expected);
  });
});

describe('RETRYABLE_FAILURES', () => {
  it('retries transient failures but not deterministic ones', () => {
    expect(RETRYABLE_FAILURES.has('TIMEOUT')).toBe(true);
    expect(RETRYABLE_FAILURES.has('HTTP_5XX')).toBe(true);
    expect(RETRYABLE_FAILURES.has('HTTP_4XX')).toBe(false);
    expect(RETRYABLE_FAILURES.has('VALIDATION_ERROR')).toBe(false);
    expect(RETRYABLE_FAILURES.has('AUTHENTICATION_ERROR')).toBe(false);
  });
});
