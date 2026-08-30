import { afterAll, describe, expect, it } from 'vitest';
import { checkDbHealth, closePool, query } from '../../lib/db.js';
import { isCredentialEnvelope } from '../../lib/crypto/credential-cipher.js';
import type { AuditActor } from '../audit/audit.service.js';
import {
  createTarget,
  deleteTarget,
  getTarget,
  listTargets,
  setTargetEnabled,
  updateTarget,
} from './target.service.js';

const dbUp = (await checkDbHealth()).ok;
const actor: AuditActor = { label: 'test:runner', requestId: 'test' };
const created: string[] = [];

async function makeTarget(overrides: Record<string, unknown> = {}): Promise<string> {
  const t = await createTarget(
    {
      name: `svc-test-${Math.random().toString(36).slice(2)}`,
      endpointClass: 'payment_status',
      url: 'https://203.0.113.10/status',
      frequencyCron: '*/5 * * * *',
      ...overrides,
    },
    actor,
  );
  created.push(t.id);
  return t.id;
}

describe.skipIf(!dbUp)('target service (Phase 3)', () => {
  afterAll(async () => {
    if (created.length) await query(`DELETE FROM monitored_apis WHERE id = ANY($1)`, [created]);
    await closePool();
  });

  it('applies endpoint-class defaults', async () => {
    const id = await makeTarget({ endpointClass: 'reporting' });
    const target = await getTarget(id);
    expect(target.severityDefault).toBe('LOW');
    expect(target.slaTargetPercent).toBeCloseTo(99.95);
    expect(target.method).toBe('GET');
    expect(target.isActive).toBe(true);
  });

  it('rejects an invalid cron expression', async () => {
    await expect(makeTarget({ frequencyCron: 'every-so-often' })).rejects.toThrow(/cron/i);
  });

  it('enforces the money-moving 5-minute frequency floor (Rule 16)', async () => {
    await expect(makeTarget({ isMoneyMoving: true, frequencyCron: '0 * * * *' })).rejects.toThrow(
      /Rule 16/,
    );
    // 1-minute cadence is allowed for money-moving targets.
    await expect(
      makeTarget({ isMoneyMoving: true, frequencyCron: '*/1 * * * *' }),
    ).resolves.toBeDefined();
  });

  it('blocks a private target URL unless overridden', async () => {
    await expect(
      makeTarget({ url: 'http://169.254.169.254/latest/meta-data', endpointClass: 'internal' }),
    ).rejects.toThrow(/SSRF/i);
    await expect(
      makeTarget({
        url: 'http://10.0.0.9:8080/health',
        endpointClass: 'internal',
        allowPrivateNetwork: true,
      }),
    ).resolves.toBeDefined();
  });

  it('stores credentials as an encryption envelope, never plaintext', async () => {
    const id = await makeTarget({
      authenticationType: 'API_KEY',
      credentials: { apiId: 'pub-id', apiSecret: 'do-not-store-me' },
    });
    const target = await getTarget(id);
    expect(target.hasCredentials).toBe(true);

    const { rows } = await query<{ encrypted_credentials: unknown }>(
      `SELECT encrypted_credentials FROM monitored_apis WHERE id = $1`,
      [id],
    );
    expect(isCredentialEnvelope(rows[0]!.encrypted_credentials)).toBe(true);
    expect(JSON.stringify(rows[0]!.encrypted_credentials)).not.toContain('do-not-store-me');
  });

  it('updates fields and writes an audit trail', async () => {
    const id = await makeTarget();
    await updateTarget(id, { description: 'now with a description', timeoutMs: 4321 }, actor);
    const target = await getTarget(id);
    expect(target.description).toBe('now with a description');
    expect(target.timeoutMs).toBe(4321);

    const { rows } = await query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY created_at`,
      [id],
    );
    expect(rows.map((r) => r.action)).toEqual(['target.created', 'target.updated']);
  });

  it('enables and disables monitoring', async () => {
    const id = await makeTarget();
    expect((await setTargetEnabled(id, false, actor)).isActive).toBe(false);
    expect((await setTargetEnabled(id, true, actor)).isActive).toBe(true);
  });

  it('lists with filters', async () => {
    await makeTarget({ endpointClass: 'ledger', tags: ['phase3-filter-test'] });
    const results = await listTargets({ tag: 'phase3-filter-test' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((t) => t.tags.includes('phase3-filter-test'))).toBe(true);
  });

  it('deletes a target', async () => {
    const id = await makeTarget();
    await deleteTarget(id, actor);
    await expect(getTarget(id)).rejects.toThrow(/not found/i);
  });
});
