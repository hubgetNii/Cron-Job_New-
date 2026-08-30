import { query } from '../lib/db.js';

export type AiInsightKind =
  | 'failure_classification'
  | 'root_cause'
  | 'incident_summary'
  | 'latency_anomaly'
  | 'error_rate_anomaly';

export interface AiInsight {
  id: string;
  entityType: 'incident' | 'target';
  entityId: string;
  kind: AiInsightKind;
  assistive: true;
  confidence: number | null;
  model: string;
  content: unknown;
  createdAt: Date;
}

const COLUMNS = `id, entity_type, entity_id, kind, assistive, confidence, model, content, created_at`;

function toDomain(r: Record<string, unknown>): AiInsight {
  return {
    id: r['id'] as string,
    entityType: r['entity_type'] as 'incident' | 'target',
    entityId: r['entity_id'] as string,
    kind: r['kind'] as AiInsightKind,
    assistive: true,
    confidence: r['confidence'] != null ? Number(r['confidence']) : null,
    model: r['model'] as string,
    content: r['content'],
    createdAt: r['created_at'] as Date,
  };
}

export async function saveInsight(input: {
  entityType: 'incident' | 'target';
  entityId: string;
  kind: AiInsightKind;
  confidence: number | null;
  model: string;
  content: unknown;
}): Promise<AiInsight> {
  const { rows } = await query(
    `INSERT INTO ai_insights (entity_type, entity_id, kind, confidence, model, content)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${COLUMNS}`,
    [
      input.entityType,
      input.entityId,
      input.kind,
      input.confidence,
      input.model,
      JSON.stringify(input.content),
    ],
  );
  return toDomain(rows[0] as Record<string, unknown>);
}

/** The most recent insight of each kind for an entity. */
export async function latestInsightsFor(
  entityType: 'incident' | 'target',
  entityId: string,
): Promise<AiInsight[]> {
  const { rows } = await query(
    `SELECT DISTINCT ON (kind) ${COLUMNS} FROM ai_insights
     WHERE entity_type = $1 AND entity_id = $2
     ORDER BY kind, created_at DESC`,
    [entityType, entityId],
  );
  return (rows as Array<Record<string, unknown>>).map(toDomain);
}

export async function recentAnomalyInsights(hours = 24): Promise<AiInsight[]> {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM ai_insights
     WHERE kind IN ('latency_anomaly', 'error_rate_anomaly')
       AND created_at > now() - ($1::int * interval '1 hour')
     ORDER BY created_at DESC LIMIT 100`,
    [hours],
  );
  return (rows as Array<Record<string, unknown>>).map(toDomain);
}

/** Was an anomaly of this kind already recorded for this target recently? (de-dup) */
export async function anomalyRecentlyRecorded(
  targetId: string,
  kind: 'latency_anomaly' | 'error_rate_anomaly',
  withinMinutes: number,
): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM ai_insights
     WHERE entity_type = 'target' AND entity_id = $1 AND kind = $2
       AND created_at > now() - ($3::int * interval '1 minute')
     LIMIT 1`,
    [targetId, kind, withinMinutes],
  );
  return rows.length > 0;
}
