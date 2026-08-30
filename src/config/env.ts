import { z } from 'zod';

/**
 * Central, validated environment configuration.
 *
 * The process refuses to start if required variables are missing or malformed —
 * a monitoring system that boots with a broken config is worse than one that
 * fails loudly (see vault: "Environment Configuration").
 */
const BoolFromString = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SERVICE_NAME: z.string().min(1).default('fintech-cron-monitor'),

  DATABASE_URL: z.string().url().startsWith('postgres'),
  REDIS_URL: z.string().url().startsWith('redis'),

  // Optional until their phase lands — kept in the schema so config is discoverable.
  JWT_SECRET: z.string().optional(),
  JWT_REFRESH_SECRET: z.string().optional(),
  ENCRYPTION_KMS_KEY_ID: z.string().optional(),
  // Local key-encryption key for credential envelopes (base64, 32 bytes).
  // Phase 9 replaces this with a KMS-backed key. Required in production.
  CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  // Identifies this process in distributed locks, heartbeats and job records.
  INSTANCE_ID: z.string().default('local-1'),

  SCHEDULER_LOCK_TTL_MS: z.coerce.number().int().positive().default(15_000),
  SCHEDULER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  SCHEDULER_HEARTBEAT_GRACE_MS: z.coerce.number().int().positive().default(30_000),
  MAX_GLOBAL_CONCURRENT_CHECKS: z.coerce.number().int().positive().default(50),
  DEFAULT_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),

  // Incident state machine (see vault: "Incident Lifecycle").
  INCIDENT_RECOVERY_STREAK: z.coerce.number().int().min(1).default(2),
  FLAPPING_THRESHOLD: z.coerce.number().int().min(2).default(4),
  FLAPPING_WINDOW_MINUTES: z.coerce.number().int().min(1).default(10),

  // Notification channels (Phase 7). Each channel needs a transport configured;
  // when one is missing the channel logs the notification instead of dropping it.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().max(65_535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  ALERT_EMAIL_FROM: z.string().optional(),
  ALERT_EMAIL_TO: z.string().optional(),
  SMS_PROVIDER_URL: z.string().url().optional(),
  SMS_PROVIDER_API_KEY: z.string().optional(),
  ALERT_SMS_TO: z.string().optional(),
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  ALERT_SLACK_WEBHOOK_URL: z.string().url().optional(),
  WEBHOOK_SIGNING_SECRET: z.string().optional(),

  // Suppress alerts for CRITICAL/money-moving targets no more than once per this
  // window unless severity escalates or the next tier fires (spec 8.9).
  ALERT_SUPPRESSION_WINDOW_MINUTES: z.coerce.number().int().min(1).default(30),

  WATCHDOG_EXTERNAL_ENDPOINT: z.string().url().optional(),

  ENABLE_REQUEST_LOGGING: BoolFromString.default('true'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Treat empty-string values (common in `.env` files with bare `KEY=` lines)
  // as "not set" so `.optional()` fields don't fail URL/format checks.
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim() !== '') cleaned[key] = value;
  }
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

/** Memoised accessor for the validated env. */
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test-only: force re-read on next `env()` call. */
export function resetEnvCache(): void {
  cached = undefined;
}
