-- Up Migration
-- Per-target, audited override of the money-moving 5-minute frequency floor
-- (spec Rule 16). Only for targets where the recurring cost of a tighter
-- cadence is unacceptable (e.g. a check that triggers a real purchase) and an
-- ADMIN has explicitly accepted the tradeoff. Riding the existing four-eyes
-- gate for money-moving target changes is the approval mechanism — no
-- separate gating is added here.

ALTER TABLE monitored_apis
  ADD COLUMN bypass_min_interval_floor boolean NOT NULL DEFAULT false;

-- Down Migration
ALTER TABLE monitored_apis
  DROP COLUMN IF EXISTS bypass_min_interval_floor;
