import type { Request, RequestHandler } from 'express';
import {
  RateLimiterMemory,
  RateLimiterRedis,
  type RateLimiterAbstract,
} from 'rate-limiter-flexible';
import { env } from '../../config/index.js';
import { componentLogger } from '../../lib/logger.js';
import { getRedis } from '../../lib/redis.js';

const log = componentLogger('rate-limit');

function make(keyPrefix: string, points: number, duration: number): RateLimiterAbstract {
  try {
    return new RateLimiterRedis({
      storeClient: getRedis(),
      keyPrefix,
      points,
      duration,
      // If Redis is momentarily unavailable, fall back to in-process limiting
      // rather than 500-ing every request.
      insuranceLimiter: new RateLimiterMemory({ points, duration }),
    });
  } catch (err) {
    log.warn({ err }, 'redis rate limiter unavailable — using in-memory');
    return new RateLimiterMemory({ keyPrefix, points, duration });
  }
}

let apiLimiter: RateLimiterAbstract | undefined;
let loginLimiter: RateLimiterAbstract | undefined;
let loginIpLimiter: RateLimiterAbstract | undefined;
let refreshLimiter: RateLimiterAbstract | undefined;

/** Runs several limiters; the first rejection 429s. */
function multiLimiterMiddleware(
  entries: { get: () => RateLimiterAbstract; key: (req: Request) => string }[],
): RequestHandler {
  return (req, res, next) => {
    void Promise.all(entries.map((e) => e.get().consume(e.key(req))))
      .then((results) => {
        const min = Math.min(...results.map((r) => r.remainingPoints));
        res.setHeader('x-ratelimit-remaining', String(min));
        next();
      })
      .catch((rej: unknown) => {
        const retryMs =
          typeof rej === 'object' && rej !== null && 'msBeforeNext' in rej
            ? (rej as { msBeforeNext: number }).msBeforeNext
            : 1000;
        res.setHeader('retry-after', String(Math.ceil(retryMs / 1000)));
        res.status(429).json({
          error: { code: 'RATE_LIMITED', message: 'Too many requests', requestId: req.requestId },
        });
      });
  };
}

function clientKey(req: Request): string {
  return req.user?.id ?? req.ip ?? 'unknown';
}

function limiterMiddleware(
  get: () => RateLimiterAbstract,
  key: (req: Request) => string,
): RequestHandler {
  return (req, res, next) => {
    void get()
      .consume(key(req))
      .then((r) => {
        res.setHeader('x-ratelimit-remaining', String(r.remainingPoints));
        next();
      })
      .catch((rej: unknown) => {
        const retryMs =
          typeof rej === 'object' && rej !== null && 'msBeforeNext' in rej
            ? (rej as { msBeforeNext: number }).msBeforeNext
            : 1000;
        res.setHeader('retry-after', String(Math.ceil(retryMs / 1000)));
        res.status(429).json({
          error: { code: 'RATE_LIMITED', message: 'Too many requests', requestId: req.requestId },
        });
      });
  };
}

/** Global per-client API rate limit. */
export function apiRateLimit(): RequestHandler {
  return limiterMiddleware(() => {
    apiLimiter ??= make('rl:api', env().RATE_LIMIT_POINTS, env().RATE_LIMIT_WINDOW_SECONDS);
    return apiLimiter;
  }, clientKey);
}

const ipOf = (req: Request): string => req.ip ?? 'x';

/**
 * Login limit: a tight per-(IP, email) bucket AND a looser per-IP bucket, so
 * credential-stuffing that rotates the email from one IP still hits a ceiling.
 */
export function loginRateLimit(): RequestHandler {
  return multiLimiterMiddleware([
    {
      get: () => {
        loginLimiter ??= make(
          'rl:login',
          env().RATE_LIMIT_LOGIN_POINTS,
          env().RATE_LIMIT_LOGIN_WINDOW_SECONDS,
        );
        return loginLimiter;
      },
      key: (req) => {
        const email = (req.body as { email?: unknown } | undefined)?.email;
        return `${ipOf(req)}:${typeof email === 'string' ? email : ''}`;
      },
    },
    {
      get: () => {
        loginIpLimiter ??= make(
          'rl:login:ip',
          env().RATE_LIMIT_LOGIN_POINTS * 3,
          env().RATE_LIMIT_LOGIN_WINDOW_SECONDS,
        );
        return loginIpLimiter;
      },
      key: ipOf,
    },
  ]);
}

/** Per-IP limit on the (unauthenticated) token-refresh endpoint. */
export function refreshRateLimit(): RequestHandler {
  return limiterMiddleware(() => {
    refreshLimiter ??= make(
      'rl:refresh',
      env().RATE_LIMIT_LOGIN_POINTS * 6,
      env().RATE_LIMIT_LOGIN_WINDOW_SECONDS,
    );
    return refreshLimiter;
  }, ipOf);
}

export function resetRateLimiters(): void {
  apiLimiter = undefined;
  loginLimiter = undefined;
  loginIpLimiter = undefined;
  refreshLimiter = undefined;
}
