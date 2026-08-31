-- Up Migration
-- SMS digest notifications. Unlike the per-event channels (WEBHOOK / SLACK /
-- EMAIL / PUSH), SMS is a *summary* channel: a periodic job snapshots overall
-- system health and sends at most one SMS, and only when the overall level
-- changes (HEALTHY / DEGRADED / CRITICAL). Every snapshot is recorded here for
-- history regardless of whether an SMS went out (see vault: "SMS Health Digest
-- Notifications").

CREATE TYPE system_health_level AS ENUM ('HEALTHY', 'DEGRADED', 'CRITICAL');

CREATE TABLE health_digests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generated_at       timestamptz NOT NULL DEFAULT now(),
  overall_level      system_health_level NOT NULL,
  previous_level     system_health_level,          -- null for the first digest
  total_services     integer NOT NULL,
  healthy_services   integer NOT NULL,
  degraded_services  integer NOT NULL,
  down_services      integer NOT NULL,
  -- [{ name, status, endpointClass, isMoneyMoving }] for services needing attention
  affected           jsonb NOT NULL DEFAULT '[]'::jsonb,
  sms_sent           boolean NOT NULL DEFAULT false,
  sms_recipients     integer NOT NULL DEFAULT 0,
  reason             text NOT NULL,                 -- why an SMS was sent, or why suppressed
  next_check_at      timestamptz,
  CONSTRAINT health_digests_counts_nonneg
    CHECK (total_services >= 0 AND healthy_services >= 0
       AND degraded_services >= 0 AND down_services >= 0)
);

CREATE INDEX health_digests_generated_idx ON health_digests (generated_at DESC);

-- Down Migration
DROP TABLE IF EXISTS health_digests;
DROP TYPE IF EXISTS system_health_level;
