import 'dotenv/config';
import { hostname } from 'node:os';
import { env } from '../../config/index.js';
import { componentLogger } from '../../lib/logger.js';
import { closePool } from '../../lib/db.js';
import { installShutdownHandlers, onShutdown } from '../../lib/shutdown.js';
import {
  claimNextRun,
  recoverStaleRuns,
  requestAbort,
} from '../../repositories/load-test-runs.repo.js';
import { executeRun } from '../../services/loadtest/run.service.js';
import {
  claimNextCorrectnessRun,
  recoverStaleCorrectnessRuns,
} from '../../repositories/load-test-correctness.repo.js';
import { tickSchedules } from '../../services/loadtest/schedule.service.js';
import { executeCorrectnessRun } from '../../services/loadtest/correctness.service.js';

/**
 * Load-test worker. Polls Postgres for QUEUED runs, so it can live on a
 * separate VM from the API/scheduler — the only things it needs are the DB
 * and the k6 binary. It runs one run at a time.
 */
const log = componentLogger('loadtest-worker');
const workerId = `${hostname()}-${process.pid}`;
let stopping = false;
let currentRunId: string | null = null;
let lastScheduleTick = 0;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  installShutdownHandlers(30_000);
  onShutdown(async () => {
    stopping = true;
    if (currentRunId) {
      await requestAbort(currentRunId, `worker ${workerId} shutting down`);
      for (let i = 0; i < 25 && currentRunId; i++) await sleep(1000);
    }
  });
  onShutdown(closePool);

  if (!env().LOAD_TEST_ENABLED) {
    log.warn('LOAD_TEST_ENABLED=false — worker will idle and run nothing');
  }
  log.info({ workerId }, 'load-test worker started');

  while (!stopping) {
    try {
      const abandoned = [
        ...(await recoverStaleRuns(60)),
        ...(await recoverStaleCorrectnessRuns(60)),
      ];
      if (abandoned.length > 0) log.warn({ abandoned }, 'recovered stale runs');
      if (!env().LOAD_TEST_ENABLED) {
        await sleep(env().LOAD_TEST_WORKER_POLL_MS);
        continue;
      }
      if (Date.now() - lastScheduleTick >= 30_000) {
        lastScheduleTick = Date.now();
        const fired = await tickSchedules();
        if (fired > 0) log.info({ fired }, 'queued scheduled suites');
      }
      const run = await claimNextRun(workerId);
      if (!run) {
        // Correctness suites share the worker; they are short and cannot be aborted mid-check
        // (the kill switch stops them between checks).
        const suite = await claimNextCorrectnessRun(workerId);
        if (suite) {
          log.info({ correctnessRunId: suite.id }, 'claimed correctness run');
          await executeCorrectnessRun(suite, { workerId });
          continue;
        }
        await sleep(env().LOAD_TEST_WORKER_POLL_MS);
        continue;
      }
      currentRunId = run.id;
      log.info({ runId: run.id }, 'claimed run');
      await executeRun(run, { workerId });
      currentRunId = null;
    } catch (err) {
      log.error({ err }, 'worker loop error');
      await sleep(env().LOAD_TEST_WORKER_POLL_MS);
    }
  }
}

main().catch((err: unknown) => {
  log.fatal({ err }, 'load-test worker crashed');
  process.exit(1);
});
