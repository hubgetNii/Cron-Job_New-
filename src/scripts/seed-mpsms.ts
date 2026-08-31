import 'dotenv/config';
import { createTarget } from '../services/target/target.service.js';
import { listTargets } from '../repositories/monitored-apis.repo.js';
import { closePool } from '../lib/db.js';
import type { AuditActor } from '../services/audit/audit.service.js';

/* eslint-disable no-console */

/**
 * Registers the MPSMS "Connect" endpoint as a monitored target.
 *
 * MPSMS (`vend.ismartghana.com/api/topup`) is the airtime-vending vendor
 * iSmartPay integrates against. `/connect` starts an API session — it is NOT
 * money-moving (that's `/topup` and `/deposit`), so it is safe to poll.
 *
 * Auth is HTTP Basic: username = access code, password = client code. Both come
 * from the MPSMS Console and are read from the environment here — never hard-coded.
 *
 *   MPSMS_ACCESSCODE=...   (the UUID access code)
 *   MPSMS_CLIENTCODE=...   (e.g. ISMS)
 *   MPSMS_BASE_URL=https://vend.ismartghana.com/api/topup   (optional; this is the default)
 *   MPSMS_TRACKID=...      (optional; a fixed UUID sent in the body)
 */
const BASE_URL = process.env['MPSMS_BASE_URL'] ?? 'https://vend.ismartghana.com/api/topup';
const ACCESSCODE = process.env['MPSMS_ACCESSCODE'];
const CLIENTCODE = process.env['MPSMS_CLIENTCODE'];
const TRACKID = process.env['MPSMS_TRACKID'] ?? '53ce8742-0470-4a7c-bc3a-075e2c7b21ff';

const NAME = 'MPSMS Connect (start session)';
const URL = `${BASE_URL.replace(/\/$/, '')}/connect`;

const actor: AuditActor = { userId: null, label: 'system:seed' };

const TARGET_CONFIG = {
  name: NAME,
  description:
    'vend.ismartghana.com airtime vendor — session handshake. Not money-moving. Basic auth (accesscode:clientcode).',
  endpointClass: 'psp_gateway',
  environment: 'production',
  isMoneyMoving: false,
  url: URL,
  method: 'POST',
  authenticationType: 'BASIC',
  credentials: { username: ACCESSCODE ?? '', password: CLIENTCODE ?? '' },
  requestBody: { trackid: TRACKID },
  frequencyCron: '*/1 * * * *',
  timeoutMs: 10_000,
  // MPSMS replies 200 (not 201) with { success, code, message, data:{ token, expiry } }.
  expectedStatus: 200,
  expectedResponse: {
    type: 'composite',
    mode: 'all',
    rules: [
      { type: 'json_equals', path: 'success', equals: true },
      { type: 'numeric', path: 'code', op: '==', value: 0 },
    ],
  },
} as const;

async function main(): Promise<void> {
  if (!ACCESSCODE || !CLIENTCODE) {
    throw new Error('Set MPSMS_ACCESSCODE and MPSMS_CLIENTCODE in the environment first');
  }

  const existing = (await listTargets()).find((t) => t.name === NAME || t.url === URL);
  if (existing) {
    console.log(`"${NAME}" already registered (id ${existing.id}) — nothing to do.`);
    return;
  }

  const result = await createTarget(TARGET_CONFIG, actor);
  if (result.status !== 'applied') {
    throw new Error(`Unexpected result: ${result.status}`);
  }
  console.log(`Registered "${NAME}"`);
  console.log(`  id:   ${result.target.id}`);
  console.log(`  url:  ${result.target.url}`);
  console.log(`  auth: BASIC (credentials encrypted at rest)`);
  console.log(`  poll: every 1 min, expects HTTP 200 + success=true + code=0`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
