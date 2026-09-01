-- Up Migration
-- Phase 14 (Latency intelligence): per-API latency bands. A payment API and an
-- SMS API have very different "normal", so the assessment thresholds must be
-- configurable per target (spec §6). Absent row → the class-based defaults in
-- src/domain/latency.ts apply.

CREATE TABLE latency_thresholds (
  api_id       uuid PRIMARY KEY REFERENCES monitored_apis (id) ON DELETE CASCADE,
  normal_ms    integer NOT NULL,
  degraded_ms  integer NOT NULL,
  critical_ms  integer NOT NULL,
  updated_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT latency_thresholds_ordered
    CHECK (normal_ms > 0 AND degraded_ms > normal_ms AND critical_ms > degraded_ms)
);

-- Down Migration
DROP TABLE IF EXISTS latency_thresholds;
