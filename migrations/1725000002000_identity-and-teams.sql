-- Up Migration
-- Users, roles (RBAC) and teams. See vault: "User Roles", "SLA and Governance Tables".

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  description text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The six RBAC roles are fixed reference data (see vault: "Authentication and RBAC").
INSERT INTO roles (key, description) VALUES
  ('ADMIN',      'User management, RBAC, notification/security config, audit review, retention policy'),
  ('OPERATOR',   'Live incident response, acknowledgment, escalation handling, runbook execution'),
  ('DEVELOPER',  'Registers endpoints, configures checks and validation rules, investigates root cause'),
  ('COMPLIANCE', 'Reviews SLA reports, audit logs and incident history for regulatory purposes'),
  ('MANAGEMENT', 'Views uptime, incident trends, SLA compliance, cost-of-downtime summaries'),
  ('VIEWER',     'Dashboard visibility only, no configuration rights');

CREATE TABLE teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER teams_set_updated_at
  BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL UNIQUE,
  full_name      text NOT NULL,
  password_hash  text,
  status         user_status NOT NULL DEFAULT 'active',
  team_id        uuid REFERENCES teams (id) ON DELETE SET NULL,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX users_team_id_idx ON users (team_id);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Many-to-many: a user can hold several roles (needed for the four-eyes rule,
-- where the same person must not both propose and approve a money-moving change).
CREATE TABLE user_roles (
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id     uuid NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  granted_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX user_roles_role_id_idx ON user_roles (role_id);

-- Down Migration
DROP TABLE IF EXISTS user_roles;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS teams;
DROP TABLE IF EXISTS roles;
