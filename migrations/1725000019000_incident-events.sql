-- Up Migration
-- Phase 16 (Observability): per-incident timeline (spec §12).
--
-- A chronological event log for one incident — detected, failure signature
-- changed, severity escalated, flapping, dependency/database error surfaced by
-- the RCA, acknowledged, recovered. The `GET /incidents/:id/timeline` endpoint
-- merges these rows with the incident's alert rows and its own lifecycle
-- timestamps into one ordered stream.

CREATE TABLE incident_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id  uuid NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
  at           timestamptz NOT NULL DEFAULT now(),
  kind         text NOT NULL,
  summary      text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  source       text NOT NULL DEFAULT 'system',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX incident_events_incident_at_idx ON incident_events (incident_id, at);

-- Down Migration
DROP TABLE IF EXISTS incident_events;
