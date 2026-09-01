import { query, sql, type SqlRunner } from '../lib/db.js';

function runner(client?: SqlRunner): SqlRunner {
  return client ?? sql;
}

export type IncidentEventKind =
  | 'detected'
  | 'failure_changed'
  | 'severity_escalated'
  | 'flapping_detected'
  | 'latency_elevated'
  | 'dependency_error'
  | 'database_error'
  | 'rca_computed'
  | 'acknowledged'
  | 'recovered'
  | 'resolved'
  | 'alert';

export interface IncidentEventInput {
  incidentId: string;
  kind: IncidentEventKind;
  summary: string;
  detail?: Record<string, unknown>;
  source?: string;
  at?: Date;
}

export async function recordIncidentEvent(
  input: IncidentEventInput,
  client?: SqlRunner,
): Promise<void> {
  await runner(client).query(
    `INSERT INTO incident_events (incident_id, at, kind, summary, detail, source)
     VALUES ($1, COALESCE($2, now()), $3, $4, $5, $6)`,
    [
      input.incidentId,
      input.at ?? null,
      input.kind,
      input.summary,
      JSON.stringify(input.detail ?? {}),
      input.source ?? 'system',
    ],
  );
}

/** True once an event of this kind already exists for the incident (de-dupe). */
export async function incidentEventExists(
  incidentId: string,
  kind: IncidentEventKind,
): Promise<boolean> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM incident_events WHERE incident_id = $1 AND kind = $2`,
    [incidentId, kind],
  );
  return Number(rows[0]?.n ?? '0') > 0;
}

export interface TimelineEntry {
  at: string;
  kind: string;
  summary: string;
  detail: Record<string, unknown>;
  source: string;
}

/**
 * The full incident timeline: recorded events + the incident's alert rows +
 * its lifecycle timestamps, merged and ordered.
 */
export async function incidentTimeline(incidentId: string): Promise<TimelineEntry[]> {
  const { rows } = await query<Record<string, unknown>>(
    `WITH ev AS (
       SELECT at, kind, summary, detail, source
       FROM incident_events WHERE incident_id = $1
     ),
     al AS (
       SELECT
         COALESCE(a.sent_at, a.created_at) AS at,
         CASE a.status
           WHEN 'SENT' THEN 'alert_sent'
           WHEN 'FAILED' THEN 'alert_failed'
           WHEN 'SUPPRESSED' THEN 'alert_suppressed'
           ELSE 'alert_queued'
         END AS kind,
         a.alert_type || ' → ' || a.channel || ' (' || a.recipient || ')'
           || CASE WHEN a.status = 'FAILED' AND a.error_message IS NOT NULL
                   THEN ': ' || a.error_message ELSE '' END AS summary,
         jsonb_build_object(
           'alertType', a.alert_type, 'channel', a.channel,
           'recipient', a.recipient, 'status', a.status, 'tier', a.escalation_tier
         ) AS detail,
         'delivery' AS source
       FROM alerts a WHERE a.incident_id = $1
     ),
     life AS (
       SELECT started_at AS at, 'detected' AS kind,
              'Incident ' || incident_number || ' opened' AS summary,
              jsonb_build_object('detectedByCheckId', detected_by_check_id,
                                 'severity', severity, 'type', incident_type) AS detail,
              'incident' AS source
       FROM incidents WHERE id = $1
       UNION ALL
       SELECT acknowledged_at, 'acknowledged', 'Incident acknowledged', '{}'::jsonb, 'incident'
       FROM incidents WHERE id = $1 AND acknowledged_at IS NOT NULL
       UNION ALL
       SELECT resolved_at, 'resolved',
              'Incident resolved after ' || COALESCE(duration_seconds::text, '?') || 's',
              jsonb_build_object('durationSeconds', duration_seconds), 'incident'
       FROM incidents WHERE id = $1 AND resolved_at IS NOT NULL
     ),
     merged AS (
       SELECT * FROM ev
       UNION ALL SELECT * FROM al
       UNION ALL SELECT * FROM life
     )
     SELECT at, kind, summary, detail, source FROM merged
     ORDER BY at,
       CASE kind
         WHEN 'detected' THEN 0
         WHEN 'resolved' THEN 90
         WHEN 'acknowledged' THEN 80
         ELSE 50
       END`,
    [incidentId],
  );
  return rows.map((r) => ({
    at: (r['at'] as Date).toISOString(),
    kind: r['kind'] as string,
    summary: r['summary'] as string,
    detail: (r['detail'] as Record<string, unknown> | null) ?? {},
    source: r['source'] as string,
  }));
}
