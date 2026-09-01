import type { CheckFailureType, HealthStatus, HttpMethod } from './enums.js';
import type { RuleResult } from '../services/health-check/validator.service.js';

/**
 * Full request/response capture for one check attempt (spec §3–5). `*Masked`
 * fields have secrets/PII already redacted; `raw` holds the true values and is
 * persisted encrypted, ADMIN-reveal only.
 */
export interface RequestResponseTrace {
  requestMethod: HttpMethod;
  requestUrlMasked: string;
  requestHeadersMasked: Record<string, string>;
  requestBodyMasked: string | null;
  responseStatus: number | null;
  responseHeadersMasked: Record<string, string>;
  responseBodyMasked: string | null;
  responseBytes: number | null;
  responseContentType: string | null;
  responseTimeMs: number | null;
  /** True (unmasked) request + response, for the encrypted at-rest copy. */
  raw: {
    requestUrl: string;
    requestHeaders: Record<string, string>;
    requestBody: string | null;
    responseHeaders: Record<string, string>;
    responseBody: string | null;
  };
}

export interface HealthCheckOutcome {
  status: HealthStatus;
  httpStatus: number | null;
  responseTimeMs: number | null;
  failureType: CheckFailureType | null;
  errorMessage: string | null;
  validation: { passed: boolean; results: RuleResult[] } | null;
  /** Total attempts made, including the first (1 = no retries needed). */
  attempts: number;
  /** Truncated, PCI-scrubbed sample of the response body, for debugging. */
  responseSample: string | null;
  /** Full request/response capture from the final attempt (spec §3–5). */
  trace: RequestResponseTrace | null;
  checkedAt: Date;
}
