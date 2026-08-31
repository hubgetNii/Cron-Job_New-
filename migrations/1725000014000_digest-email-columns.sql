-- Up Migration
-- The digest now also goes out by email (full per-service status). Track it
-- alongside the SMS counters.

ALTER TABLE health_digests
  ADD COLUMN email_sent       boolean NOT NULL DEFAULT false,
  ADD COLUMN email_recipients integer NOT NULL DEFAULT 0;

-- Down Migration
ALTER TABLE health_digests
  DROP COLUMN IF EXISTS email_sent,
  DROP COLUMN IF EXISTS email_recipients;
