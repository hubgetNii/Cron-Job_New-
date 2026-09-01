-- Up Migration
-- Phase 15 (Intelligence): deterministic root-cause analysis attached to an
-- incident. `root_cause` (free text, human-editable) stays as-is; `rca` holds
-- the structured, machine-generated analysis — category, evidence, probable
-- cause, confidence, impact and the recommended next step (see
-- docs/observability-and-reporting-plan.md §8–9). It is ADVISORY: it never
-- changes the incident's status, severity or lifecycle.

ALTER TABLE incidents
  ADD COLUMN rca            jsonb,
  ADD COLUMN rca_updated_at timestamptz;

-- Down Migration
ALTER TABLE incidents
  DROP COLUMN IF EXISTS rca,
  DROP COLUMN IF EXISTS rca_updated_at;
