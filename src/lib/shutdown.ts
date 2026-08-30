import { componentLogger } from './logger.js';

const log = componentLogger('lifecycle');

type Cleanup = () => Promise<void> | void;

const cleanups: Cleanup[] = [];
let shuttingDown = false;

export function onShutdown(fn: Cleanup): void {
  cleanups.push(fn);
}

/**
 * Registers SIGINT/SIGTERM handlers that run all cleanups once, with a hard
 * timeout so a hung cleanup can't keep the process alive forever.
 */
export function installShutdownHandlers(timeoutMs = 10_000): void {
  const handle = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutdown initiated');

    const timer = setTimeout(() => {
      log.error({ timeoutMs }, 'graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, timeoutMs);
    timer.unref();

    void (async (): Promise<void> => {
      for (const fn of cleanups.reverse()) {
        try {
          await fn();
        } catch (err) {
          log.error({ err }, 'cleanup handler failed');
        }
      }
      clearTimeout(timer);
      log.info('shutdown complete');
      process.exit(0);
    })();
  };

  process.on('SIGINT', handle);
  process.on('SIGTERM', handle);
}
