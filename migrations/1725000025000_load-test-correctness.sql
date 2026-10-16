-- Up Migration
-- Phase 25: correctness-suite runs. A suite is a small, deterministic set of
-- checks (idempotency, duplicate references, refunds, webhooks, reconciliation)
-- — NOT load — but it sends real requests, so it goes through the same safety
-- gate and the same worker as load runs.

CREATE TABLE load_test_correctness_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_id           uuid NOT NULL REFERENCES monitored_apis (id) ON DELETE CASCADE,
  status           load_run_status NOT NULL DEFAULT 'QUEUED',
  -- 'simulator' (control plane available: race/ledger/timeout checks run) or 'live'.
  mode             text,
  effective_class  load_environment_class,
  selected_checks  text[] NOT NULL DEFAULT '{}',
  requested_by     uuid REFERENCES users (id) ON DELETE SET NULL,
  worker_id        text,
  heartbeat_at     timestamptz,
  results          jsonb,
  summary          jsonb,
  error            text,
  queued_at        timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz
);
CREATE INDEX load_test_correctness_runs_status_idx ON load_test_correctness_runs (status, queued_at);
CREATE INDEX load_test_correctness_runs_api_idx ON load_test_correctness_runs (api_id, queued_at DESC);

-- Down Migration
DROP TABLE IF EXISTS load_test_correctness_runs;
