import { afterAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { checkDbHealth, closePool, getPool, query } from '../lib/db.js';
import { DB_ENUMS, RBAC_ROLES } from '../domain/enums.js';

const DOMAIN_TABLES = [
  'roles',
  'teams',
  'users',
  'user_roles',
  'escalation_policies',
  'on_call_schedules',
  'monitored_apis',
  'maintenance_windows',
  'cron_job_runs',
  'health_check_results',
  'scheduler_heartbeats',
  'incidents',
  'alerts',
  'sla_reports',
  'audit_logs',
] as const;

const dbUp = (await checkDbHealth()).ok;

/** Runs `fn` inside a transaction that is always rolled back, for test isolation. */
async function withRollback(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function seedTarget(client: PoolClient): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron)
     VALUES ($1, 'payment_status', 'CRITICAL', 'https://example.test/x', '*/1 * * * *')
     RETURNING id`,
    [`t-${Math.random().toString(36).slice(2)}`],
  );
  return res.rows[0]!.id;
}

describe.skipIf(!dbUp)('database schema (Phase 2)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('has every domain table', async () => {
    const { rows } = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const present = new Set(rows.map((r) => r.table_name));
    for (const table of DOMAIN_TABLES) {
      expect(present, `missing table: ${table}`).toContain(table);
    }
  });

  it('database enum labels match src/domain/enums.ts exactly', async () => {
    const names = Object.keys(DB_ENUMS);
    const { rows } = await query<{ typname: string; enumlabel: string }>(
      `SELECT t.typname, e.enumlabel
       FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = ANY($1)
       ORDER BY t.typname, e.enumsortorder`,
      [names],
    );

    const fromDb = new Map<string, string[]>();
    for (const row of rows) {
      const list = fromDb.get(row.typname) ?? [];
      list.push(row.enumlabel);
      fromDb.set(row.typname, list);
    }

    for (const [name, labels] of Object.entries(DB_ENUMS)) {
      expect(fromDb.get(name), `enum ${name}`).toEqual([...labels]);
    }
  });

  it('seeds exactly the six RBAC roles', async () => {
    const { rows } = await query<{ key: string }>('SELECT key FROM roles ORDER BY key');
    expect(rows.map((r) => r.key).sort()).toEqual([...RBAC_ROLES].sort());
  });

  it('rejects a non-positive timeout on monitored_apis', async () => {
    await withRollback(async (client) => {
      await expect(
        client.query(
          `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron, timeout_ms)
           VALUES ('bad-timeout', 'internal', 'LOW', 'https://example.test', '*/5 * * * *', 0)`,
        ),
      ).rejects.toThrow(/monitored_apis_timeout_positive/);
    });
  });

  it('allows only one active incident per target', async () => {
    await withRollback(async (client) => {
      const targetId = await seedTarget(client);
      const insertIncident = (n: number): Promise<unknown> =>
        client.query(
          `INSERT INTO incidents (api_id, incident_number, severity, endpoint_class_snapshot, is_money_moving_snapshot)
           VALUES ($1, $2, 'CRITICAL', 'payment_status', false)`,
          [targetId, `INC-TEST-${n}`],
        );
      await insertIncident(1);
      await expect(insertIncident(2)).rejects.toThrow(/incidents_one_active_per_target/);
    });
  });

  it('permits a new incident once the previous one is resolved', async () => {
    await withRollback(async (client) => {
      const targetId = await seedTarget(client);
      await client.query(
        `INSERT INTO incidents (api_id, incident_number, severity, endpoint_class_snapshot, is_money_moving_snapshot, status, resolved_at)
         VALUES ($1, 'INC-TEST-R1', 'CRITICAL', 'payment_status', false, 'RESOLVED', now())`,
        [targetId],
      );
      await expect(
        client.query(
          `INSERT INTO incidents (api_id, incident_number, severity, endpoint_class_snapshot, is_money_moving_snapshot)
           VALUES ($1, 'INC-TEST-R2', 'CRITICAL', 'payment_status', false)`,
          [targetId],
        ),
      ).resolves.toBeDefined();
    });
  });

  // UPDATE and DELETE are checked in separate transactions: the first failure
  // aborts its transaction, so a second statement on the same one would only see
  // "transaction is aborted" rather than the trigger's own message.
  it('makes audit_logs reject UPDATE', async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO audit_logs (actor_label, action, entity_type)
         VALUES ('system:test', 'test.event', 'test') RETURNING id`,
      );
      await expect(
        client.query(`UPDATE audit_logs SET action = 'tampered' WHERE id = $1`, [rows[0]!.id]),
      ).rejects.toThrow(/append-only/);
    });
  });

  it('makes audit_logs reject DELETE', async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO audit_logs (actor_label, action, entity_type)
         VALUES ('system:test', 'test.event', 'test') RETURNING id`,
      );
      await expect(
        client.query(`DELETE FROM audit_logs WHERE id = $1`, [rows[0]!.id]),
      ).rejects.toThrow(/append-only/);
    });
  });

  it('touches updated_at via trigger on update', async () => {
    // Uses autocommitted statements (not a single rollback transaction) because
    // now() is fixed for a transaction's lifetime.
    const name = `trigger-test-${Math.random().toString(36).slice(2)}`;
    const { rows } = await query<{ id: string; updated_at: string }>(
      `INSERT INTO teams (name) VALUES ($1) RETURNING id, updated_at`,
      [name],
    );
    const id = rows[0]!.id;
    try {
      await new Promise((r) => setTimeout(r, 10));
      const { rows: after } = await query<{ updated_at: string }>(
        `UPDATE teams SET description = 'x' WHERE id = $1 RETURNING updated_at`,
        [id],
      );
      expect(new Date(after[0]!.updated_at).getTime()).toBeGreaterThan(
        new Date(rows[0]!.updated_at).getTime(),
      );
    } finally {
      await query(`DELETE FROM teams WHERE id = $1`, [id]);
    }
  });
});
