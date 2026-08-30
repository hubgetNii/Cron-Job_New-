import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadEnv', () => {
  it('applies defaults for optional values', () => {
    const env = loadEnv(base);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.DEFAULT_CHECK_TIMEOUT_MS).toBe(8000);
    expect(env.ENABLE_REQUEST_LOGGING).toBe(true);
  });

  it('coerces numeric strings', () => {
    const env = loadEnv({ ...base, PORT: '8080', MAX_GLOBAL_CONCURRENT_CHECKS: '25' });
    expect(env.PORT).toBe(8080);
    expect(env.MAX_GLOBAL_CONCURRENT_CHECKS).toBe(25);
  });

  it('rejects a missing database url', () => {
    expect(() => loadEnv({ REDIS_URL: base.REDIS_URL })).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-postgres database url', () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects an invalid log level', () => {
    expect(() => loadEnv({ ...base, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it('treats empty-string values as unset (bare KEY= lines in .env)', () => {
    const env = loadEnv({ ...base, WATCHDOG_EXTERNAL_ENDPOINT: '', JWT_SECRET: '  ' });
    expect(env.WATCHDOG_EXTERNAL_ENDPOINT).toBeUndefined();
    expect(env.JWT_SECRET).toBeUndefined();
  });

  it('parses boolean-ish request logging flag', () => {
    expect(loadEnv({ ...base, ENABLE_REQUEST_LOGGING: 'false' }).ENABLE_REQUEST_LOGGING).toBe(
      false,
    );
    expect(loadEnv({ ...base, ENABLE_REQUEST_LOGGING: '0' }).ENABLE_REQUEST_LOGGING).toBe(false);
  });
});
