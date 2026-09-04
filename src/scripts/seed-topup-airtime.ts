import 'dotenv/config';
import { createTarget } from '../services/target/target.service.js';
import { listTargets } from '../repositories/monitored-apis.repo.js';
import { closePool } from '../lib/db.js';
import type { AuditActor } from '../services/audit/audit.service.js';

/* eslint-disable no-console */

/**
 * Registers the MPSMS "Topup" airtime purchase as a monitored target.
 *
 * Same endpoint and mechanics as `seed-topup-bundle.ts` (see that file for the
 * full rationale) — this is the airtime counterpart, distinguished only by
 * `type: 'TOPUP'` and the absence of `bundle_code`. It shares the same OAuth2
 * token cache (same tokenUrl+tokenUsername), so registering both targets
 * doesn't double the `/connect` refresh traffic.
 *
 * This is a REAL purchase against production — no sandbox exists, so every
 * check (including the first ad-hoc test) sends real airtime and spends real
 * money. Checked every 3 hours via the same audited Rule 16 override as the
 * bundle target.
 *
 *   MPSMS_ACCESSCODE=...        (same UUID access code as seed-mpsms.ts)
 *   MPSMS_CLIENTCODE=...        (e.g. ISMS)
 *   MPSMS_BASE_URL=https://vend.ismartghana.com/api/topup   (optional; this is the default)
 *   TOPUP_AIRTIME_MOBILE=...    (optional; defaults to the number in the sample payload)
 */
const BASE_URL = process.env['MPSMS_BASE_URL'] ?? 'https://vend.ismartghana.com/api/topup';
const ACCESSCODE = process.env['MPSMS_ACCESSCODE'];
const CLIENTCODE = process.env['MPSMS_CLIENTCODE'];
const MOBILE = process.env['TOPUP_AIRTIME_MOBILE'] ?? '233553476530';

const NAME = 'MPSMS Topup — Airtime (MTN)';
const URL = `${BASE_URL.replace(/\/$/, '')}/topup`;
const TOKEN_URL = `${BASE_URL.replace(/\/$/, '')}/connect`;

const actor: AuditActor = { userId: null, label: 'system:seed' };

const TARGET_CONFIG = {
  name: NAME,
  description:
    'vend.ismartghana.com airtime vendor — real airtime purchase used as a health check. ' +
    'No sandbox exists; every check (including ad-hoc tests) spends real money. ' +
    'Checked every 3h (Rule 16 override) instead of every 5min because of the recurring cost.',
  endpointClass: 'utility_vending',
  environment: 'production',
  isMoneyMoving: true,
  bypassMinIntervalFloor: true,
  url: URL,
  method: 'POST',
  authenticationType: 'OAUTH2',
  credentials: {
    tokenUrl: TOKEN_URL,
    tokenUsername: ACCESSCODE ?? '',
    tokenPassword: CLIENTCODE ?? '',
    tokenPath: 'data.token',
    tokenExpiryPath: 'data.expiry',
    // MPSMS requires a trackid even on the /connect handshake (see seed-mpsms.ts).
    tokenBody: '{"trackid":"{{uuid}}"}',
  },
  requestBody: {
    trackid: '{{uuid}}',
    mobile: MOBILE,
    amount: 0.1,
    // "GHS" (Ghana Cedis) — the sample payload had "GH", which is the country
    // code, not a currency code; corrected to match the bundle target.
    currency: 'GHS',
    country: 'GH',
    network: 'mtn',
    notes: 'Automated health check purchase',
    type: 'TOPUP',
  },
  frequencyCron: '0 */3 * * *',
  // MPSMS is known-slow (P95 ~2.5s observed on the Connect target); generous margin.
  timeoutMs: 15_000,
  expectedStatus: 200,
  // PLACEHOLDER pending a real response sample from /topup/topup — only /connect's
  // shape ({success, code, data:{token, expiry}}) is confirmed so far. Correct
  // this after the first live test call captures the real body.
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
  if (result.status === 'pending_approval') {
    console.log(`Money-moving target proposed, awaiting four-eyes approval: ${result.request.id}`);
    return;
  }
  if (result.status !== 'applied') {
    throw new Error(`Unexpected result: ${(result as { status: string }).status}`);
  }
  console.log(`Registered "${NAME}"`);
  console.log(`  id:   ${result.target.id}`);
  console.log(`  url:  ${result.target.url}`);
  console.log(`  auth: OAUTH2 (token fetched from ${TOKEN_URL}, credentials encrypted at rest)`);
  console.log(`  poll: every 3h (Rule 16 override), mobile ${MOBILE}, GHS 0.10 per check`);
  console.log(
    `  WARNING: the first check (scheduled or via POST /targets/${result.target.id}/test) is a real purchase — there is no sandbox.`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
