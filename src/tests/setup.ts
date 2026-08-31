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

// Pin alerting defaults so a developer's `.env` (which may enable PUSH and point
// at a real Firebase key) cannot leak into the suite. Hard `=` so these win over
// `dotenv/config`. Tests that exercise fan-out / FCM override at runtime.
process.env['ALERT_DEFAULT_CHANNELS'] = 'WEBHOOK';
process.env['ALERT_DEFAULT_RECIPIENT'] = 'ops';
process.env['FCM_SERVICE_ACCOUNT_FILE'] = '';
process.env['FCM_DEFAULT_TOPIC'] = '';
process.env['SMS_DIGEST_RECIPIENTS'] = '';
process.env['SMS_DIGEST_TIMEZONE'] = 'UTC';
process.env['SMS_PROVIDER_URL'] = '';
process.env['SMS_PROVIDER_API_KEY'] = '';

// Effectively disable HTTP rate limiting in the suite — no test asserts a 429,
// and the IP-keyed counters otherwise accumulate across the e2e files.
process.env['RATE_LIMIT_POINTS'] = '1000000';
process.env['RATE_LIMIT_LOGIN_POINTS'] = '1000000';
