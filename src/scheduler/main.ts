import 'dotenv/config';
import { env } from '../config/index.js';
import { componentLogger } from '../lib/logger.js';
import { installShutdownHandlers, onShutdown } from '../lib/shutdown.js';
import { closePool } from '../lib/db.js';
import { closeRedis } from '../lib/redis.js';

const log = componentLogger('scheduler');

/**
 * Scheduler process entrypoint.
 *
 * Phase 5 fills this in: load active targets from PostgreSQL, register
 * anchored wall-clock cron triggers, enqueue jobs onto BullMQ, and emit a
 * heartbeat the watchdog can observe. For now it starts, idles, and shuts
 * down cleanly so the container topology is real from day one.
 */
function main(): void {
  log.info({ env: env().NODE_ENV }, 'scheduler process started (Phase 5 not yet implemented)');
  installShutdownHandlers();
  onShutdown(closePool);
  onShutdown(closeRedis);

  const idle = setInterval(() => {
    log.debug('scheduler idle heartbeat');
  }, 60_000);
  idle.unref();
}

main();
