-- Up Migration
-- Phase 21 (Load testing — safety foundation). Nothing here generates load; it
-- is the gate every later load-test phase must pass through. Deny by default:
-- a target with no config row or no approved authorization cannot be load tested.

CREATE TYPE load_environment_class AS ENUM ('MOCK', 'SANDBOX', 'STAGING', 'PRODUCTION');
CREATE TYPE load_authorization_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REVOKED');

-- Per-target load-testing classification. Distinct from monitored_apis.environment
-- because it adds MOCK and carries the "real side effects" flag (e.g. iSmartPay
-- utility purchases send real airtime/data even in the test environment).
CREATE TABLE load_test_target_config (
  api_id                uuid PRIMARY KEY REFERENCES monitored_apis (id) ON DELETE CASCADE,
  environment_class     load_environment_class NOT NULL,
  has_real_side_effects boolean NOT NULL DEFAULT false,
  updated_by            uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Written approval to load test a target inside a window, within hard caps.
-- Four-eyes: the approver must differ from the proposer (DB-enforced).
CREATE TABLE load_test_authorizations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_id                  uuid NOT NULL REFERENCES monitored_apis (id) ON DELETE CASCADE,
  status                  load_authorization_status NOT NULL DEFAULT 'PENDING',
  reference               text NOT NULL,
  scope                   text NOT NULL,
  window_start            timestamptz NOT NULL,
  window_end              timestamptz NOT NULL,
  max_rps                 integer NOT NULL,
  max_vus                 integer NOT NULL,
  max_duration_seconds    integer NOT NULL,
  allow_real_side_effects boolean NOT NULL DEFAULT false,
  proposed_by             uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  reviewed_by             uuid REFERENCES users (id) ON DELETE SET NULL,
  review_note             text,
  reviewed_at             timestamptz,
  revoked_at              timestamptz,
  revoked_reason          text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT load_authz_window CHECK (window_end > window_start),
  CONSTRAINT load_authz_caps CHECK (max_rps > 0 AND max_vus > 0 AND max_duration_seconds > 0),
  CONSTRAINT load_authz_four_eyes CHECK (reviewed_by IS NULL OR reviewed_by <> proposed_by)
);

CREATE INDEX load_authz_api_idx ON load_test_authorizations (api_id, status);

CREATE TRIGGER load_test_authorizations_set_updated_at
  BEFORE UPDATE ON load_test_authorizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Shared kill switch (single row). DB-backed so a remote load worker honours it.
CREATE TABLE load_test_control (
  singleton   boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  kill_switch boolean NOT NULL DEFAULT false,
  reason      text,
  set_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  set_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO load_test_control (singleton) VALUES (true);

-- Down Migration
DROP TABLE IF EXISTS load_test_control;
DROP TABLE IF EXISTS load_test_authorizations;
DROP TABLE IF EXISTS load_test_target_config;
DROP TYPE IF EXISTS load_authorization_status;
DROP TYPE IF EXISTS load_environment_class;
