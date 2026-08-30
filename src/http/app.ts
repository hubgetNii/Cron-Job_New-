import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { appInfo } from '../lib/version.js';
import { requestContext } from './middleware/request-context.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { healthRouter } from './routes/health.routes.js';
import { targetRouter } from './routes/target.routes.js';
import { schedulerRouter } from './routes/scheduler.routes.js';
import { incidentRouter } from './routes/incident.routes.js';
import { alertRouter } from './routes/alert.routes.js';

/**
 * Builds the Express application. Kept free of `listen()` so tests can drive it
 * with supertest without binding a port.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(helmet());
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

  // Ops endpoints are mounted at the root (see vault: "API Design").
  app.use(healthRouter);

  // API surface, added phase by phase under /api/v1.
  const api = express.Router();
  api.use(targetRouter);
  api.use(schedulerRouter);
  api.use(incidentRouter);
  api.use(alertRouter);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
