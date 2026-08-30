import { Redis, type RedisOptions } from 'ioredis';
import { env } from '../config/index.js';
import { componentLogger } from './logger.js';

const log = componentLogger('redis');

let client: Redis | undefined;

/**
 * Shared Redis connection.
 *
 * `maxRetriesPerRequest: null` and `enableReadyCheck: false` are the settings
 * BullMQ requires of its connections; using the same options everywhere keeps a
 * single connection contract across the app, scheduler and workers.
 */
export function redisOptions(): RedisOptions {
  return {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  };
}

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(env().REDIS_URL, redisOptions());
    client.on('error', (err) => log.error({ err }, 'redis connection error'));
    client.on('ready', () => log.info('redis ready'));
  }
  return client;
}

export interface RedisHealth {
  ok: boolean;
  latencyMs: number | null;
  error?: string;
}

export async function checkRedisHealth(): Promise<RedisHealth> {
  const started = performance.now();
  try {
    const redis = getRedis();
    if (redis.status === 'wait' || redis.status === 'close' || redis.status === 'end') {
      await redis.connect();
    }
    await redis.ping();
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return {
      ok: false,
      latencyMs: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function closeRedis(): void {
  if (client) {
    client.disconnect();
    client = undefined;
  }
}
