import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env, isProduction } from '../../config/index.js';
import { componentLogger } from '../logger.js';

/**
 * Credential encryption at rest.
 *
 * This is envelope encryption with a locally-held key-encryption key (from
 * `CREDENTIAL_ENCRYPTION_KEY`). Phase 9 swaps the key source for a KMS/Vault
 * without changing the envelope shape or call sites. Plaintext credentials are
 * never written to the database (spec Rule 6).
 */

const log = componentLogger('credential-cipher');
const ALG = 'aes-256-gcm';

// Deterministic dev/test key so local encryption round-trips across restarts.
// Never used when NODE_ENV=production — a real key is required there.
const DEV_KEY = createHash('sha256').update('fintech-cron-monitor:dev-kek').digest();

let cachedKey: Buffer | undefined;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = env().CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) {
    if (isProduction()) {
      throw new Error('CREDENTIAL_ENCRYPTION_KEY is required in production');
    }
    log.warn('CREDENTIAL_ENCRYPTION_KEY not set — using the insecure development key');
    cachedKey = DEV_KEY;
    return cachedKey;
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  }
  cachedKey = buf;
  return cachedKey;
}

function keyId(k: Buffer): string {
  return createHash('sha256').update(k).digest('hex').slice(0, 16);
}

export interface CredentialEnvelope {
  v: 1;
  alg: 'aes-256-gcm';
  keyId: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

export function isCredentialEnvelope(value: unknown): value is CredentialEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { v?: unknown }).v === 1 &&
    typeof (value as { ciphertext?: unknown }).ciphertext === 'string'
  );
}

export function encryptCredentials(plaintext: Record<string, string>): CredentialEnvelope {
  const k = key();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, k, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(plaintext), 'utf8'), cipher.final()]);
  return {
    v: 1,
    alg: 'aes-256-gcm',
    keyId: keyId(k),
    iv: iv.toString('base64'),
    ciphertext: enc.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptCredentials(envelope: CredentialEnvelope): Record<string, string> {
  const k = key();
  if (envelope.keyId !== keyId(k)) {
    throw new Error('credential envelope was sealed with a different key');
  }
  const decipher = createDecipheriv(ALG, k, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(dec.toString('utf8')) as Record<string, string>;
}

/** Test-only. */
export function resetCredentialKeyCache(): void {
  cachedKey = undefined;
}
