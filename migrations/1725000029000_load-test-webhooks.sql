-- Up Migration
-- B9: a persistent webhook receiver for live (sandbox) testing. A sink owns an
-- unguessable URL slug and, once iSmart issues one, an encrypted signing secret.
-- Every delivery is recorded — valid or not — so duplicates, ordering, retries and
-- forged requests can be checked after the fact. Bodies are stored masked.
CREATE TABLE load_test_webhook_sinks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_id             uuid REFERENCES monitored_apis (id) ON DELETE CASCADE,
  label              text NOT NULL,
  slug               text NOT NULL UNIQUE,
  encrypted_secret   jsonb,
  enabled            boolean NOT NULL DEFAULT true,
  created_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE load_test_webhook_deliveries (
  id             bigserial PRIMARY KEY,
  sink_id        uuid NOT NULL REFERENCES load_test_webhook_sinks (id) ON DELETE CASCADE,
  event_id       text NOT NULL,
  event_type     text,
  reference      text,
  attempt        integer NOT NULL,
  signature_ok   boolean NOT NULL,
  reason         text,
  body_sha256    text NOT NULL,
  body_masked    text,
  responded_with integer NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX load_test_webhook_deliveries_sink_idx ON load_test_webhook_deliveries (sink_id, received_at DESC);
CREATE INDEX load_test_webhook_deliveries_event_idx ON load_test_webhook_deliveries (sink_id, event_id);

-- Down Migration
DROP TABLE IF EXISTS load_test_webhook_deliveries;
DROP TABLE IF EXISTS load_test_webhook_sinks;
