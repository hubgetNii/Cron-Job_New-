/**
 * Controlled vocabularies mirrored from the database enums defined in
 * `migrations/1725000001000_enums-and-helpers.sql`.
 *
 * The label sets here and in the database must stay identical; the parity test
 * in `src/db/schema.test.ts` fails the build if they drift.
 */

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const ENVIRONMENTS = ['production', 'staging', 'sandbox'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const ENDPOINT_CLASSES = [
  'payment_initiation',
  'payment_status',
  'ledger',
  'settlement',
  'psp_gateway',
  'kyc',
  'auth',
  'notification',
  'reporting',
  'internal',
  'utility_vending',
] as const;
export type EndpointClass = (typeof ENDPOINT_CLASSES)[number];

export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const AUTH_TYPES = [
  'NONE',
  'API_KEY',
  'BEARER',
  'BASIC',
  'CUSTOM_HEADER',
  'OAUTH2',
] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

export const HEALTH_STATUSES = ['UP', 'DOWN', 'DEGRADED', 'UNKNOWN'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const CHECK_FAILURE_TYPES = [
  'TIMEOUT',
  'DNS_ERROR',
  'CONNECTION_ERROR',
  'TLS_ERROR',
  'HTTP_4XX',
  'HTTP_5XX',
  'AUTHENTICATION_ERROR',
  'VALIDATION_ERROR',
  'SETTLEMENT_MISMATCH',
  'RECONCILIATION_FAILURE',
  'RATE_LIMITED',
  'PARTIAL_DEGRADATION',
  'UNKNOWN',
] as const;
export type CheckFailureType = (typeof CHECK_FAILURE_TYPES)[number];

export const CRON_RUN_STATUSES = [
  'RUNNING',
  'SUCCESS',
  'FAILED',
  'SKIPPED_LOCK_CONTENDED',
  'DEAD_LETTERED',
] as const;
export type CronRunStatus = (typeof CRON_RUN_STATUSES)[number];

export const INCIDENT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_TYPES = ['OUTAGE', 'DEGRADATION', 'FLAPPING'] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];

export const ALERT_TYPES = [
  'API_DOWN',
  'API_RECOVERED',
  'API_DEGRADED',
  'HIGH_LATENCY',
  'AUTHENTICATION_FAILURE',
  'REPEATED_FAILURE',
  'FLAPPING_DETECTED',
  'ESCALATION_TRIGGERED',
  'SLA_BREACH_WARNING',
  'SCHEDULER_HEARTBEAT_MISSED',
  'JOB_EXECUTION_FAILURE',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_CHANNELS = [
  'EMAIL',
  'SMS',
  'WEBHOOK',
  'SLACK',
  'TEAMS',
  'PUSH',
  'PHONE',
] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

export const ALERT_STATUSES = ['PENDING', 'SENT', 'FAILED', 'SUPPRESSED'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const RBAC_ROLES = [
  'ADMIN',
  'OPERATOR',
  'DEVELOPER',
  'COMPLIANCE',
  'MANAGEMENT',
  'VIEWER',
] as const;
export type RbacRole = (typeof RBAC_ROLES)[number];

/** Every database enum type name mapped to its label set, for the parity test. */
export const DB_ENUMS = {
  user_status: USER_STATUSES,
  environment: ENVIRONMENTS,
  endpoint_class: ENDPOINT_CLASSES,
  severity: SEVERITIES,
  http_method: HTTP_METHODS,
  auth_type: AUTH_TYPES,
  health_status: HEALTH_STATUSES,
  check_failure_type: CHECK_FAILURE_TYPES,
  cron_run_status: CRON_RUN_STATUSES,
  incident_status: INCIDENT_STATUSES,
  incident_type: INCIDENT_TYPES,
  alert_type: ALERT_TYPES,
  alert_channel: ALERT_CHANNELS,
  alert_status: ALERT_STATUSES,
} as const satisfies Record<string, readonly string[]>;

/**
 * Default severity per endpoint class (see vault: "Endpoint Classes Overview").
 * Used when a target is registered without an explicit severity.
 */
export const DEFAULT_SEVERITY_BY_CLASS: Record<EndpointClass, Severity> = {
  payment_initiation: 'CRITICAL',
  payment_status: 'CRITICAL',
  ledger: 'CRITICAL',
  settlement: 'CRITICAL',
  psp_gateway: 'CRITICAL',
  kyc: 'HIGH',
  auth: 'HIGH',
  utility_vending: 'HIGH',
  notification: 'MEDIUM',
  reporting: 'LOW',
  internal: 'LOW',
};
