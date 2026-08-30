import { env } from '../../config/index.js';
import { componentLogger } from '../../lib/logger.js';
import { query } from '../../lib/db.js';
import { listActiveTargets } from '../../repositories/monitored-apis.repo.js';
import {
  anomalyRecentlyRecorded,
  saveInsight,
  type AiInsightKind,
} from '../../repositories/ai-insights.repo.js';

const log = componentLogger('anomaly');

export interface Anomaly {
  targetId: string;
  targetName: string;
  kind: 'latency' | 'error_rate';
  metric: string;
  baseline: number;
  observed: number;
  zScore: number | null;
  windowMinutes: number;
  note: string;
}

interface LatencyStats {
  baselineMean: number | null;
  baselineStddev: number | null;
  baselineSamples: number;
  recentMean: number | null;
  recentSamples: number;
}

/**
 * Latency + error-rate anomaly detection. Purely statistical (z-score of the
 * recent window against the rolling baseline) — this is not an LLM call, and it
 * never changes a target's health status or opens an incident (see vault:
 * "AI Allowed Uses and Guardrails"). It only surfaces a signal for a human.
 */
export async function detectAnomalies(targetIds?: string[]): Promise<Anomaly[]> {
  const targets = (await listActiveTargets()).filter((t) => !targetIds || targetIds.includes(t.id));
  const days = env().ANOMALY_BASELINE_DAYS;
  const minSamples = env().ANOMALY_MIN_BASELINE_SAMPLES;
  const z = env().ANOMALY_Z_THRESHOLD;
  const out: Anomaly[] = [];

  for (const target of targets) {
    const { rows } = await query<Record<string, unknown>>(
      `WITH baseline AS (
         SELECT response_time_ms::float AS ms
         FROM health_check_results
         WHERE api_id = $1 AND status IN ('UP','DEGRADED')
           AND response_time_ms IS NOT NULL
           AND checked_at BETWEEN now() - ($2::int * interval '1 day') AND now() - interval '1 hour'
       ),
       recent AS (
         SELECT response_time_ms::float AS ms, status
         FROM health_check_results
         WHERE api_id = $1 AND checked_at > now() - interval '1 hour'
       )
       SELECT
         (SELECT avg(ms) FROM baseline) AS base_mean,
         (SELECT stddev_pop(ms) FROM baseline) AS base_sd,
         (SELECT count(*) FROM baseline) AS base_n,
         (SELECT avg(ms) FROM recent WHERE ms IS NOT NULL) AS recent_mean,
         (SELECT count(*) FROM recent) AS recent_n,
         (SELECT count(*) FILTER (WHERE status = 'DOWN')::float / NULLIF(count(*),0) FROM recent) AS recent_down_rate,
         (SELECT count(*) FILTER (WHERE status = 'DOWN')::float / NULLIF(count(*),0)
          FROM health_check_results
          WHERE api_id = $1 AND checked_at BETWEEN now() - ($2::int * interval '1 day') AND now() - interval '1 hour') AS base_down_rate`,
      [target.id, days],
    );
    const r = rows[0]!;
    const stats: LatencyStats = {
      baselineMean: r['base_mean'] != null ? Number(r['base_mean']) : null,
      baselineStddev: r['base_sd'] != null ? Number(r['base_sd']) : null,
      baselineSamples: Number(r['base_n']),
      recentMean: r['recent_mean'] != null ? Number(r['recent_mean']) : null,
      recentSamples: Number(r['recent_n']),
    };

    // Latency anomaly
    if (
      stats.baselineSamples >= minSamples &&
      stats.recentSamples >= 3 &&
      stats.baselineMean != null &&
      stats.recentMean != null &&
      stats.baselineStddev != null &&
      stats.baselineStddev > 0
    ) {
      const zScore = (stats.recentMean - stats.baselineMean) / stats.baselineStddev;
      if (zScore >= z) {
        out.push({
          targetId: target.id,
          targetName: target.name,
          kind: 'latency',
          metric: 'response_time_ms (mean, last 1h)',
          baseline: Math.round(stats.baselineMean),
          observed: Math.round(stats.recentMean),
          zScore: Number(zScore.toFixed(2)),
          windowMinutes: 60,
          note: `Recent mean latency ${Math.round(stats.recentMean)}ms is ${zScore.toFixed(1)}σ above the ${days}-day baseline of ${Math.round(stats.baselineMean)}ms.`,
        });
      }
    }

    // Error-rate anomaly
    const recentDown = r['recent_down_rate'] != null ? Number(r['recent_down_rate']) : null;
    const baseDown = r['base_down_rate'] != null ? Number(r['base_down_rate']) : 0;
    if (
      recentDown != null &&
      stats.recentSamples >= 5 &&
      recentDown > 0.2 &&
      recentDown > baseDown + 0.15
    ) {
      out.push({
        targetId: target.id,
        targetName: target.name,
        kind: 'error_rate',
        metric: 'DOWN rate (last 1h)',
        baseline: Number((baseDown * 100).toFixed(1)),
        observed: Number((recentDown * 100).toFixed(1)),
        zScore: null,
        windowMinutes: 60,
        note: `${(recentDown * 100).toFixed(0)}% of recent checks failed, versus a ${(baseDown * 100).toFixed(0)}% baseline.`,
      });
    }
  }

  return out;
}

/** Runs detection and records new anomalies as advisory insights (de-duped). */
export async function scanAndRecordAnomalies(): Promise<number> {
  const anomalies = await detectAnomalies();
  let recorded = 0;
  for (const a of anomalies) {
    const kind: AiInsightKind = a.kind === 'latency' ? 'latency_anomaly' : 'error_rate_anomaly';
    if (await anomalyRecentlyRecorded(a.targetId, kind, 60)) continue;
    await saveInsight({
      entityType: 'target',
      entityId: a.targetId,
      kind,
      confidence: null,
      model: 'statistical',
      content: a,
    });
    recorded += 1;
    log.warn({ targetId: a.targetId, kind: a.kind, note: a.note }, 'anomaly recorded');
  }
  return recorded;
}
