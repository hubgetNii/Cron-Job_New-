import { describe, expect, it } from 'vitest';
import {
  decryptCredentials,
  encryptCredentials,
  isCredentialEnvelope,
} from './credential-cipher.js';

describe('credential cipher', () => {
  it('round-trips a credential object', () => {
    const secret = { apiId: 'abc123', apiSecret: 'super-secret-value' };
    const envelope = encryptCredentials(secret);
    expect(isCredentialEnvelope(envelope)).toBe(true);
    expect(decryptCredentials(envelope)).toEqual(secret);
  });

  it('never exposes plaintext in the envelope', () => {
    const envelope = encryptCredentials({ apiSecret: 'leak-me' });
    expect(JSON.stringify(envelope)).not.toContain('leak-me');
  });

  it('produces a fresh IV each time', () => {
    const a = encryptCredentials({ x: '1' });
    const b = encryptCredentials({ x: '1' });
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('rejects a tampered ciphertext', () => {
    const envelope = encryptCredentials({ x: 'value' });
    const tampered = { ...envelope, ciphertext: Buffer.from('tampered').toString('base64') };
    expect(() => decryptCredentials(tampered)).toThrow();
  });
});
