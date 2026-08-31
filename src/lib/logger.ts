import { pino, type Logger } from 'pino';
import { env, isProduction } from '../config/index.js';

/**
 * Structured JSON logging (see vault: "Observability and Meta-Monitoring").
 *
 * Redaction is deliberately aggressive: this system holds credentials capable of
 * touching payment infrastructure, and credential-exposure-in-logs is a
 * release-blocking failure (AI Development Rule 7).
 */
const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-api-secret"]',
  '*.apiSecret',
  '*.apiId',
  '*.accessToken',
  '*.refreshToken',
  '*.password',
  '*.secret',
  '*.token',
  '*.api_password',
  '*.apiPassword',
  '*.encrypted_credentials',
  'credentials',
];

function build(): Logger {
  const { LOG_LEVEL, SERVICE_NAME } = env();
  return pino({
    level: LOG_LEVEL,
    base: { service: SERVICE_NAME },
    redact: { paths: redactPaths, censor: '[REDACTED]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(isProduction()
      ? {}
      : {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss.l',
              ignore: 'pid,hostname,service',
            },
          },
        }),
  });
}

export const logger: Logger = build();

/** Child logger bound to a component name for traceable, filterable logs. */
export function componentLogger(component: string): Logger {
  return logger.child({ component });
}
