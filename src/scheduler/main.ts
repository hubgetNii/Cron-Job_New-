import 'dotenv/config';
import { env } from '../config/index.js';
import { componentLogger } from '../lib/logger.js';
import { installShutdownHandlers, onShutdown } from '../lib/shutdown.js';
import { closePool } from '../lib/db.js';
import { closeRedis } from '../lib/redis.js';
import { Scheduler } from '../services/scheduler/scheduler.service.js';

const log = componentLogger('scheduler');

/**
 * Scheduler process entrypoint. Loads active targets from PostgreSQL, fires
 * anchored wall-clock health checks through the job runner (distributed lock +
 * idempotency), emits a heartbeat the watchdog observes, and reloads its
 * schedule periodically so target changes take effect without a restart.
 */
async function main(): Promise<void> {
  const scheduler = new Scheduler({ instanceId: env().INSTANCE_ID });
  await scheduler.start();
  log.info('scheduler running');

  // Pick up target create/update/enable/disable without a restart.
  const reloadTimer = setInterval(() => void scheduler.reload(), 30_000);
  reloadTimer.unref();

  installShutdownHandlers();
  onShutdown(() => clearInterval(reloadTimer));
  onShutdown(() => scheduler.stop());
  onShutdown(closePool);
  onShutdown(closeRedis);
}

main().catch((err: unknown) => {
  log.fatal({ err }, 'scheduler failed to start');
  process.exit(1);
});
