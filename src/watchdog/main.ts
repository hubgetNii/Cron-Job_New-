import 'dotenv/config';
import { env } from '../config/index.js';
import { componentLogger } from '../lib/logger.js';
import { installShutdownHandlers } from '../lib/shutdown.js';

const log = componentLogger('watchdog');

/**
 * Independent watchdog / dead-man's-switch entrypoint.
 *
 * This process is deliberately minimal and shares as little code as possible
 * with the primary system. Phase 5 fills it in: expect a scheduler heartbeat
 * every SCHEDULER_HEARTBEAT_INTERVAL_MS; if none arrives within
 * SCHEDULER_HEARTBEAT_GRACE_MS, fire a CRITICAL alert through
 * WATCHDOG_EXTERNAL_ENDPOINT — a path that does NOT depend on the primary
 * alert engine (see vault: "Watchdog and Dead Man's Switch").
 */
function main(): void {
  const cfg = env();
  log.info(
    {
      env: cfg.NODE_ENV,
      heartbeatIntervalMs: cfg.SCHEDULER_HEARTBEAT_INTERVAL_MS,
      graceMs: cfg.SCHEDULER_HEARTBEAT_GRACE_MS,
      externalEndpointConfigured: Boolean(cfg.WATCHDOG_EXTERNAL_ENDPOINT),
    },
    'watchdog process started (Phase 5 not yet implemented)',
  );
  installShutdownHandlers();

  const idle = setInterval(() => {
    log.debug('watchdog idle heartbeat');
  }, 60_000);
  idle.unref();
}

main();
