import type { PoolClient } from 'pg';
import { query } from '../../lib/db.js';
import { componentLogger } from '../../lib/logger.js';

const log = componentLogger('audit');

export interface AuditActor {
  userId?: string | null;
  label?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface AuditEntry {
  actor: AuditActor;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary?: string;
  changes?: { before?: unknown; after?: unknown } | null;
}

type Runner = Pick<PoolClient, 'query'>;

/**
 * Writes one immutable audit row. Pass a transaction client as `runner` to make
 * the audit entry atomic with the change it describes (see vault:
 * "API Security and Audit Immutability").
 */
export async function recordAudit(entry: AuditEntry, runner?: Runner): Promise<void> {
  const { actor } = entry;
  const params = [
    actor.userId ?? null,
    actor.userId ? null : (actor.label ?? 'system:unknown'),
    entry.action,
    entry.entityType,
    entry.entityId ?? null,
    entry.summary ?? null,
    entry.changes ? JSON.stringify(entry.changes) : null,
    actor.ip ?? null,
    actor.userAgent ?? null,
    actor.requestId ?? null,
  ];
  const sql = `
    INSERT INTO audit_logs
      (actor_user_id, actor_label, action, entity_type, entity_id, summary, changes, ip_address, user_agent, request_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;

  try {
    if (runner) {
      await runner.query(sql, params);
    } else {
      await query(sql, params);
    }
  } catch (err) {
    // An audit write must never be silently dropped.
    log.error(
      { err, action: entry.action, entityType: entry.entityType },
      'failed to write audit log',
    );
    throw err;
  }
}
