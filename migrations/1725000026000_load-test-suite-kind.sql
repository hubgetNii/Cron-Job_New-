-- Up Migration
-- Phase 26: the security suite reuses the correctness-run pipeline (same safety
-- gate, worker, evidence format). A run records which suite it executed.

ALTER TABLE load_test_correctness_runs
  ADD COLUMN suite text NOT NULL DEFAULT 'correctness'
  CHECK (suite IN ('correctness', 'security'));

CREATE INDEX load_test_correctness_runs_suite_idx
  ON load_test_correctness_runs (suite, queued_at DESC);

-- Down Migration
DROP INDEX IF EXISTS load_test_correctness_runs_suite_idx;
ALTER TABLE load_test_correctness_runs DROP COLUMN IF EXISTS suite;
