import { query } from '../../lib/db.js';
import { componentLogger } from '../../lib/logger.js';

const log = componentLogger('lock');

/**
 * Distributed lock backed by a Postgres table with a TTL (the "simpler
 * fallback" the spec allows instead of Redlock — see vault: "Leader Election
 * and Distributed Locking"). A crashed holder's lock self-expires so it can be
 * stolen rather than deadlocking future runs.
 */
export async function acquireLock(key: string, holder: string, ttlMs: number): Promise<boolean> {
  const { rows } = await query<{ holder: string }>(
    `INSERT INTO job_locks (key, holder, acquired_at, expires_at)
     VALUES ($1, $2, now(), now() + ($3::double precision * interval '1 millisecond'))
     ON CONFLICT (key) DO UPDATE
       SET holder = EXCLUDED.holder,
           acquired_at = EXCLUDED.acquired_at,
           expires_at = EXCLUDED.expires_at
       WHERE job_locks.expires_at < now()
     RETURNING holder`,
    [key, holder, ttlMs],
  );
  return rows.length === 1 && rows[0]!.holder === holder;
}

export async function releaseLock(key: string, holder: string): Promise<void> {
  await query(`DELETE FROM job_locks WHERE key = $1 AND holder = $2`, [key, holder]);
}

/** Runs `fn` iff the lock is acquired; returns undefined when contended. */
export async function withLock<T>(
  key: string,
  holder: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  if (!(await acquireLock(key, holder, ttlMs))) return { ran: false };
  try {
    return { ran: true, value: await fn() };
  } finally {
    await releaseLock(key, holder).catch((err: unknown) =>
      log.error({ err, key }, 'failed to release lock (it will expire via TTL)'),
    );
  }
}

/** Housekeeping: drop locks that expired well in the past. */
export async function pruneExpiredLocks(): Promise<number> {
  const { rowCount } = await query(
    `DELETE FROM job_locks WHERE expires_at < now() - interval '1 hour'`,
  );
  return rowCount ?? 0;
}
