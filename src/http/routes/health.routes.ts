import { Router, type Request, type Response } from 'express';
import { checkDbHealth } from '../../lib/db.js';
import { checkRedisHealth } from '../../lib/redis.js';
import { appInfo } from '../../lib/version.js';

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
 * Scheduler-specific health. Populated in Phase 5 (cron engine) with last cron
 * tick time, active job count, queue depth, worker count and missed-run count.
 */
healthRouter.get('/health/scheduler', (_req: Request, res: Response) => {
  res.status(503).json({
    status: 'not_implemented',
    phase: 5,
    message: 'Scheduler health is reported once the cron engine lands (roadmap Phase 5).',
  });
});
