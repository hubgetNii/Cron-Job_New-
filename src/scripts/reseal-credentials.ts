import 'dotenv/config';
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { query, closePool } from '../lib/db.js';
import { resetEnvCache } from '../config/index.js';
import {
  encryptJson,
  resetCredentialKeyCache,
  type CredentialEnvelope,
} from '../lib/crypto/credential-cipher.js';

/* eslint-disable no-console */

/**
 * Re-encrypts every stored target credential envelope under a NEW
 * `CREDENTIAL_ENCRYPTION_KEY`. Run this whenever the KEK changes — including the
 * one-time move OFF the insecure hard-coded development key.
 *
 *   # generate + apply a fresh key
 *   npm run reseal-credentials
 *
 *   # or reseal to a key you already have
 *   npm run reseal-credentials -- <base64-32-byte-key>
 *
 * It decrypts each envelope with whichever key still opens it (the new key if
 * already migrated, else the old dev key), then re-seals with the new key. Safe
 * to re-run. After it finishes, persist the printed key to `.env` and restart
 * the API + scheduler.
 */

const DEV_KEY = createHash('sha256').update('fintech-cron-monitor:dev-kek').digest();

function rawDecrypt(key: Buffer, env: CredentialEnvelope): Record<string, string> {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  d.setAuthTag(Buffer.from(env.tag, 'base64'));
  const out = Buffer.concat([d.update(Buffer.from(env.ciphertext, 'base64')), d.final()]);
  return JSON.parse(out.toString('utf8')) as Record<string, string>;
}

async function main(): Promise<void> {
  const provided = process.argv[2];
  const newKeyB64 = provided ?? randomBytes(32).toString('base64');
  const newKey = Buffer.from(newKeyB64, 'base64');
  if (newKey.length !== 32) throw new Error('key must be 32 bytes, base64-encoded');

  process.env['CREDENTIAL_ENCRYPTION_KEY'] = newKeyB64;
  resetEnvCache();
  resetCredentialKeyCache();

  const { rows } = await query<{ id: string; name: string; encrypted_credentials: CredentialEnvelope }>(
    `SELECT id, name, encrypted_credentials FROM monitored_apis
     WHERE encrypted_credentials IS NOT NULL`,
  );
  console.log(`${rows.length} credentialed target(s) to reseal\n`);

  let resealed = 0;
  let alreadyOk = 0;
  for (const r of rows) {
    let plaintext: Record<string, string>;
    try {
      plaintext = rawDecrypt(newKey, r.encrypted_credentials);
      alreadyOk += 1;
      console.log(`  = ${r.name} — already sealed with the new key`);
      continue;
    } catch {
      /* fall through to the old key */
    }
    try {
      plaintext = rawDecrypt(DEV_KEY, r.encrypted_credentials);
    } catch {
      console.error(`  ! ${r.name} — cannot decrypt with the new OR the dev key; skipped`);
      continue;
    }
    const sealed = encryptJson(plaintext);
    await query(`UPDATE monitored_apis SET encrypted_credentials = $1 WHERE id = $2`, [
      JSON.stringify(sealed),
      r.id,
    ]);
    resealed += 1;
    console.log(`  ✓ ${r.name} — resealed`);
  }

  console.log(`\nDone: ${resealed} resealed, ${alreadyOk} already current.`);
  if (!provided) {
    console.log(`\nAdd this to .env, then restart the API + scheduler:\n`);
    console.log(`CREDENTIAL_ENCRYPTION_KEY=${newKeyB64}\n`);
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
