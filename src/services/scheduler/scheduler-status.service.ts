import { env } from '../../config/index.js';
import {
  latestHeartbeat,
  listJobRuns,
  listMissedRuns,
  totalMissedRuns,
  type CronJobRun,
  type LatestHeartbeat,
  type MissedRunSummary,
} from '../../repositories/scheduler.repo.js';

export type SchedulerHealth = 'ok' | 'stale' | 'not_running';

export interface SchedulerStatus {
  health: SchedulerHealth;
  heartbeat: LatestHeartbeat | null;
  graceMs: number;
  missedRunTotal: number;
}

export async function getSchedulerStatus(): Promise<SchedulerStatus> {
  const graceMs = env().SCHEDULER_HEARTBEAT_GRACE_MS;
  const [heartbeat, missedRunTotal] = await Promise.all([latestHeartbeat(), totalMissedRuns()]);

  let health: SchedulerHealth;
  if (!heartbeat) health = 'not_running';
  else if (heartbeat.ageMs > graceMs) health = 'stale';
  else health = 'ok';

  return { health, heartbeat, graceMs, missedRunTotal };
}

export function getJobRuns(filters: {
  targetId?: string;
  limit?: number;
  offset?: number;
}): Promise<CronJobRun[]> {
  return listJobRuns(filters);
}

export function getMissedRuns(): Promise<MissedRunSummary[]> {
  return listMissedRuns();
}
