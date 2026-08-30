-- Up Migration
-- Baseline migration: proves the migration pipeline and enables the extensions
-- the Phase 2 schema depends on. No domain tables yet.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive email / name columns

-- Down Migration
DROP EXTENSION IF EXISTS citext;
DROP EXTENSION IF EXISTS pgcrypto;
