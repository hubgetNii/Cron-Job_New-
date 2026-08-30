-- Up Migration
-- Health-check results, cron execution records, scheduler heartbeats, incidents,
-- alerts and SLA reports. See vault: "Core Monitoring Tables", "Cron Execution
-- Tables", "Incident and Alert Tables", "SLA and Governance Tables".

CREATE TABLE cron_job_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id       uuid NOT NULL REFERENCES monitored_apis (id) ON DELETE CASCADE,
  -- Anchored wall-clock time this run was scheduled for; the drift-correction key.
  scheduled_slot  timestamptz NOT NULL,
  -- Deterministic idempotency key derived from (target_id, scheduled_slot).
  job_run_id      text NOT NULL,
  worker_id       text,
  lock_acquired_at timestamptz,
  started_at      timestamptz,
  completed_at    timestamptz,
  status          cron_run_status NOT NULL DEFAULT 'RUNNING',
  attempt_number  integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cron_job_runs_attempt_positive CHECK (attempt_number >= 1),
  CONSTRAINT cron_job_runs_slot_attempt_unique UNIQUE (target_id, scheduled_slot, attempt_number)
);

CREATE INDEX cron_job_runs_job_run_id_idx ON cron_job_runs (job_run_id);
CREATE INDEX cron_job_runs_status_idx ON cron_job_runs (status);
CREATE INDEX cron_job_runs_slot_idx ON cron_job_runs (scheduled_slot);
CREATE INDEX cron_job_runs_target_slot_idx ON cron_job_runs (target_id, scheduled_slot DESC);

CREATE TABLE health_check_results (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_id            uuid NOT NULL REFERENCES monitored_apis (id) ON DELETE CASCADE,
  -- Correlation back to the cron run that produced this result (soft link:
  -- job_run_id repeats across retry attempts, so it is not a FK).
  job_run_id        text,
  checked_at        timestamptz NOT NULL DEFAULT now(),
  status            health_status NOT NULL,
  http_status       integer,
  response_time_ms  integer,
  error_type        check_failure_type,
  error_message     text,
  validation_result jsonb,
  response_code     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT health_check_results_http_status_range
    CHECK (http_status IS NULL OR (http_status BETWEEN 100 AND 599)),
  CONSTRAINT health_check_results_response_time_valid
    CHECK (response_time_ms IS NULL OR response_time_ms >= 0)
);

CREATE INDEX health_check_results_api_checked_idx
  ON health_check_results (api_id, checked_at DESC);
CREATE UNIQUE INDEX health_check_results_job_run_id_unique
  ON health_check_results (job_run_id) WHERE job_run_id IS NOT NULL;

CREATE TABLE scheduler_heartbeats (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id      text NOT NULL,
  last_tick_at     timestamptz NOT NULL,
  active_job_count integer NOT NULL DEFAULT 0,
  queue_depth      integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX scheduler_heartbeats_instance_idx
  ON scheduler_heartbeats (instance_id, created_at DESC);

CREATE TABLE incidents (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_id                    uuid NOT NULL REFERENCES monitored_apis (id) ON DELETE CASCADE,
  incident_number           text NOT NULL UNIQUE,
  incident_type             incident_type NOT NULL DEFAULT 'OUTAGE',
  severity                  severity NOT NULL,
  -- Snapshots captured at open time so audit history is stable even if the
  -- target's configuration later changes (see vault: "Incident Lifecycle").
  endpoint_class_snapshot   endpoint_class NOT NULL,
  is_money_moving_snapshot  boolean NOT NULL,
  status                    incident_status NOT NULL DEFAULT 'OPEN',
  started_at                timestamptz NOT NULL DEFAULT now(),
  detected_by_check_id      uuid REFERENCES health_check_results (id) ON DELETE SET NULL,
  acknowledged_at           timestamptz,
  acknowledged_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  resolved_at               timestamptz,
  duration_seconds          integer,
  failure_count             integer NOT NULL DEFAULT 1,
  failure_type              check_failure_type,
  escalation_level_reached  integer NOT NULL DEFAULT 0,
  root_cause                text,
  resolution                text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incidents_resolved_after_started
    CHECK (resolved_at IS NULL OR resolved_at >= started_at),
  CONSTRAINT incidents_acknowledged_after_started
    CHECK (acknowledged_at IS NULL OR acknowledged_at >= started_at),
  CONSTRAINT incidents_resolved_consistency
    CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL))
);

-- Enforces "opens a new incident, unless one is already OPEN for this target —
-- never duplicate" (vault: "Incident Lifecycle") at the database level.
CREATE UNIQUE INDEX incidents_one_active_per_target
  ON incidents (api_id) WHERE status <> 'RESOLVED';
CREATE INDEX incidents_api_status_idx ON incidents (api_id, status);
CREATE INDEX incidents_status_idx ON incidents (status);
CREATE INDEX incidents_started_at_idx ON incidents (started_at DESC);

CREATE TRIGGER incidents_set_updated_at
  BEFORE UPDATE ON incidents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable: meta-alerts such as SCHEDULER_HEARTBEAT_MISSED have no incident.
  incident_id   uuid REFERENCES incidents (id) ON DELETE CASCADE,
  api_id        uuid REFERENCES monitored_apis (id) ON DELETE SET NULL,
  alert_type    alert_type NOT NULL,
  channel       alert_channel NOT NULL,
  recipient     text NOT NULL,
  status        alert_status NOT NULL DEFAULT 'PENDING',
  escalation_tier integer,
  sent_at       timestamptz,
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX alerts_incident_idx ON alerts (incident_id);
CREATE INDEX alerts_status_idx ON alerts (status);
CREATE INDEX alerts_type_created_idx ON alerts (alert_type, created_at DESC);

CREATE TABLE sla_reports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_id              uuid NOT NULL REFERENCES monitored_apis (id) ON DELETE CASCADE,
  period_start        timestamptz NOT NULL,
  period_end          timestamptz NOT NULL,
  uptime_percent      numeric(7, 4) NOT NULL,
  downtime_seconds    bigint NOT NULL DEFAULT 0,
  sla_target_percent  numeric(6, 4) NOT NULL,
  sla_met             boolean NOT NULL,
  generated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sla_reports_period_valid CHECK (period_end > period_start),
  CONSTRAINT sla_reports_uptime_range CHECK (uptime_percent >= 0 AND uptime_percent <= 100),
  CONSTRAINT sla_reports_downtime_nonneg CHECK (downtime_seconds >= 0),
  CONSTRAINT sla_reports_period_unique UNIQUE (api_id, period_start, period_end)
);

CREATE INDEX sla_reports_api_period_idx ON sla_reports (api_id, period_end DESC);

-- Down Migration
DROP TABLE IF EXISTS sla_reports;
DROP TABLE IF EXISTS alerts;
DROP TABLE IF EXISTS incidents;
DROP TABLE IF EXISTS scheduler_heartbeats;
DROP TABLE IF EXISTS health_check_results;
DROP TABLE IF EXISTS cron_job_runs;
