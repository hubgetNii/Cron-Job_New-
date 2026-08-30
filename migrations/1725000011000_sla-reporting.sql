-- Up Migration
-- Phase 11: reporting. Extends sla_reports with the period kind (rolling 30-day
-- vs calendar month) and the maintenance-window carve-out. Time inside an
-- approved maintenance window is still recorded as downtime but excluded from
-- the SLA-breach calculation (see vault: "SLA and Uptime").

ALTER TABLE sla_reports
  ADD COLUMN period_kind      text    NOT NULL DEFAULT 'calendar_month',
  ADD COLUMN excluded_seconds bigint  NOT NULL DEFAULT 0,
  ADD COLUMN total_checks     integer NOT NULL DEFAULT 0,
  ADD COLUMN failed_checks    integer NOT NULL DEFAULT 0;

ALTER TABLE sla_reports
  ADD CONSTRAINT sla_reports_period_kind_valid
    CHECK (period_kind IN ('rolling_30d', 'calendar_month')),
  ADD CONSTRAINT sla_reports_excluded_nonneg CHECK (excluded_seconds >= 0);

-- One live rolling-window row per target; upserted on every report run.
CREATE UNIQUE INDEX sla_reports_rolling_current
  ON sla_reports (api_id)
  WHERE period_kind = 'rolling_30d';

-- Down Migration
DROP INDEX IF EXISTS sla_reports_rolling_current;
ALTER TABLE sla_reports
  DROP CONSTRAINT IF EXISTS sla_reports_period_kind_valid,
  DROP CONSTRAINT IF EXISTS sla_reports_excluded_nonneg;
ALTER TABLE sla_reports
  DROP COLUMN IF EXISTS period_kind,
  DROP COLUMN IF EXISTS excluded_seconds,
  DROP COLUMN IF EXISTS total_checks,
  DROP COLUMN IF EXISTS failed_checks;
