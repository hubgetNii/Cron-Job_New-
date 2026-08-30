import 'dotenv/config';
import { env } from '../config/index.js';
import { componentLogger } from '../lib/logger.js';
import { installShutdownHandlers, onShutdown } from '../lib/shutdown.js';
import { closePool } from '../lib/db.js';
import { startWatchdog } from './watchdog.js';

const log = componentLogger('watchdog');

/**
 * Independent watchdog / dead-man's-switch process. Deliberately minimal: it
 * shares only the database and config with the primary system, and alerts
 * through WATCHDOG_EXTERNAL_ENDPOINT — a path that does not depend on the
 * primary alert engine (see vault: "Watchdog and Dead Man's Switch").
 */
function main(): void {
  const cfg = env();
  log.info(
    {
      env: cfg.NODE_ENV,
      intervalMs: cfg.SCHEDULER_HEARTBEAT_INTERVAL_MS,
      graceMs: cfg.SCHEDULER_HEARTBEAT_GRACE_MS,
      externalEndpointConfigured: Boolean(cfg.WATCHDOG_EXTERNAL_ENDPOINT),
    },
    'watchdog started',
  );

  const loop = startWatchdog();
  installShutdownHandlers();
  onShutdown(() => loop.stop());
  onShutdown(closePool);
}

main();
