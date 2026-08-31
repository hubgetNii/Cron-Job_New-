import { z } from 'zod';
import { ALERT_CHANNELS } from '../domain/enums.js';

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

  // Authentication (Phase 9). AUTH_ENABLED=false bypasses auth entirely — only
  // for local dev; the API refuses to start with it off in production.
  AUTH_ENABLED: BoolFromString.default('true'),
  JWT_SECRET: z.string().min(16).optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).optional(),

  ENCRYPTION_KMS_KEY_ID: z.string().optional(),
  // Local key-encryption key for credential envelopes (base64, 32 bytes).
  // Phase 9 makes the cipher pluggable; a KMS provider replaces this key.
  CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  // Identifies this process in distributed locks, heartbeats and job records.
  INSTANCE_ID: z.string().default('local-1'),

  // Rate limiting (Phase 9). Redis-backed, per client key.
  RATE_LIMIT_POINTS: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_LOGIN_POINTS: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_LOGIN_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),

  // AI intelligence (Phase 10). Absent → AI features report "not configured".
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-opus-5'),
  AI_ENABLED: BoolFromString.default('true'),
  ANOMALY_BASELINE_DAYS: z.coerce.number().int().positive().default(30),
  ANOMALY_Z_THRESHOLD: z.coerce.number().positive().default(3),
  ANOMALY_MIN_BASELINE_SAMPLES: z.coerce.number().int().positive().default(30),

  // Reporting (Phase 11).
  SLA_REPORT_INTERVAL_MINUTES: z.coerce.number().int().positive().default(30),
  STATUS_PAGE_ENABLED: BoolFromString.default('true'),

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

  // SMS is a *digest* channel, not an event stream (see vault: "SMS Health
  // Digest Notifications"). A job snapshots overall system health every
  // SMS_DIGEST_INTERVAL_MINUTES and sends ONE SMS, and only when the overall
  // level changes (HEALTHY / DEGRADED / CRITICAL). Recipients is a comma list
  // of phone numbers.
  SMS_DIGEST_ENABLED: BoolFromString.default('true'),
  SMS_DIGEST_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(30),
  SMS_DIGEST_RECIPIENTS: z.string().optional(),
  // IANA timezone for the timestamps in the SMS text (e.g. "Africa/Accra").
  // Unset → the server's local timezone.
  SMS_DIGEST_TIMEZONE: z.string().optional(),
  SMS_DIGEST_LABEL: z.string().default('iSmart Health'),
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  ALERT_SLACK_WEBHOOK_URL: z.string().url().optional(),
  WEBHOOK_SIGNING_SECRET: z.string().optional(),

  // Firebase Cloud Messaging (PUSH channel). Point at a service-account JSON
  // downloaded from the Firebase console; the channel mints its own OAuth2
  // token and calls the FCM HTTP v1 API. Unset → PUSH alerts are logged only.
  FCM_SERVICE_ACCOUNT_FILE: z.string().optional(),
  // Topic delivered to when an alert's recipient is not itself a token/topic
  // (e.g. the default "ops" recipient). Subscribe devices to this topic.
  FCM_DEFAULT_TOPIC: z.string().optional(),

  // Where the incident engine sends its automatic alerts (open / degrade /
  // recover / flapping). Comma-separated channel list; each must be a valid
  // alert_channel. Set "WEBHOOK,PUSH" to fan out to both.
  ALERT_DEFAULT_CHANNELS: z
    .string()
    .default('WEBHOOK')
    .transform((s) => s.split(',').map((c) => c.trim().toUpperCase()))
    .pipe(z.array(z.enum(ALERT_CHANNELS)).min(1)),
  ALERT_DEFAULT_RECIPIENT: z.string().default('ops'),

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
