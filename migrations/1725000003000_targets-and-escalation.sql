-- Up Migration
-- Monitored targets and the escalation / on-call / maintenance structures they
-- reference. See vault: "Target Registration", "Core Monitoring Tables",
-- "Incident and Alert Tables", "Alerting and Escalation".

CREATE TABLE escalation_policies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  description text,
  -- Ordered list of { delay_minutes, channel, recipients, condition? }.
  tiers       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT escalation_policies_tiers_is_array CHECK (jsonb_typeof(tiers) = 'array')
);

CREATE TRIGGER escalation_policies_set_updated_at
  BEFORE UPDATE ON escalation_policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE on_call_schedules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT on_call_schedules_window_valid CHECK (ends_at > starts_at)
);

CREATE INDEX on_call_schedules_team_window_idx
  ON on_call_schedules (team_id, starts_at, ends_at);

CREATE TABLE monitored_apis (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     text NOT NULL,
  description              text,
  environment              environment NOT NULL DEFAULT 'production',
  endpoint_class           endpoint_class NOT NULL,
  severity_default         severity NOT NULL,
  is_money_moving          boolean NOT NULL DEFAULT false,

  url                      text NOT NULL,
  method                   http_method NOT NULL DEFAULT 'GET',
  authentication_type      auth_type NOT NULL DEFAULT 'NONE',
  -- Envelope-encrypted payload: { ciphertext, iv, wrappedKey, keyId, alg }.
  -- Plaintext credentials are NEVER stored here (see vault: "Credential Encryption").
  encrypted_credentials    jsonb,
  headers                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_body             jsonb,

  expected_status          integer,
  -- Validation rule(s): a single rule object or a composite. See vault:
  -- "Response Validation Rules".
  expected_response        jsonb,

  timeout_ms               integer NOT NULL DEFAULT 8000,
  frequency_cron           text NOT NULL,

  -- Retry/backoff knobs required by spec section 8.7 (extends the base spec's
  -- single retry_backoff_ms field).
  retry_count              integer NOT NULL DEFAULT 2,
  retry_base_delay_ms      integer NOT NULL DEFAULT 1000,
  retry_backoff_multiplier numeric(4, 2) NOT NULL DEFAULT 2.0,
  retry_max_delay_ms       integer NOT NULL DEFAULT 5000,

  sla_target_percent       numeric(6, 4) NOT NULL DEFAULT 99.9500,
  owner_id                 uuid REFERENCES users (id) ON DELETE SET NULL,
  team_id                  uuid REFERENCES teams (id) ON DELETE SET NULL,
  escalation_policy_id     uuid REFERENCES escalation_policies (id) ON DELETE SET NULL,

  tags                     text[] NOT NULL DEFAULT '{}',
  is_active                boolean NOT NULL DEFAULT true,

  -- SSRF override: internal/private target URLs are blocked by default and only
  -- reachable with an explicit, audited administrator override (vault:
  -- "Credential Encryption and SSRF Protection").
  allow_private_network    boolean NOT NULL DEFAULT false,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT monitored_apis_timeout_positive CHECK (timeout_ms > 0),
  CONSTRAINT monitored_apis_retry_count_valid CHECK (retry_count >= 0 AND retry_count <= 10),
  CONSTRAINT monitored_apis_retry_delays_valid
    CHECK (retry_base_delay_ms >= 0 AND retry_max_delay_ms >= retry_base_delay_ms),
  CONSTRAINT monitored_apis_backoff_valid CHECK (retry_backoff_multiplier >= 1.0),
  CONSTRAINT monitored_apis_sla_range CHECK (sla_target_percent > 0 AND sla_target_percent <= 100),
  CONSTRAINT monitored_apis_expected_status_range
    CHECK (expected_status IS NULL OR (expected_status BETWEEN 100 AND 599)),
  CONSTRAINT monitored_apis_name_env_unique UNIQUE (name, environment)
);

CREATE INDEX monitored_apis_active_idx ON monitored_apis (is_active);
CREATE INDEX monitored_apis_endpoint_class_idx ON monitored_apis (endpoint_class);
CREATE INDEX monitored_apis_money_moving_idx ON monitored_apis (is_money_moving) WHERE is_money_moving;
CREATE INDEX monitored_apis_team_id_idx ON monitored_apis (team_id);
CREATE INDEX monitored_apis_tags_gin ON monitored_apis USING gin (tags);

CREATE TRIGGER monitored_apis_set_updated_at
  BEFORE UPDATE ON monitored_apis
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE maintenance_windows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL target_id = a global maintenance window.
  target_id   uuid REFERENCES monitored_apis (id) ON DELETE CASCADE,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  reason      text NOT NULL,
  ticket_ref  text,
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maintenance_windows_window_valid CHECK (ends_at > starts_at)
);

CREATE INDEX maintenance_windows_target_idx ON maintenance_windows (target_id);
CREATE INDEX maintenance_windows_window_idx ON maintenance_windows (starts_at, ends_at);

-- Down Migration
DROP TABLE IF EXISTS maintenance_windows;
DROP TABLE IF EXISTS monitored_apis;
DROP TABLE IF EXISTS on_call_schedules;
DROP TABLE IF EXISTS escalation_policies;
