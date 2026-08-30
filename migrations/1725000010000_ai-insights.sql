-- Up Migration
-- Phase 10: AI-assisted intelligence. Every row here is ADVISORY — the AI never
-- sets health status, closes an incident, or changes configuration (see vault:
-- "AI Allowed Uses and Guardrails"). `assistive` is a hard-coded marker of that.

CREATE TYPE ai_insight_kind AS ENUM (
  'failure_classification',
  'root_cause',
  'incident_summary',
  'latency_anomaly',
  'error_rate_anomaly'
);

CREATE TABLE ai_insights (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  text NOT NULL,              -- 'incident' | 'target'
  entity_id    uuid NOT NULL,
  kind         ai_insight_kind NOT NULL,
  assistive    boolean NOT NULL DEFAULT true,
  confidence   numeric(4, 3),              -- 0..1, null for non-probabilistic
  model        text NOT NULL,              -- model id, or 'statistical' for anomalies
  content      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_insights_is_assistive CHECK (assistive = true),
  CONSTRAINT ai_insights_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE INDEX ai_insights_entity_idx ON ai_insights (entity_type, entity_id, kind);
CREATE INDEX ai_insights_created_idx ON ai_insights (created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS ai_insights;
DROP TYPE IF EXISTS ai_insight_kind;
