-- Up Migration
-- Phase 23 (Load testing — runner & orchestrator). Plans describe *what* to run,
-- runs are one execution of a plan by a worker, metrics are time-bucketed
-- aggregates (never per-request rows, to bound storage).

CREATE TYPE load_profile AS ENUM ('SMOKE', 'LOAD', 'STRESS', 'SPIKE', 'SOAK', 'BREAKPOINT');
CREATE TYPE load_run_status AS ENUM
  ('QUEUED', 'PREFLIGHT', 'RUNNING', 'COMPLETED', 'ABORTED', 'FAILED');

CREATE TABLE load_test_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_id      uuid NOT NULL REFERENCES monitored_apis (id) ON DELETE CASCADE,
  name        text NOT NULL,
  profile     load_profile NOT NULL,
  config      jsonb NOT NULL,
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX load_test_plans_api_idx ON load_test_plans (api_id);

CREATE TABLE load_test_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id          uuid NOT NULL REFERENCES load_test_plans (id) ON DELETE CASCADE,
  api_id           uuid NOT NULL REFERENCES monitored_apis (id) ON DELETE CASCADE,
  status           load_run_status NOT NULL DEFAULT 'QUEUED',
  -- Frozen copy of the plan + target facts at queue time: a later edit never
  -- changes what a historical run actually did.
  plan_snapshot    jsonb NOT NULL,
  effective_class  load_environment_class,
  requested_by     uuid REFERENCES users (id) ON DELETE SET NULL,
  worker_id        text,
  heartbeat_at     timestamptz,
  abort_requested  boolean NOT NULL DEFAULT false,
  abort_reason     text,
  finished_reason  text,
  error            text,
  summary          jsonb,
  k6_version       text,
  maintenance_window_id uuid,
  queued_at        timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz
);
CREATE INDEX load_test_runs_status_idx ON load_test_runs (status, queued_at);
CREATE INDEX load_test_runs_plan_idx ON load_test_runs (plan_id, queued_at DESC);

CREATE TABLE load_test_metrics (
  run_id        uuid NOT NULL REFERENCES load_test_runs (id) ON DELETE CASCADE,
  bucket_start  timestamptz NOT NULL,
  requests      integer NOT NULL,
  failures      integer NOT NULL,
  rps           numeric(12, 2) NOT NULL,
  avg_ms        numeric(12, 2) NOT NULL,
  p50_ms        numeric(12, 2) NOT NULL,
  p95_ms        numeric(12, 2) NOT NULL,
  p99_ms        numeric(12, 2) NOT NULL,
  max_ms        numeric(12, 2) NOT NULL,
  status_counts jsonb NOT NULL,
  PRIMARY KEY (run_id, bucket_start)
);

-- Down Migration
DROP TABLE IF EXISTS load_test_metrics;
DROP TABLE IF EXISTS load_test_runs;
DROP TABLE IF EXISTS load_test_plans;
DROP TYPE IF EXISTS load_run_status;
DROP TYPE IF EXISTS load_profile;
