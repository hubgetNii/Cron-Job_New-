/* eslint-disable no-console */
/**
 * Populates the dashboard's Load Tests area with REAL results, produced by the
 * real runner (k6), correctness suite and security suite against the built-in
 * simulator. Nothing here is fabricated — only the target is a mock.
 *
 *   npm run demo:loadtest            # run everything (~2 minutes)
 *   npm run demo:loadtest -- --clean # remove the demo target and its results
 *
 * Everything is attached to one clearly named, INACTIVE target so the cron
 * monitor never polls it. Reports from it are labelled "Simulator (not the real
 * service)" and can never make a service READY.
 */
process.env['LOAD_TEST_ENABLED'] = 'true';
process.env['LOAD_TEST_GUARDRAIL_WINDOW_SECONDS'] ??= '5';
process.env['LOAD_TEST_GUARDRAIL_MIN_SAMPLES'] ??= '10';

import { createServer } from 'node:http';
import { isProduction, resetEnvCache } from '../config/index.js';
import { closePool, query } from '../lib/db.js';
import { encryptCredentials } from '../lib/crypto/credential-cipher.js';
import { createSimulatorApp } from '../loadtest/simulator/app.js';
import { packById, planFromPack } from '../loadtest/packs/packs.js';
import { upsertTargetConfig, setKillSwitch } from '../repositories/load-test-safety.repo.js';
import * as runsRepo from '../repositories/load-test-runs.repo.js';
import * as suitesRepo from '../repositories/load-test-correctness.repo.js';
import { createPlan, executeRun, queueRun } from '../services/loadtest/run.service.js';
import {
  executeCorrectnessRun,
  queueCorrectnessRun,
} from '../services/loadtest/correctness.service.js';
import { createValidatedDataSet } from '../services/loadtest/data-set.service.js';

const NAME = 'Demo — iSmartPay Simulator';
const PORT = Number(process.env['DEMO_SIM_PORT'] ?? 4010);
const actor = { userId: null, label: 'system:demo-loadtest' };
const worker = 'demo-worker';

async function clean(): Promise<void> {
  await query(`DELETE FROM load_test_data_sets WHERE name LIKE 'demo-%'`);
  await query(`DELETE FROM monitored_apis WHERE name = $1`, [NAME]);
}

async function main(): Promise<void> {
  resetEnvCache(); // ESM hoists imports: re-read the env set at the top of this file
  if (isProduction()) throw new Error('Refusing to create demo data in production.');
  await clean();
  if (process.argv.includes('--clean')) {
    console.log('Demo data removed.');
    return;
  }
  await setKillSwitch(false, null, null);

  const { app, sim } = createSimulatorApp();
  sim.reset({ resolveDelayMs: 25, openingBalance: '100000000.00' });
  const server = createServer(app);
  await new Promise<void>((r, j) => server.once('error', j).listen(PORT, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${PORT}`;
  try {
    const creds = encryptCredentials({
      tokenUrl: `${origin}/v1/oauth/token`,
      tokenUsername: 'demo_client',
      tokenPassword: 'demo_secret',
      tokenMode: 'form',
    });
    const { rows } = await query<{ id: string }>(
      `INSERT INTO monitored_apis (name, description, endpoint_class, severity_default, url, frequency_cron, environment, authentication_type, encrypted_credentials, is_active, tags)
     VALUES ($1,'Demo target for the Load Tests area. Backed by the built-in simulator; inactive so the monitor never polls it.','psp_gateway','LOW',$2,'0 3 1 1 *','sandbox','OAUTH2',$3,false,ARRAY['load-test','demo']) RETURNING id`,
      [NAME, origin, JSON.stringify(creds)],
    );
    const apiId = rows[0]!.id;
    await upsertTargetConfig(apiId, 'MOCK', false, null);
    console.log(`Target "${NAME}" → ${apiId}`);

    const dataset = async (packId: string, name: string): Promise<string> => {
      const ex = packById(packId)!.exampleDataSets.find((d) => d.name === name)!;
      return (
        await createValidatedDataSet(
          { name: `demo-${name}`, environment: 'sandbox', records: ex.records },
          actor,
        )
      ).id;
    };

    const loadRun = async (
      label: string,
      packId: string,
      dsName: string,
      params: Record<string, unknown>,
    ): Promise<void> => {
      const ds = await dataset(packId, dsName);
      const config = planFromPack(packById(packId)!, { dataSetId: ds, ...params });
      const plan = await createPlan({ apiId, name: label, config }, actor);
      await queueRun(plan.id, actor);
      const run = (await runsRepo.claimNextRun(worker))!;
      console.log(`▶ ${label} …`);
      await executeRun(run, { workerId: worker });
      const done = (await runsRepo.getRun(run.id))!;
      console.log(
        `  ${done.status} — ${done.finishedReason} (${done.summary?.totalRequests ?? 0} requests)`,
      );
    };

    // 1. A healthy payout load.
    await loadRun('Payouts — normal busy hour', 'payouts-momo-telecel', 'payouts-success', {
      profile: 'LOAD',
      targetRps: 15,
      durationSeconds: 24,
      maxVus: 40,
    });
    // 2. A healthy read path.
    const wallet = planFromPack(packById('wallet-balance')!, {
      profile: 'LOAD',
      targetRps: 25,
      durationSeconds: 20,
      maxVus: 40,
    });
    const wp = await createPlan({ apiId, name: 'Wallet balance reads', config: wallet }, actor);
    await queueRun(wp.id, actor);
    console.log('▶ Wallet balance reads …');
    await executeRun((await runsRepo.claimNextRun(worker))!, { workerId: worker });
    // 3. A degraded service: slow and flaky, so the report shows a real failure.
    sim.patchConfig({ latency: { baseMs: 900, jitterMs: 500 }, errorRate: 0.04 });
    await loadRun(
      'Collections — degraded provider',
      'collections-momo-telecel',
      'collections-success',
      { profile: 'LOAD', targetRps: 12, durationSeconds: 24, maxVus: 60 },
    );
    sim.reset({ resolveDelayMs: 25, openingBalance: '100000000.00' });

    // 4. The two suites.
    for (const suite of ['correctness', 'security'] as const) {
      await queueCorrectnessRun(apiId, undefined, actor, suite);
      console.log(`▶ ${suite} suite …`);
      await executeCorrectnessRun((await suitesRepo.claimNextCorrectnessRun(worker))!, {
        workerId: worker,
      });
    }

    console.log('\nDone. Open the dashboard → Load Tests.');
  } finally {
    await new Promise((r) => server.close(r));
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    const details = (err as { details?: unknown }).details;
    if (details) console.error(JSON.stringify(details, null, 2));
    process.exitCode = 1;
  })
  .finally(() => closePool());
