import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { env } from '../config/index.js';
import { componentLogger } from './logger.js';

const log = componentLogger('db');

/**
 * The narrow query surface shared by the pool, a pooled client and a
 * transaction client. Repositories accept this so callers can opt into a
 * transaction by passing their client.
 */
export interface SqlRunner {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;
}

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: env().DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: env().SERVICE_NAME,
    });
    pool.on('error', (err) => {
      log.error({ err }, 'idle postgres client error');
    });
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: readonly unknown[],
): Promise<QueryResult<T>> {
  const started = performance.now();
  const res = await getPool().query<T>(text, params as unknown[] | undefined);
  const durationMs = Math.round(performance.now() - started);
  if (durationMs > 200) {
    log.warn({ durationMs, rowCount: res.rowCount }, 'slow query (>200ms)');
  }
  return res;
}

/** The pool as an {@link SqlRunner}, for repositories called outside a transaction. */
export const sql: SqlRunner = { query };

/** Run a set of statements inside a single transaction. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface DbHealth {
  ok: boolean;
  latencyMs: number | null;
  error?: string;
}

export async function checkDbHealth(): Promise<DbHealth> {
  const started = performance.now();
  try {
    await getPool().query('SELECT 1');
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return {
      ok: false,
      latencyMs: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
