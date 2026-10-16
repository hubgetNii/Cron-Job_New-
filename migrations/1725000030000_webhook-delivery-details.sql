-- Up Migration
-- The live webhook check needs to compare what iSmart put in the envelope with what it
-- put in the headers, and the final status it reported with the API's own answer.
ALTER TABLE load_test_webhook_deliveries
  ADD COLUMN envelope_id  text,
  ADD COLUMN event_status text;
CREATE INDEX load_test_webhook_deliveries_ref_idx ON load_test_webhook_deliveries (sink_id, reference);

-- Down Migration
DROP INDEX IF EXISTS load_test_webhook_deliveries_ref_idx;
ALTER TABLE load_test_webhook_deliveries DROP COLUMN IF EXISTS envelope_id, DROP COLUMN IF EXISTS event_status;
