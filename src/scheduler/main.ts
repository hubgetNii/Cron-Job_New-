import 'dotenv/config';
import { env } from '../config/index.js';
import { componentLogger } from '../lib/logger.js';
import { installShutdownHandlers, onShutdown } from '../lib/shutdown.js';
import { closePool } from '../lib/db.js';
import { closeRedis } from '../lib/redis.js';
import { Scheduler } from '../services/scheduler/scheduler.service.js';
import { startAlertRunner } from '../services/alert/alert-runner.js';
import { startReportRunner } from '../services/reporting/report-runner.js';
import { startDigestRunner } from '../services/digest/digest-runner.js';
import { startRetentionRunner } from '../services/observability/retention.service.js';
import { startHealthCheckRunRunner } from '../services/observability/health-check-run-runner.js';

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
  const alertRunner = startAlertRunner();
  const reportRunner = startReportRunner();
  const digestRunner = startDigestRunner();
  const retention = startRetentionRunner();
  const runRoller = startHealthCheckRunRunner();
  log.info(
    'scheduler running (escalation, alert delivery, SLA reporting, SMS health digest, retention sweep, health-check runs)',
  );

  // Pick up target create/update/enable/disable without a restart.
  const reloadTimer = setInterval(() => void scheduler.reload(), 30_000);
  reloadTimer.unref();

  installShutdownHandlers();
  onShutdown(() => clearInterval(reloadTimer));
  onShutdown(() => alertRunner.stop());
  onShutdown(() => reportRunner.stop());
  onShutdown(() => digestRunner.stop());
  onShutdown(() => retention.stop());
  onShutdown(() => runRoller.stop());
  onShutdown(() => scheduler.stop());
  onShutdown(closePool);
  onShutdown(closeRedis);
}

main().catch((err: unknown) => {
  log.fatal({ err }, 'scheduler failed to start');
  process.exit(1);
});
