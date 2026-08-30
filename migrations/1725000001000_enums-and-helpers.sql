-- Up Migration
-- Controlled vocabularies for the whole schema + a shared updated_at trigger.
-- Enum label sets are mirrored in src/domain/enums.ts and guarded by a parity test.

CREATE TYPE user_status AS ENUM ('active', 'disabled');

CREATE TYPE environment AS ENUM ('production', 'staging', 'sandbox');

-- Endpoint classes (see vault: "Endpoint Classes Overview"). `utility_vending`
-- is added for iSmartPay's ECG/GWCL/airtime/data/broadband/pay-TV providers.
CREATE TYPE endpoint_class AS ENUM (
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
  'utility_vending'
);

CREATE TYPE severity AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

CREATE TYPE http_method AS ENUM ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD');

CREATE TYPE auth_type AS ENUM (
  'NONE',
  'API_KEY',
  'BEARER',
  'BASIC',
  'CUSTOM_HEADER',
  'OAUTH2'
);

CREATE TYPE health_status AS ENUM ('UP', 'DOWN', 'DEGRADED', 'UNKNOWN');

-- Failure classification (see vault: "Failure Classification and Retry Backoff").
CREATE TYPE check_failure_type AS ENUM (
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
  'UNKNOWN'
);

-- Cron run outcomes (see vault: "Cron Execution Tables").
CREATE TYPE cron_run_status AS ENUM (
  'RUNNING',
  'SUCCESS',
  'FAILED',
  'SKIPPED_LOCK_CONTENDED',
  'DEAD_LETTERED'
);

CREATE TYPE incident_status AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- FLAPPING is a distinct incident type, not a rapid open/close cycle
-- (see vault: "Incident Lifecycle").
CREATE TYPE incident_type AS ENUM ('OUTAGE', 'DEGRADATION', 'FLAPPING');

CREATE TYPE alert_type AS ENUM (
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
  'JOB_EXECUTION_FAILURE'
);

CREATE TYPE alert_channel AS ENUM (
  'EMAIL',
  'SMS',
  'WEBHOOK',
  'SLACK',
  'TEAMS',
  'PUSH',
  'PHONE'
);

CREATE TYPE alert_status AS ENUM ('PENDING', 'SENT', 'FAILED', 'SUPPRESSED');

-- Shared trigger: keep updated_at honest on any table that has the column.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Down Migration
DROP FUNCTION IF EXISTS set_updated_at();
DROP TYPE IF EXISTS alert_status;
DROP TYPE IF EXISTS alert_channel;
DROP TYPE IF EXISTS alert_type;
DROP TYPE IF EXISTS incident_type;
DROP TYPE IF EXISTS incident_status;
DROP TYPE IF EXISTS cron_run_status;
DROP TYPE IF EXISTS check_failure_type;
DROP TYPE IF EXISTS health_status;
DROP TYPE IF EXISTS auth_type;
DROP TYPE IF EXISTS http_method;
DROP TYPE IF EXISTS severity;
DROP TYPE IF EXISTS endpoint_class;
DROP TYPE IF EXISTS environment;
DROP TYPE IF EXISTS user_status;
