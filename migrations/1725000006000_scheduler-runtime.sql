-- Up Migration
-- Runtime state for the cron engine (see vault: "05 Cron Engine").
--   job_locks             - per-(target, slot) distributed lock with TTL
--   target_schedule_state - last expected/actual run + recovery counters per target

CREATE TABLE job_locks (
  key         text PRIMARY KEY,
  holder      text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE INDEX job_locks_expires_at_idx ON job_locks (expires_at);

CREATE TABLE target_schedule_state (
  target_id            uuid PRIMARY KEY REFERENCES monitored_apis (id) ON DELETE CASCADE,
  last_expected_run_at timestamptz,
  last_actual_run_at   timestamptz,
  last_status          health_status,
  consecutive_successes integer NOT NULL DEFAULT 0,
  consecutive_failures  integer NOT NULL DEFAULT 0,
  missed_run_count      integer NOT NULL DEFAULT 0,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER target_schedule_state_set_updated_at
  BEFORE UPDATE ON target_schedule_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration
DROP TABLE IF EXISTS target_schedule_state;
DROP TABLE IF EXISTS job_locks;
