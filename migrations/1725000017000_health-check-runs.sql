-- Up Migration
-- Phase 13 (Observability): Health Check Runs (spec §2).
--
-- The scheduler fires per-target anchored slots, so there is no single "sweep".
-- A run is a roll-up over one time window (HEALTH_CHECK_RUN_INTERVAL_MINUTES):
-- it aggregates every check that landed in the window into one record with a
-- human Health Check ID (HC-YYYYMMDD-HHMMSS-NNNNNN), an overall status, and the
-- healthy / degraded / failed counts. Each health_check_results row is then
-- back-linked to its run.

CREATE SEQUENCE health_check_run_seq;

CREATE TABLE health_check_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hc_id            text NOT NULL UNIQUE,
  window_start     timestamptz NOT NULL,
  window_end       timestamptz NOT NULL,
  -- null when the window spans more than one environment
  environment      environment,
  services_tested  integer NOT NULL DEFAULT 0,
  healthy          integer NOT NULL DEFAULT 0,
  degraded         integer NOT NULL DEFAULT 0,
  failed           integer NOT NULL DEFAULT 0,
  unknown          integer NOT NULL DEFAULT 0,
  checks_total     integer NOT NULL DEFAULT 0,
  overall_status   system_health_level NOT NULL,
  duration_ms      integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT health_check_runs_window_valid CHECK (window_end >= window_start),
  CONSTRAINT health_check_runs_counts_nonneg
    CHECK (services_tested >= 0 AND healthy >= 0 AND degraded >= 0
       AND failed >= 0 AND unknown >= 0 AND checks_total >= 0)
);

CREATE INDEX health_check_runs_window_idx ON health_check_runs (window_end DESC);

ALTER TABLE health_check_results
  ADD COLUMN hc_run_id uuid REFERENCES health_check_runs (id) ON DELETE SET NULL;

CREATE INDEX health_check_results_hc_run_idx
  ON health_check_results (hc_run_id) WHERE hc_run_id IS NOT NULL;

-- Down Migration
ALTER TABLE health_check_results DROP COLUMN IF EXISTS hc_run_id;
DROP TABLE IF EXISTS health_check_runs;
DROP SEQUENCE IF EXISTS health_check_run_seq;
