-- Up Migration
-- Phase 24: approved synthetic data sets that feed {{data.*}} in load plans.
-- Records are validated on write (src/domain/load-test-data.ts) — a set that
-- contains a clear-text secret, a non-fixture card number or an unauthorised real
-- phone number is rejected and never stored. Secrets appear only as
-- {{secret:NAME}} references, resolved from the worker's environment at run time.

CREATE TABLE load_test_data_sets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  environment  text NOT NULL CHECK (environment IN ('mock', 'sandbox', 'staging')),
  records      jsonb NOT NULL,
  record_count integer NOT NULL CHECK (record_count > 0),
  fields       text[] NOT NULL DEFAULT '{}',
  description  text,
  created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS load_test_data_sets;
