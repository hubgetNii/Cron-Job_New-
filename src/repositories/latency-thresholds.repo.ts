import { query } from '../lib/db.js';
import type { LatencyThresholds } from '../domain/latency.js';

export interface LatencyThresholdRow extends LatencyThresholds {
  apiId: string;
  updatedBy: string | null;
  updatedAt: string;
}

function toRow(r: Record<string, unknown>): LatencyThresholdRow {
  return {
    apiId: r['api_id'] as string,
    normalMs: Number(r['normal_ms']),
    degradedMs: Number(r['degraded_ms']),
    criticalMs: Number(r['critical_ms']),
    updatedBy: (r['updated_by'] as string | null) ?? null,
    updatedAt: (r['updated_at'] as Date).toISOString(),
  };
}

export async function getThresholds(apiId: string): Promise<LatencyThresholdRow | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT * FROM latency_thresholds WHERE api_id = $1`,
    [apiId],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/** All custom threshold rows, keyed by api_id. */
export async function allThresholds(): Promise<Map<string, LatencyThresholds>> {
  const { rows } = await query<Record<string, unknown>>(`SELECT * FROM latency_thresholds`);
  const map = new Map<string, LatencyThresholds>();
  for (const r of rows) {
    const row = toRow(r);
    map.set(row.apiId, {
      normalMs: row.normalMs,
      degradedMs: row.degradedMs,
      criticalMs: row.criticalMs,
    });
  }
  return map;
}

export async function upsertThresholds(
  apiId: string,
  t: LatencyThresholds,
  updatedBy: string | null,
): Promise<LatencyThresholdRow> {
  const { rows } = await query<Record<string, unknown>>(
    `INSERT INTO latency_thresholds (api_id, normal_ms, degraded_ms, critical_ms, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (api_id) DO UPDATE SET
       normal_ms = EXCLUDED.normal_ms,
       degraded_ms = EXCLUDED.degraded_ms,
       critical_ms = EXCLUDED.critical_ms,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING *`,
    [apiId, t.normalMs, t.degradedMs, t.criticalMs, updatedBy],
  );
  return toRow(rows[0]!);
}

export async function deleteThresholds(apiId: string): Promise<boolean> {
  const { rowCount } = await query(`DELETE FROM latency_thresholds WHERE api_id = $1`, [apiId]);
  return (rowCount ?? 0) > 0;
}
