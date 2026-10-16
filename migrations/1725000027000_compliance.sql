-- Up Migration
-- Phase 28 (Compliance evidence). Two append-only tables:
--   compliance_reviews        a COMPLIANCE-role reviewer's decision on one control's
--                             evidence mapping, for one library version
--   compliance_evidence_packs a generated, hashed evidence pack (the zip itself is kept
--                             so what was handed to an auditor can be reproduced exactly)
-- Neither is ever updated or deleted by the application; triggers enforce it so a
-- sign-off cannot be quietly rewritten. Retention never prunes them.

CREATE FUNCTION compliance_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'compliance records are append-only (% on %)', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE compliance_reviews (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  control_id       text NOT NULL,
  library_version  text NOT NULL,
  decision         text NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED', 'NEEDS_CHANGE')),
  note             text NOT NULL CHECK (length(note) >= 10),
  -- No FK on purpose: a reviewer's later removal must not rewrite or block history.
  reviewer_id      uuid NOT NULL,
  reviewer_label   text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX compliance_reviews_control_idx ON compliance_reviews (control_id, created_at DESC);

CREATE TABLE compliance_evidence_packs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_id           uuid,
  target_name      text NOT NULL,
  library_version  text NOT NULL,
  manifest_sha256  text NOT NULL,
  zip_sha256       text NOT NULL,
  size_bytes       integer NOT NULL,
  file_count       integer NOT NULL,
  basis            text NOT NULL,
  summary          jsonb NOT NULL,
  zip              bytea NOT NULL,
  created_by       uuid,
  created_by_label text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX compliance_packs_created_idx ON compliance_evidence_packs (created_at DESC);
CREATE INDEX compliance_packs_manifest_idx ON compliance_evidence_packs (manifest_sha256);

CREATE TRIGGER compliance_reviews_append_only
  BEFORE UPDATE OR DELETE ON compliance_reviews
  FOR EACH ROW EXECUTE FUNCTION compliance_forbid_mutation();
CREATE TRIGGER compliance_packs_append_only
  BEFORE UPDATE OR DELETE ON compliance_evidence_packs
  FOR EACH ROW EXECUTE FUNCTION compliance_forbid_mutation();

-- Down Migration
DROP TABLE IF EXISTS compliance_evidence_packs;
DROP TABLE IF EXISTS compliance_reviews;
DROP FUNCTION IF EXISTS compliance_forbid_mutation();
