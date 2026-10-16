-- Up Migration
-- B5/B13: recurring correctness and security suites, so regression evidence (and the
-- compliance matrix built on it) never goes stale. Load runs are deliberately NOT
-- schedulable — traffic at scale must always have a human behind it.
CREATE TABLE load_test_schedules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_id         uuid NOT NULL REFERENCES monitored_apis (id) ON DELETE CASCADE,
  suite          text NOT NULL CHECK (suite IN ('correctness', 'security')),
  cron           text NOT NULL,
  enabled        boolean NOT NULL DEFAULT true,
  next_run_at    timestamptz NOT NULL,
  last_run_at    timestamptz,
  last_run_id    uuid,
  last_outcome   text CHECK (last_outcome IN ('QUEUED', 'REFUSED', 'SKIPPED_BUSY', 'ERROR')),
  last_message   text,
  created_by     uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (api_id, suite)
);
CREATE INDEX load_test_schedules_due_idx ON load_test_schedules (next_run_at) WHERE enabled;

-- Down Migration
DROP TABLE IF EXISTS load_test_schedules;
