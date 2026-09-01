import { describe, expect, it } from 'vitest';
import { recommendationFor } from './recommendations.js';

describe('recommendationFor', () => {
  it('keys off the HTTP status first', () => {
    const r = recommendationFor({ category: 'AUTHENTICATION', failureType: 'AUTHENTICATION_ERROR', httpStatus: 401 });
    expect(r.finding).toMatch(/401/);
    expect(r.recommendation).toMatch(/token expiry/i);
  });

  it('falls back to the failure type, then the category', () => {
    expect(recommendationFor({ category: 'CONNECTIVITY', failureType: 'DNS_ERROR', httpStatus: null }).recommendation)
      .toMatch(/DNS configuration/i);
    expect(recommendationFor({ category: 'DATABASE', failureType: null, httpStatus: null }).recommendation)
      .toMatch(/connection-pool/i);
  });

  it('raises priority and annotates on the 3rd occurrence in 24h', () => {
    const once = recommendationFor({ category: 'APPLICATION', failureType: 'HTTP_5XX', httpStatus: 500, occurrences24h: 1 });
    const thrice = recommendationFor({ category: 'APPLICATION', failureType: 'HTTP_5XX', httpStatus: 500, occurrences24h: 3 });
    expect(once.priority).toBe('P1'); // 500 is already P1
    expect(thrice.recommendation).toMatch(/#3 in the last 24h/);
  });

  it('notes a large latency deviation', () => {
    const r = recommendationFor({ category: 'PERFORMANCE', failureType: 'TIMEOUT', httpStatus: null, latencyRatio: 5.2 });
    expect(r.recommendation).toMatch(/5\.2× the baseline/);
  });

  it('502/503/504 point at the gateway / upstream', () => {
    expect(recommendationFor({ category: 'DEPENDENCY', failureType: 'HTTP_5XX', httpStatus: 502 }).recommendation)
      .toMatch(/gateway|upstream/i);
    expect(recommendationFor({ category: 'DEPENDENCY', failureType: 'HTTP_5XX', httpStatus: 504 }).recommendation)
      .toMatch(/upstream/i);
  });
});
