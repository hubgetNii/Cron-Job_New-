import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { appInfo } from '../lib/version.js';
import { requestContext } from './middleware/request-context.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { authenticate } from './middleware/auth.js';
import { apiRateLimit } from './middleware/rate-limit.js';
import { healthRouter } from './routes/health.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { targetRouter } from './routes/target.routes.js';
import { schedulerRouter } from './routes/scheduler.routes.js';
import { incidentRouter } from './routes/incident.routes.js';
import { alertRouter } from './routes/alert.routes.js';
import { dashboardRouter } from './routes/dashboard.routes.js';
import { configRequestRouter } from './routes/config-request.routes.js';
import { statusRouter } from './routes/status.routes.js';
import { aiRouter } from './routes/ai.routes.js';
import { slaRouter } from './routes/sla.routes.js';

/**
 * Builds the Express application. Kept free of `listen()` so tests can drive it
 * with supertest without binding a port.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
        },
      },
      hsts: { maxAge: 31_536_000, includeSubDomains: true },
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(requestContext);

  if (env().ENABLE_REQUEST_LOGGING) {
    app.use(
      pinoHttp({
        logger,
        genReqId: (req) => (req as Request).requestId,
        autoLogging: {
          ignore: (req) => req.url === '/live' || req.url === '/ready',
        },
      }),
    );
  }

  app.get('/', (_req: Request, res: Response) => {
    res.json({ ...appInfo(), status: 'running' });
  });

  // Ops + public endpoints — no auth.
  app.use(healthRouter);
  app.use('/api/v1', statusRouter);
  app.use('/api/v1', authRouter);

  // Authenticated API surface.
  const api = express.Router();
  api.use(apiRateLimit());
  api.use(authenticate);
  api.use(targetRouter);
  api.use(configRequestRouter);
  api.use(schedulerRouter);
  api.use(incidentRouter);
  api.use(alertRouter);
  api.use(dashboardRouter);
  api.use(aiRouter);
  api.use(slaRouter);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
