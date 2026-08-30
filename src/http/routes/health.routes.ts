import { Router, type Request, type Response } from 'express';
import { checkDbHealth } from '../../lib/db.js';
import { checkRedisHealth } from '../../lib/redis.js';
import { appInfo } from '../../lib/version.js';
import { getSchedulerStatus } from '../../services/scheduler/scheduler-status.service.js';

export const healthRouter: Router = Router();

const startedAt = Date.now();

function uptimeSeconds(): number {
  return Math.round((Date.now() - startedAt) / 1000);
}

/** Liveness probe: is the process running at all? Never touches dependencies. */
healthRouter.get('/live', (_req: Request, res: Response) => {
  res.json({ status: 'alive', uptimeSeconds: uptimeSeconds() });
});

/** Readiness probe: are downstream dependencies reachable? */
healthRouter.get('/ready', async (_req: Request, res: Response) => {
  const [db, redis] = await Promise.all([checkDbHealth(), checkRedisHealth()]);
  const ready = db.ok && redis.ok;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    checks: { database: db.ok, redis: redis.ok },
  });
});

/** Detailed health snapshot for dashboards and humans. */
healthRouter.get('/health', async (_req: Request, res: Response) => {
  const [db, redis] = await Promise.all([checkDbHealth(), checkRedisHealth()]);
  const ok = db.ok && redis.ok;
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    ...appInfo(),
    uptimeSeconds: uptimeSeconds(),
    components: {
      database: db,
      redis: redis,
    },
  });
});

/**
 * Scheduler-specific health: last cron tick, its age, active jobs, queue depth
 * and the cumulative missed-run count (see vault: "Observability and
 * Meta-Monitoring"). Served from the database so the API process reports on a
 * scheduler running in a separate container.
 */
healthRouter.get('/health/scheduler', async (_req: Request, res: Response) => {
  const status = await getSchedulerStatus();
  res.status(status.health === 'ok' ? 200 : 503).json({
    status: status.health,
    lastTickAt: status.heartbeat?.lastTickAt ?? null,
    lastTickAgeMs: status.heartbeat?.ageMs ?? null,
    graceMs: status.graceMs,
    activeJobCount: status.heartbeat?.activeJobCount ?? null,
    queueDepth: status.heartbeat?.queueDepth ?? null,
    instanceId: status.heartbeat?.instanceId ?? null,
    missedRunTotal: status.missedRunTotal,
  });
});
