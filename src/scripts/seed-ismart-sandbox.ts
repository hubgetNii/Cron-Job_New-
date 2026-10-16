import 'dotenv/config';
import { createTarget } from '../services/target/target.service.js';
import { listTargets } from '../repositories/monitored-apis.repo.js';
import { upsertTargetConfig } from '../repositories/load-test-safety.repo.js';
import { closePool } from '../lib/db.js';
import type { AuditActor } from '../services/audit/audit.service.js';

/* eslint-disable no-console */

/**
 * Registers the iSmartPay SANDBOX developer API as a LOAD-TEST target and
 * classifies it SANDBOX. One target serves every scenario pack: each plan
 * supplies its own path, while the origin (and therefore the host allow-list
 * check) always comes from this target.
 *
 *   ISMARTPAY_SANDBOX_CLIENT_ID=...       key created in the TEST console
 *   ISMARTPAY_SANDBOX_CLIENT_SECRET=...   shown once when the key is created
 *   ISMARTPAY_SANDBOX_BASE_URL=https://stgdeveloper-api.ismartghana.com   (default)
 *
 * The target is registered INACTIVE (`isActive: false`) so the cron monitor
 * never polls it — it exists for load tests only. It is never money-moving at
 * the target level; each plan declares `moneyMoving` / `realSideEffects` itself.
 *
 * Utility purchases send REAL airtime in the sandbox (per the docs); that is a
 * plan-level flag held to ≤1 rps and explicit authorization by the safety gate.
 */
const BASE_URL = (
  process.env['ISMARTPAY_SANDBOX_BASE_URL'] ?? 'https://stgdeveloper-api.ismartghana.com'
).replace(/\/$/, '');
const CLIENT_ID = process.env['ISMARTPAY_SANDBOX_CLIENT_ID'];
const CLIENT_SECRET = process.env['ISMARTPAY_SANDBOX_CLIENT_SECRET'];
const NAME = 'iSmartPay Developer API (sandbox, load test)';

const actor: AuditActor = { userId: null, label: 'system:seed' };

async function main(): Promise<void> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      'Set ISMARTPAY_SANDBOX_CLIENT_ID and ISMARTPAY_SANDBOX_CLIENT_SECRET (a TEST-console key) first',
    );
  }
  if (CLIENT_ID.startsWith('live_')) {
    throw new Error('That looks like a LIVE key. Refusing: use a key created in the test console.');
  }
  const existing = (await listTargets()).find((t) => t.name === NAME);
  if (existing) {
    await upsertTargetConfig(existing.id, 'SANDBOX', false, null);
    console.log(`"${NAME}" already registered (id ${existing.id}); load class confirmed SANDBOX.`);
    return;
  }

  const result = await createTarget(
    {
      name: NAME,
      description:
        'iSmartPay staging developer API for load testing. Token: POST /v1/oauth/token (form client_credentials, resource=ismartpay, 5-minute lifetime).',
      endpointClass: 'psp_gateway',
      environment: 'sandbox',
      isMoneyMoving: false,
      url: BASE_URL,
      method: 'GET',
      authenticationType: 'OAUTH2',
      credentials: {
        tokenUrl: `${BASE_URL}/v1/oauth/token`,
        tokenUsername: CLIENT_ID,
        tokenPassword: CLIENT_SECRET,
        tokenMode: 'form',
        tokenResource: 'ismartpay',
      },
      frequencyCron: '0 3 1 1 *',
      timeoutMs: 30_000,
      isActive: false,
      tags: ['load-test', 'ismartpay-sandbox'],
    },
    actor,
  );
  if (result.status !== 'applied') throw new Error(`Unexpected result: ${result.status}`);
  await upsertTargetConfig(result.target.id, 'SANDBOX', false, null);
  console.log(`Registered "${NAME}"`);
  console.log(`  id:     ${result.target.id}`);
  console.log(`  url:    ${BASE_URL}`);
  console.log('  class:  SANDBOX (inactive — the cron monitor will not poll it)');
  console.log('Next: request a load-test authorization (POST /api/v1/load-tests/authorizations),');
  console.log('      have a second ADMIN approve it, then instantiate a scenario pack.');
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
