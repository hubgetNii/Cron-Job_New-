-- Up Migration
-- Phase 9: authentication (refresh-token rotation) and the four-eyes approval
-- flow for money-moving configuration changes.

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- SHA-256 of the token; the raw token is only ever sent to the client.
  token_hash  text NOT NULL UNIQUE,
  family_id   uuid NOT NULL,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid REFERENCES refresh_tokens (id) ON DELETE SET NULL,
  user_agent  text,
  ip_address  inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_expires_idx ON refresh_tokens (expires_at);

CREATE TYPE config_request_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'APPLIED', 'FAILED');
CREATE TYPE config_request_kind AS ENUM ('target_create', 'target_update');

-- A proposed change to a money-moving target. Proposed by one user, applied only
-- after a *different* ADMIN approves (see vault: "User Roles" — four-eyes).
CREATE TABLE config_change_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          config_request_kind NOT NULL,
  target_id     uuid REFERENCES monitored_apis (id) ON DELETE CASCADE,
  status        config_request_status NOT NULL DEFAULT 'PENDING',
  -- The validated write model to apply on approval.
  payload       jsonb NOT NULL,
  summary       text NOT NULL,
  proposed_by   uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  reviewed_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  review_note   text,
  reviewed_at   timestamptz,
  applied_at    timestamptz,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT config_change_requests_four_eyes
    CHECK (reviewed_by IS NULL OR reviewed_by <> proposed_by)
);

CREATE INDEX config_change_requests_status_idx ON config_change_requests (status);
CREATE INDEX config_change_requests_proposed_by_idx ON config_change_requests (proposed_by);

CREATE TRIGGER config_change_requests_set_updated_at
  BEFORE UPDATE ON config_change_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration
DROP TABLE IF EXISTS config_change_requests;
DROP TYPE IF EXISTS config_request_kind;
DROP TYPE IF EXISTS config_request_status;
DROP TABLE IF EXISTS refresh_tokens;
