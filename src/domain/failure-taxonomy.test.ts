import { describe, expect, it } from 'vitest';
import { classifyFailure } from './failure-taxonomy.js';

describe('classifyFailure', () => {
  it('maps transport failures to CONNECTIVITY / PERFORMANCE deterministically', () => {
    expect(classifyFailure({ failureType: 'DNS_ERROR', httpStatus: null, errorMessage: null }))
      .toMatchObject({ category: 'CONNECTIVITY', confidence: 1 });
    expect(classifyFailure({ failureType: 'TLS_ERROR', httpStatus: null, errorMessage: null }).category)
      .toBe('CONNECTIVITY');
    expect(
      classifyFailure({ failureType: 'CONNECTION_ERROR', httpStatus: null, errorMessage: 'connect ECONNREFUSED' }),
    ).toMatchObject({ category: 'CONNECTIVITY', subtype: 'Connection refused' });
    expect(classifyFailure({ failureType: 'TIMEOUT', httpStatus: null, errorMessage: 'timed out' }).category)
      .toBe('PERFORMANCE');
  });

  it('routes auth failures to AUTHENTICATION with a token/credential sub-type', () => {
    expect(
      classifyFailure({
        failureType: 'AUTHENTICATION_ERROR',
        httpStatus: 401,
        errorMessage: 'token has expired',
      }),
    ).toMatchObject({ category: 'AUTHENTICATION', subtype: 'Expired token' });
    expect(
      classifyFailure({ failureType: 'AUTHENTICATION_ERROR', httpStatus: 403, errorMessage: null }).subtype,
    ).toMatch(/403/);
  });

  it('promotes a 500 with a database fingerprint to DATABASE', () => {
    const c = classifyFailure({
      failureType: 'HTTP_5XX',
      httpStatus: 500,
      errorMessage: 'Unexpected response (HTTP 500)',
      responseSample: '{"code":"DB_CONNECTION_ERROR","message":"Unable to establish database connection"}',
    });
    expect(c.category).toBe('DATABASE');
    expect(c.subtype).toBe('Database connection failure');
  });

  it('classifies 502/503/504 as DEPENDENCY and plain 500 as APPLICATION', () => {
    expect(classifyFailure({ failureType: 'HTTP_5XX', httpStatus: 503, errorMessage: null }).category)
      .toBe('DEPENDENCY');
    expect(classifyFailure({ failureType: 'HTTP_5XX', httpStatus: 500, errorMessage: null }).category)
      .toBe('APPLICATION');
  });

  it('classifies 404 as CONFIGURATION and 429 as PERFORMANCE', () => {
    expect(classifyFailure({ failureType: 'HTTP_4XX', httpStatus: 404, errorMessage: null }).category)
      .toBe('CONFIGURATION');
    expect(classifyFailure({ failureType: 'RATE_LIMITED', httpStatus: 429, errorMessage: null }).category)
      .toBe('PERFORMANCE');
  });

  it('detects a mobile-money dependency from the body', () => {
    const c = classifyFailure({
      failureType: 'HTTP_5XX',
      httpStatus: 500,
      errorMessage: null,
      responseSample: 'MTN MoMo provider returned an error',
    });
    expect(c.category).toBe('DEPENDENCY');
  });

  it('returns NONE for a healthy check', () => {
    expect(classifyFailure({ failureType: null, httpStatus: 200, errorMessage: null }))
      .toMatchObject({ category: 'NONE' });
  });
});
