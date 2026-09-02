-- Up Migration
-- Phase 20 (Retention): BRIN indexes on the time column of the high-volume,
-- append-only tables. Rows arrive in time order, so a BRIN index is tiny and
-- makes the full-table time-range scans (retention sweep, reports, latency
-- baselines) cheap without the write cost of a big btree. This is the
-- low-risk alternative to converting the tables to partitioned — the
-- application-level retention sweep keeps them bounded.

CREATE INDEX IF NOT EXISTS health_check_results_checked_at_brin
  ON health_check_results USING brin (checked_at) WITH (pages_per_range = 32);

CREATE INDEX IF NOT EXISTS health_check_traces_checked_at_brin
  ON health_check_traces USING brin (checked_at) WITH (pages_per_range = 32);

CREATE INDEX IF NOT EXISTS cron_job_runs_scheduled_slot_brin
  ON cron_job_runs USING brin (scheduled_slot) WITH (pages_per_range = 32);

CREATE INDEX IF NOT EXISTS audit_logs_created_at_brin
  ON audit_logs USING brin (created_at) WITH (pages_per_range = 32);

-- Down Migration
DROP INDEX IF EXISTS audit_logs_created_at_brin;
DROP INDEX IF EXISTS cron_job_runs_scheduled_slot_brin;
DROP INDEX IF EXISTS health_check_traces_checked_at_brin;
DROP INDEX IF EXISTS health_check_results_checked_at_brin;
