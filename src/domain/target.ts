import type { AuthType, EndpointClass, Environment, HttpMethod, Severity } from './enums.js';

/** A single response-validation rule (see vault: "Response Validation Rules"). */
export type ValidationRule =
  | { type: 'status'; equals: number }
  | { type: 'json_equals'; path: string; equals: unknown }
  | { type: 'json_path_equals'; path: string; equals: unknown }
  | { type: 'contains'; value: string; negate?: boolean }
  | { type: 'numeric'; path: string; op: '<' | '<=' | '>' | '>=' | '=='; value: number }
  | { type: 'json_schema'; schema: Record<string, unknown> }
  | { type: 'composite'; mode: 'all' | 'any'; rules: ValidationRule[] };

export interface RetryConfig {
  count: number;
  baseDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
}

/** A monitored target as stored in `monitored_apis`, mapped to camelCase. */
export interface MonitoredApi {
  id: string;
  name: string;
  description: string | null;
  environment: Environment;
  endpointClass: EndpointClass;
  severityDefault: Severity;
  isMoneyMoving: boolean;

  url: string;
  method: HttpMethod;
  authenticationType: AuthType;
  hasCredentials: boolean;
  headers: Record<string, string>;
  requestBody: unknown;

  expectedStatus: number | null;
  expectedResponse: ValidationRule | null;

  timeoutMs: number;
  frequencyCron: string;
  retry: RetryConfig;

  slaTargetPercent: number;
  ownerId: string | null;
  teamId: string | null;
  escalationPolicyId: string | null;

  tags: string[];
  isActive: boolean;
  allowPrivateNetwork: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTargetInput {
  name: string;
  description?: string | null;
  environment?: Environment;
  endpointClass: EndpointClass;
  severityDefault?: Severity;
  isMoneyMoving?: boolean;
  url: string;
  method?: HttpMethod;
  authenticationType?: AuthType;
  credentials?: Record<string, string> | null;
  headers?: Record<string, string>;
  requestBody?: unknown;
  expectedStatus?: number | null;
  expectedResponse?: ValidationRule | null;
  timeoutMs?: number;
  frequencyCron: string;
  retry?: Partial<RetryConfig>;
  slaTargetPercent?: number;
  ownerId?: string | null;
  teamId?: string | null;
  escalationPolicyId?: string | null;
  tags?: string[];
  isActive?: boolean;
  allowPrivateNetwork?: boolean;
}

export type UpdateTargetInput = Partial<CreateTargetInput>;

/** Minimum seconds between checks for a money-moving target (spec Rule 16). */
export const MONEY_MOVING_MIN_INTERVAL_SECONDS = 300;
