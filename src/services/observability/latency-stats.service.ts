import { env } from '../../config/index.js';
import { query } from '../../lib/db.js';
import { NotFoundError } from '../../lib/errors.js';
import { findTargetById, listActiveTargets } from '../../repositories/monitored-apis.repo.js';
import { allThresholds, getThresholds } from '../../repositories/latency-thresholds.repo.js';
import {
  assessLatency,
  deviationPercent,
  resolveThresholds,
  type LatencyAssessment,
  type LatencyThresholds,
} from '../../domain/latency.js';
import type { EndpointClass } from '../../domain/enums.js';

export interface LatencyStats {
  apiId: string;
  targetName: string;
  endpointClass: EndpointClass;
  window: { minutes: number; samples: number };
  current: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  baseline: { days: number; avgMs: number | null };
  /** % the current response time sits above the baseline average. */
  deviationPercent: number | null;
  thresholds: LatencyThresholds & { source: 'custom' | 'default' };
  assessment: LatencyAssessment;
}

interface WindowStatsRow {
  samples: string;
  current: string | null;
  avg: string | null;
  min: string | null;
  max: string | null;
  p50: string | null;
  p90: string | null;
  p95: string | null;
  p99: string | null;
}

const num = (v: string | null): number | null => (v == null ? null : Math.round(Number(v)));

async function windowStats(apiId: string, minutes: number): Promise<WindowStatsRow> {
  const { rows } = await query<WindowStatsRow>(
    `WITH w AS (
       SELECT response_time_ms::float AS ms, checked_at
       FROM health_check_results
       WHERE api_id = $1
         AND response_time_ms IS NOT NULL
         AND status IN ('UP','DEGRADED')
         AND checked_at > now() - ($2::int * interval '1 minute')
     )
     SELECT
       count(*)::text AS samples,
       (SELECT ms::text FROM w ORDER BY checked_at DESC LIMIT 1) AS current,
       avg(ms)::text AS avg,
       min(ms)::text AS min,
       max(ms)::text AS max,
       percentile_cont(0.5)  WITHIN GROUP (ORDER BY ms)::text AS p50,
       percentile_cont(0.9)  WITHIN GROUP (ORDER BY ms)::text AS p90,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY ms)::text AS p95,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY ms)::text AS p99
     FROM w`,
    [apiId, minutes],
  );
  return rows[0]!;
}

async function baselineAvg(apiId: string, days: number, excludeMinutes: number): Promise<number | null> {
  const { rows } = await query<{ avg: string | null }>(
    `SELECT avg(response_time_ms)::text AS avg
     FROM health_check_results
     WHERE api_id = $1
       AND response_time_ms IS NOT NULL
       AND status IN ('UP','DEGRADED')
       AND checked_at BETWEEN now() - ($2::int * interval '1 day')
                          AND now() - ($3::int * interval '1 minute')`,
    [apiId, days, excludeMinutes],
  );
  return num(rows[0]?.avg ?? null);
}

function build(
  apiId: string,
  targetName: string,
  endpointClass: EndpointClass,
  minutes: number,
  w: WindowStatsRow,
  baselineDays: number,
  baseMs: number | null,
  custom: LatencyThresholds | null,
): LatencyStats {
  const { thresholds, source } = resolveThresholds(endpointClass, custom);
  const p95 = num(w.p95);
  const current = num(w.current);
  return {
    apiId,
    targetName,
    endpointClass,
    window: { minutes, samples: Number(w.samples) },
    current,
    avg: num(w.avg),
    min: num(w.min),
    max: num(w.max),
    p50: num(w.p50),
    p90: num(w.p90),
    p95,
    p99: num(w.p99),
    baseline: { days: baselineDays, avgMs: baseMs },
    deviationPercent: deviationPercent(current, baseMs),
    thresholds: { ...thresholds, source },
    assessment: assessLatency(p95, thresholds),
  };
}

/** Latency intelligence for one target (spec §6). */
export async function latencyStats(
  apiId: string,
  windowMinutes = env().LATENCY_WINDOW_MINUTES,
): Promise<LatencyStats> {
  const target = await findTargetById(apiId);
  if (!target) throw new NotFoundError(`Target ${apiId} not found`);
  const baselineDays = env().LATENCY_BASELINE_DAYS;
  const [w, baseMs, custom] = await Promise.all([
    windowStats(apiId, windowMinutes),
    baselineAvg(apiId, baselineDays, windowMinutes),
    getThresholds(apiId),
  ]);
  return build(
    apiId,
    target.name,
    target.endpointClass,
    windowMinutes,
    w,
    baselineDays,
    baseMs,
    custom,
  );
}

/** Latency intelligence for every active target, worst assessment first. */
export async function allLatencyStats(
  windowMinutes = env().LATENCY_WINDOW_MINUTES,
): Promise<LatencyStats[]> {
  const targets = await listActiveTargets();
  const baselineDays = env().LATENCY_BASELINE_DAYS;
  const customMap = await allThresholds();
  const out = await Promise.all(
    targets.map(async (t) => {
      const [w, baseMs] = await Promise.all([
        windowStats(t.id, windowMinutes),
        baselineAvg(t.id, baselineDays, windowMinutes),
      ]);
      return build(
        t.id,
        t.name,
        t.endpointClass,
        windowMinutes,
        w,
        baselineDays,
        baseMs,
        customMap.get(t.id) ?? null,
      );
    }),
  );
  const rank: Record<LatencyAssessment, number> = {
    CRITICAL: 0,
    HIGH: 1,
    ELEVATED: 2,
    NORMAL: 3,
    NO_DATA: 4,
  };
  return out.sort(
    (a, b) => rank[a.assessment] - rank[b.assessment] || (b.p95 ?? 0) - (a.p95 ?? 0),
  );
}
