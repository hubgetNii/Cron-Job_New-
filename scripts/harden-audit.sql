-- Audit-trail hardening (spec §17). Run ONCE per environment as the database
-- superuser (or the role that owns the tables), after the app role exists.
--
--   psql "$DATABASE_URL_SUPERUSER" -v app_role=cronmon -f scripts/harden-audit.sql
--
-- The application already blocks UPDATE/DELETE on audit_logs with a trigger
-- (migration 1725000005000). This is defence in depth at the privilege layer:
-- even a compromised app connection cannot rewrite history.

\set app_role :app_role

REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM :app_role;

-- The app still needs to append.
GRANT INSERT, SELECT ON audit_logs TO :app_role;

-- Optional: same treatment for the SLA reports and config-change requests,
-- which are also compliance records.
-- REVOKE UPDATE, DELETE, TRUNCATE ON sla_reports FROM :app_role;
-- REVOKE DELETE, TRUNCATE ON config_change_requests FROM :app_role;

SELECT 'audit_logs privileges hardened for role ' || :'app_role' AS result;
