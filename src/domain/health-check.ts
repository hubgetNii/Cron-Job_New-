import type { CheckFailureType, HealthStatus } from './enums.js';
import type { RuleResult } from '../services/health-check/validator.service.js';

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
  checkedAt: Date;
}
