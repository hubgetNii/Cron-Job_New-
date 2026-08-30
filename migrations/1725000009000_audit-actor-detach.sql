-- Up Migration
-- The append-only trigger on audit_logs also blocked the FK's ON DELETE SET
-- NULL when a user is removed. Allow exactly that one system operation —
-- detaching a deleted actor — and nothing else. Application UPDATE/DELETE stay
-- forbidden. Every audit row also carries a denormalised actor label, so the
-- detach loses no information.

-- Backfill: older rows stored either the user id or the label, never both.
-- Give every row a label so the detach never violates audit_logs_has_actor.
ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update;
UPDATE audit_logs
  SET actor_label = 'user:' || actor_user_id
  WHERE actor_label IS NULL AND actor_user_id IS NOT NULL;
ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_update;

CREATE OR REPLACE FUNCTION audit_logs_reject_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.actor_user_id IS NOT NULL AND NEW.actor_user_id IS NULL
     AND NEW.actor_label IS NOT DISTINCT FROM OLD.actor_label
     AND NEW.action = OLD.action
     AND NEW.entity_type = OLD.entity_type
     AND NEW.entity_id IS NOT DISTINCT FROM OLD.entity_id
     AND NEW.summary IS NOT DISTINCT FROM OLD.summary
     AND NEW.changes IS NOT DISTINCT FROM OLD.changes
     AND NEW.created_at = OLD.created_at
  THEN
    RETURN NEW; -- FK ON DELETE SET NULL detaching a removed user
  END IF;

  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- Down Migration
CREATE OR REPLACE FUNCTION audit_logs_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
