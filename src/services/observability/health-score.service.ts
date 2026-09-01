import { env } from '../../config/index.js';
import { query } from '../../lib/db.js';
import { NotFoundError } from '../../lib/errors.js';
import { findTargetById, listActiveTargets } from '../../repositories/monitored-apis.repo.js';
import { getThresholds } from '../../repositories/latency-thresholds.repo.js';
import { computeSla } from '../reporting/sla.service.js';
import { resolveThresholds } from '../../domain/latency.js';
import {
  availabilitySubScore,
  computeHealthScore,
  dependencySubScore,
  errorRateSubScore,
  latencySubScore,
  parseWeights,
  type HealthScoreResult,
} from '../../domain/health-score.js';

export interface HealthScore extends HealthScoreResult {
  apiId: string;
  targetName: string;
  window: { hours: number; samples: number };
  subScores: {
    availability: number | null;
    latency: number | null;
    errorRate: number | null;
    dependencyHealth: number | null;
  };
  comparison: {
    latency: { currentP95: number | null; yesterdayP95: number | null; deltaPercent: number | null };
    errorRate: {
      recentPct: number | null;
      priorPct: number | null;
      note: string | null;
    };
    recurrence: { count24h: number; note: string | null };
  };
}

interface WindowRow {
  samples: string;
  down: string;
  p95: string | null;
}

async function windowRow(apiId: string, from: Date, to: Date): Promise<WindowRow> {
  const { rows } = await query<WindowRow>(
    `SELECT
       count(*)::text AS samples,
       count(*) FILTER (WHERE status = 'DOWN')::text AS down,
       percentile_cont(0.95) WITHIN GROUP (
         ORDER BY response_time_ms
       ) FILTER (WHERE response_time_ms IS NOT NULL AND status IN ('UP','DEGRADED'))::text AS p95
     FROM health_check_results
     WHERE api_id = $1 AND checked_at >= $2 AND checked_at < $3`,
    [apiId, from, to],
  );
  return rows[0]!;
}

async function dependencyInputs(apiId: string): Promise<{
  openIncident: boolean;
  openIncidentCategory: string | null;
  dependencyIncidents24h: number;
  flapping24h: number;
}> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT
       (SELECT status FROM incidents WHERE api_id = $1 AND status <> 'RESOLVED' LIMIT 1) AS open_status,
       (SELECT rca ->> 'category' FROM incidents WHERE api_id = $1 AND status <> 'RESOLVED' LIMIT 1) AS open_cat,
       (SELECT count(*) FROM incidents
          WHERE api_id = $1 AND started_at > now() - interval '24 hours'
            AND rca ->> 'category' IN ('DEPENDENCY','DATABASE'))::int AS dep_24h,
       (SELECT count(*) FROM incidents
          WHERE api_id = $1 AND incident_type = 'FLAPPING'
            AND started_at > now() - interval '24 hours')::int AS flap_24h`,
    [apiId],
  );
  const r = rows[0]!;
  return {
    openIncident: r['open_status'] != null,
    openIncidentCategory: (r['open_cat'] as string | null) ?? null,
    dependencyIncidents24h: Number(r['dep_24h'] ?? 0),
    flapping24h: Number(r['flap_24h'] ?? 0),
  };
}

async function recurrence(apiId: string): Promise<{ count24h: number; note: string | null }> {
  const { rows } = await query<{ n: string; ft: string | null }>(
    `SELECT count(*)::text AS n,
            (SELECT failure_type::text FROM incidents
             WHERE api_id = $1 AND started_at > now() - interval '24 hours'
             ORDER BY started_at DESC LIMIT 1) AS ft
     FROM incidents
     WHERE api_id = $1 AND started_at > now() - interval '24 hours'`,
    [apiId],
  );
  const n = Number(rows[0]?.n ?? '0');
  const ft = rows[0]?.ft;
  return {
    count24h: n,
    note: n >= 2 ? `${ordinal(n)} incident${ft ? ` (${ft})` : ''} in the last 24h` : null,
  };
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]!}`;
}

function pct(down: number, total: number): number | null {
  return total === 0 ? null : Number(((down / total) * 100).toFixed(2));
}

/** Full health score + historical comparison for one service (spec §10–11). */
export async function serviceHealthScore(
  apiId: string,
  windowHours = env().HEALTH_SCORE_WINDOW_HOURS,
): Promise<HealthScore> {
  const target = await findTargetById(apiId);
  if (!target) throw new NotFoundError(`Target ${apiId} not found`);
  const weights = parseWeights(env().HEALTH_SCORE_WEIGHTS);

  const now = new Date();
  const from = new Date(now.getTime() - windowHours * 3_600_000);
  const dayAgoFrom = new Date(from.getTime() - 86_400_000);
  const dayAgoTo = new Date(now.getTime() - 86_400_000);
  const recent2hFrom = new Date(now.getTime() - 2 * 3_600_000);
  const prior2hFrom = new Date(now.getTime() - 4 * 3_600_000);

  const [sla, w, yesterday, recent2h, prior2h, deps, rec, custom] = await Promise.all([
    computeSla(apiId, from, now, target.slaTargetPercent),
    windowRow(apiId, from, now),
    windowRow(apiId, dayAgoFrom, dayAgoTo),
    windowRow(apiId, recent2hFrom, now),
    windowRow(apiId, prior2hFrom, recent2hFrom),
    dependencyInputs(apiId),
    recurrence(apiId),
    getThresholds(apiId),
  ]);

  const { thresholds } = resolveThresholds(target.endpointClass, custom);
  const samples = Number(w.samples);
  const currentP95 = w.p95 == null ? null : Math.round(Number(w.p95));
  const yesterdayP95 = yesterday.p95 == null ? null : Math.round(Number(yesterday.p95));
  const errorPct = pct(Number(w.down), samples);

  const subScores = {
    availability: availabilitySubScore(sla.uptimePercent),
    latency: latencySubScore(currentP95, thresholds.normalMs, thresholds.criticalMs),
    errorRate: errorRateSubScore(errorPct),
    dependencyHealth: dependencySubScore(deps),
  };

  const base = computeHealthScore(subScores, weights);

  const deltaPercent =
    currentP95 != null && yesterdayP95 != null && yesterdayP95 > 0
      ? Number((((currentP95 - yesterdayP95) / yesterdayP95) * 100).toFixed(1))
      : null;

  const recentPct = pct(Number(recent2h.down), Number(recent2h.samples));
  const priorPct = pct(Number(prior2h.down), Number(prior2h.samples));
  const errNote =
    recentPct != null && priorPct != null && recentPct - priorPct >= 2
      ? `Failure rate rose from ${priorPct}% to ${recentPct}% over the last 2h`
      : recentPct != null && priorPct != null && priorPct - recentPct >= 2
        ? `Failure rate fell from ${priorPct}% to ${recentPct}% over the last 2h`
        : null;

  return {
    ...base,
    apiId,
    targetName: target.name,
    window: { hours: windowHours, samples },
    subScores,
    comparison: {
      latency: { currentP95, yesterdayP95, deltaPercent },
      errorRate: { recentPct, priorPct, note: errNote },
      recurrence: rec,
    },
  };
}

/** Health score for every active target, worst first. */
export async function allHealthScores(
  windowHours = env().HEALTH_SCORE_WINDOW_HOURS,
): Promise<HealthScore[]> {
  const targets = await listActiveTargets();
  const scores = await Promise.all(targets.map((t) => serviceHealthScore(t.id, windowHours)));
  return scores.sort((a, b) => (a.score ?? 101) - (b.score ?? 101));
}
