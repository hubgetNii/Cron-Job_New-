/**
 * Test environment defaults. Set before any module reads `env()`.
 * These point at local docker-compose services but tests that don't need a live
 * database/redis mock the health helpers instead of connecting.
 */
process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] ??= 'silent';
process.env['DATABASE_URL'] ??= 'postgres://cronmon:cronmon@localhost:5433/cronmon_test';
process.env['REDIS_URL'] ??= 'redis://localhost:6380/1';
process.env['ENABLE_REQUEST_LOGGING'] ??= 'false';
// Auth is off by default in the suite; auth/four-eyes tests opt in explicitly.
process.env['AUTH_ENABLED'] ??= 'false';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-at-least-sixteen-chars';
