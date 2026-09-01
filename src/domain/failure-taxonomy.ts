/**
 * Failure taxonomy (spec §7). The deterministic monitor records a flat
 * `check_failure_type`; this layer maps a check failure onto the operator-facing
 * category tree — Connectivity / Authentication / Application / Database /
 * Dependency / Performance / Configuration — plus a finer sub-type where the
 * evidence supports one.
 *
 * Pure and side-effect free: it reads only the facts already captured on a
 * health-check result (failure type, HTTP status, error message, response
 * sample). Nothing here changes a health status or opens an incident.
 */

import type { CheckFailureType } from './enums.js';

export const FAILURE_CATEGORIES = [
  'CONNECTIVITY',
  'AUTHENTICATION',
  'APPLICATION',
  'DATABASE',
  'DEPENDENCY',
  'PERFORMANCE',
  'CONFIGURATION',
  'NONE',
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export interface FailureFacts {
  failureType: CheckFailureType | null;
  httpStatus: number | null;
  errorMessage: string | null;
  /** PCI-scrubbed response body sample, if any. */
  responseSample?: string | null;
}

export interface FailureClassification {
  category: FailureCategory;
  /** Human sub-type, e.g. "Connection refused", "Query timeout", "HTTP 503". */
  subtype: string;
  /**
   * How sure the mapping is, given only the recorded facts. Deterministic
   * mappings (a 401, a DNS error) are 1; body-pattern guesses are lower.
   */
  confidence: number;
}

/** Signals in a response body / error string that point at a downstream database. */
const DB_HINTS: { re: RegExp; subtype: string }[] = [
  { re: /connection pool|pool (?:exhaust|timeout)|too many connections/i, subtype: 'Connection pool exhaustion' },
  { re: /deadlock/i, subtype: 'Deadlock' },
  { re: /query (?:timeout|timed out)|statement timeout|canceling statement/i, subtype: 'Query timeout' },
  { re: /(?:db|database|postgres|mysql|oracle)[^.]{0,40}(?:unavailable|down|refused|unreachable)/i, subtype: 'Database unavailable' },
  {
    re: /could not connect to (?:database|server)|econnrefused.*5432|no pg_hba|DB_CONNECTION_ERROR|database connection (?:error|failed|failure)|unable to (?:establish|open|acquire)[^.]{0,30}database/i,
    subtype: 'Database connection failure',
  },
];

/** Signals that point at a third-party / upstream dependency rather than the API itself. */
const DEPENDENCY_HINTS: { re: RegExp; subtype: string }[] = [
  { re: /payment gateway|psp|acquirer|card scheme/i, subtype: 'Payment gateway unavailable' },
  { re: /mobile money|momo|mtn|vodafone|airteltigo|telecel/i, subtype: 'Mobile money provider unavailable' },
  { re: /upstream|downstream|third[- ]party|provider (?:error|unavailable|timeout)/i, subtype: 'Third-party API unavailable' },
];

const CONFIG_HINTS: { re: RegExp; subtype: string }[] = [
  { re: /missing (?:required )?(?:parameter|field|param)|is required/i, subtype: 'Missing parameter' },
  { re: /invalid (?:endpoint|url|host)|no route to host/i, subtype: 'Invalid endpoint' },
  { re: /wrong environment|sandbox key.*production|environment mismatch/i, subtype: 'Incorrect environment configuration' },
];

function matchHints(
  text: string,
  hints: { re: RegExp; subtype: string }[],
): string | null {
  for (const h of hints) if (h.re.test(text)) return h.subtype;
  return null;
}

/**
 * Maps recorded failure facts to a category + sub-type. Returns `NONE` when the
 * facts describe a healthy or merely-slow check with no failure type.
 */
export function classifyFailure(facts: FailureFacts): FailureClassification {
  const { failureType, httpStatus } = facts;
  const haystack = `${facts.errorMessage ?? ''}\n${facts.responseSample ?? ''}`;

  // Transport-level failures are unambiguous.
  switch (failureType) {
    case 'DNS_ERROR':
      return { category: 'CONNECTIVITY', subtype: 'DNS resolution failure', confidence: 1 };
    case 'TLS_ERROR':
      return { category: 'CONNECTIVITY', subtype: 'TLS/SSL failure', confidence: 1 };
    case 'CONNECTION_ERROR':
      return {
        category: 'CONNECTIVITY',
        subtype: /refused/i.test(haystack)
          ? 'Connection refused'
          : /unreachable/i.test(haystack)
            ? 'Network unreachable'
            : 'Connection error',
        confidence: 1,
      };
    case 'TIMEOUT': {
      // A timeout with a DB fingerprint in a partial body is more useful as DATABASE.
      const db = matchHints(haystack, DB_HINTS);
      if (db) return { category: 'DATABASE', subtype: db, confidence: 0.6 };
      return { category: 'PERFORMANCE', subtype: 'Connection timeout', confidence: 0.9 };
    }
    case 'RATE_LIMITED':
      return { category: 'PERFORMANCE', subtype: 'Rate limited (HTTP 429)', confidence: 1 };
    case 'AUTHENTICATION_ERROR':
      return {
        category: 'AUTHENTICATION',
        subtype:
          httpStatus === 403
            ? 'Unauthorized request (HTTP 403)'
            : /expired/i.test(haystack)
              ? 'Expired token'
              : /invalid (?:api ?key|credential|token|signature)/i.test(haystack)
                ? 'Invalid credentials'
                : 'Authentication failed (HTTP 401)',
        confidence: 1,
      };
    default:
      break;
  }

  // Body / message pattern matches take precedence over a bare HTTP class:
  // a 500 that says "database connection error" is a DATABASE failure.
  const dbHint = matchHints(haystack, DB_HINTS);
  if (dbHint) return { category: 'DATABASE', subtype: dbHint, confidence: 0.7 };
  const depHint = matchHints(haystack, DEPENDENCY_HINTS);
  if (depHint) return { category: 'DEPENDENCY', subtype: depHint, confidence: 0.65 };
  const cfgHint = matchHints(haystack, CONFIG_HINTS);
  if (cfgHint) return { category: 'CONFIGURATION', subtype: cfgHint, confidence: 0.7 };

  // HTTP-status driven classification.
  if (httpStatus != null) {
    if (httpStatus === 401 || httpStatus === 403) {
      return { category: 'AUTHENTICATION', subtype: `Unauthorized (HTTP ${httpStatus})`, confidence: 0.9 };
    }
    if (httpStatus === 429) {
      return { category: 'PERFORMANCE', subtype: 'Rate limited (HTTP 429)', confidence: 1 };
    }
    if (httpStatus === 404) {
      return { category: 'CONFIGURATION', subtype: 'Endpoint not found (HTTP 404)', confidence: 0.8 };
    }
    if (httpStatus === 502) {
      return { category: 'DEPENDENCY', subtype: 'Bad gateway (HTTP 502)', confidence: 0.8 };
    }
    if (httpStatus === 503) {
      return { category: 'DEPENDENCY', subtype: 'Service unavailable (HTTP 503)', confidence: 0.8 };
    }
    if (httpStatus === 504) {
      return { category: 'DEPENDENCY', subtype: 'Gateway timeout (HTTP 504)', confidence: 0.8 };
    }
    if (httpStatus >= 500) {
      return { category: 'APPLICATION', subtype: `Server error (HTTP ${httpStatus})`, confidence: 0.85 };
    }
    if (httpStatus === 409 || httpStatus === 422 || httpStatus === 400) {
      return { category: 'APPLICATION', subtype: `Client error (HTTP ${httpStatus})`, confidence: 0.8 };
    }
    if (httpStatus >= 400) {
      return { category: 'APPLICATION', subtype: `Client error (HTTP ${httpStatus})`, confidence: 0.7 };
    }
  }

  switch (failureType) {
    case 'VALIDATION_ERROR':
      return { category: 'APPLICATION', subtype: 'Response validation failed', confidence: 0.8 };
    case 'SETTLEMENT_MISMATCH':
      return { category: 'APPLICATION', subtype: 'Settlement mismatch', confidence: 0.9 };
    case 'RECONCILIATION_FAILURE':
      return { category: 'APPLICATION', subtype: 'Reconciliation failure', confidence: 0.9 };
    case 'PARTIAL_DEGRADATION':
      return { category: 'PERFORMANCE', subtype: 'Partial degradation', confidence: 0.7 };
    case 'HTTP_4XX':
      return { category: 'APPLICATION', subtype: 'Client error (4xx)', confidence: 0.6 };
    case 'HTTP_5XX':
      return { category: 'APPLICATION', subtype: 'Server error (5xx)', confidence: 0.6 };
    case 'UNKNOWN':
      return { category: 'APPLICATION', subtype: 'Unclassified failure', confidence: 0.3 };
    case null:
      return { category: 'NONE', subtype: 'No failure', confidence: 1 };
    default:
      return { category: 'APPLICATION', subtype: 'Unclassified failure', confidence: 0.3 };
  }
}
