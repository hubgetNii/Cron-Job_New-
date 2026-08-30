import 'dotenv/config';
import { env } from '../config/index.js';
import { componentLogger } from '../lib/logger.js';
import { installShutdownHandlers, onShutdown } from '../lib/shutdown.js';
import { closePool } from '../lib/db.js';
import { closeRedis } from '../lib/redis.js';

const log = componentLogger('worker');

/**
 * Health-check worker entrypoint.
 *
 * Phase 4/5 fills this in: pull jobs from BullMQ, acquire the per-(target, slot)
 * distributed lock, execute the HTTP health check, validate the response at the
 * business level, persist the result and drive the incident state machine.
 */
function main(): void {
  log.info({ env: env().NODE_ENV }, 'worker process started (Phase 4/5 not yet implemented)');
  installShutdownHandlers();
  onShutdown(closePool);
  onShutdown(closeRedis);

  const idle = setInterval(() => {
    log.debug('worker idle heartbeat');
  }, 60_000);
  idle.unref();
}

main();
