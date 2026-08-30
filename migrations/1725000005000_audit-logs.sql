-- Up Migration
-- Append-only audit trail. See vault: "API Security and Audit Immutability".
-- Every configuration change, credential access, RBAC change and incident
-- acknowledgment/resolution is recorded here and can never be modified or deleted
-- through the application layer.

CREATE TABLE audit_logs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One of actor_user_id / actor_label identifies who acted. actor_label carries
  -- system actors such as 'system:scheduler' where there is no user.
  actor_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_label    text,
  action         text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      uuid,
  summary        text,
  -- { before: {...}, after: {...} } — never contains plaintext credentials.
  changes        jsonb,
  ip_address     inet,
  user_agent     text,
  request_id     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_has_actor CHECK (actor_user_id IS NOT NULL OR actor_label IS NOT NULL)
);

CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id);
CREATE INDEX audit_logs_action_idx ON audit_logs (action);
CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at DESC);

-- Defense in depth: block mutation at the database, independent of application
-- logic. Production should additionally REVOKE UPDATE, DELETE on audit_logs from
-- the application role.
CREATE OR REPLACE FUNCTION audit_logs_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_mutation();

CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_mutation();

-- Down Migration
DROP TRIGGER IF EXISTS audit_logs_no_delete ON audit_logs;
DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
DROP FUNCTION IF EXISTS audit_logs_reject_mutation();
DROP TABLE IF EXISTS audit_logs;
