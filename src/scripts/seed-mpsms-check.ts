import 'dotenv/config';
import { createTarget } from '../services/target/target.service.js';
import { listTargets } from '../repositories/monitored-apis.repo.js';
import { closePool } from '../lib/db.js';
import type { AuditActor } from '../services/audit/audit.service.js';

/* eslint-disable no-console */

/**
 * Registers the MPSMS "Check" endpoint (transaction status lookup) as a
 * monitored target.
 *
 * `POST vend.ismartghana.com/api/topup/check` with `{ "reference": "<ref>" }`
 * returns the status of a topup transaction. It is READ-ONLY — like `/connect`
 * and unlike `/topup`, it moves no money, so it is safe to poll every minute.
 *
 * Auth is OAUTH2: the Bearer token is minted by `/connect` (HTTP Basic,
 * accesscode:clientcode) and cached until near expiry by the shared OAuth2
 * token cache — see `seed-mpsms.ts` and `oauth2-token-cache.ts`. Registering
 * this alongside the Connect target does NOT double the `/connect` traffic
 * (same tokenUrl + tokenUsername ⇒ same cache entry).
 *
 * The `reference` must be a real, already-completed transaction so the lookup
 * reliably resolves; swap `MPSMS_CHECK_REFERENCE` if it stops.
 *
 *   MPSMS_ACCESSCODE=...        (same UUID access code as seed-mpsms.ts)
 *   MPSMS_CLIENTCODE=...        (e.g. ISMS)
 *   MPSMS_BASE_URL=https://vend.ismartghana.com/api/topup   (optional; this is the default)
 *   MPSMS_TRACKID=...           (optional; trackid for the /connect handshake)
 *   MPSMS_CHECK_REFERENCE=...   (optional; a stable completed-transaction reference)
 */
const BASE_URL = process.env['MPSMS_BASE_URL'] ?? 'https://vend.ismartghana.com/api/topup';
const ACCESSCODE = process.env['MPSMS_ACCESSCODE'];
const CLIENTCODE = process.env['MPSMS_CLIENTCODE'];
const TRACKID = process.env['MPSMS_TRACKID'] ?? '53ce8742-0470-4a7c-bc3a-075e2c7b21ff';
const REFERENCE = process.env['MPSMS_CHECK_REFERENCE'] ?? '88680726883';

const NAME = 'MPSMS Check (transaction status)';
const URL = `${BASE_URL.replace(/\/$/, '')}/check`;
const TOKEN_URL = `${BASE_URL.replace(/\/$/, '')}/connect`;

const actor: AuditActor = { userId: null, label: 'system:seed' };

const TARGET_CONFIG = {
  name: NAME,
  description:
    'vend.ismartghana.com airtime vendor — transaction status lookup. Read-only, not money-moving. ' +
    'OAUTH2: Bearer token minted by /connect (Basic auth), cached until near expiry.',
  endpointClass: 'psp_gateway',
  environment: 'production',
  isMoneyMoving: false,
  url: URL,
  method: 'POST',
  authenticationType: 'OAUTH2',
  credentials: {
    tokenUrl: TOKEN_URL,
    tokenUsername: ACCESSCODE ?? '',
    tokenPassword: CLIENTCODE ?? '',
    tokenPath: 'data.token',
    // /connect returns an ISO-string expiry (not epoch seconds), so the cache
    // can't parse it — it falls back to a 1h refresh, which is fine here.
    tokenBody: `{"trackid":"${TRACKID}"}`,
  },
  headers: { Accept: 'application/json' },
  requestBody: { reference: REFERENCE },
  frequencyCron: '*/1 * * * *',
  timeoutMs: 10_000,
  // Same MPSMS envelope as /connect and /topup: { success, code, message, data }.
  // Placeholder pending a real /check response sample — correct after the first
  // live test call captures the body.
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
    throw new Error(`Unexpected result: ${(result as { status: string }).status}`);
  }
  console.log(`Registered "${NAME}"`);
  console.log(`  id:   ${result.target.id}`);
  console.log(`  url:  ${result.target.url}`);
  console.log(`  auth: OAUTH2 (token from ${TOKEN_URL}, credentials encrypted at rest)`);
  console.log(`  ref:  ${REFERENCE}`);
  console.log(`  poll: every 1 min, expects HTTP 200 + success=true + code=0`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
