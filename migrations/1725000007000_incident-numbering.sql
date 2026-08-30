-- Up Migration
-- Monotonic incident numbers. The app formats these as INC-<year>-<000123>.

CREATE SEQUENCE incident_number_seq START 1;

-- Down Migration
DROP SEQUENCE IF EXISTS incident_number_seq;
