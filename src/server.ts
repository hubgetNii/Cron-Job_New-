import 'dotenv/config';
import { createApp } from './http/app.js';
import { env } from './config/index.js';
import { componentLogger } from './lib/logger.js';
import { closePool } from './lib/db.js';
import { closeRedis } from './lib/redis.js';
import { installShutdownHandlers, onShutdown } from './lib/shutdown.js';
import { appInfo } from './lib/version.js';
import { bootstrapAdmin } from './services/auth/auth.service.js';

const log = componentLogger('server');

function main(): void {
  const { PORT, NODE_ENV, AUTH_ENABLED } = env();
  const app = createApp();

  const server = app.listen(PORT, () => {
    log.info(
      { ...appInfo(), port: PORT, env: NODE_ENV, authEnabled: AUTH_ENABLED },
      'API server listening',
    );
    if (AUTH_ENABLED) {
      void bootstrapAdmin().catch((err: unknown) => log.error({ err }, 'admin bootstrap failed'));
    }
  });

  installShutdownHandlers();
  onShutdown(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });
  onShutdown(closePool);
  onShutdown(closeRedis);
}

try {
  main();
} catch (err) {
  log.fatal({ err }, 'failed to start API server');
  process.exit(1);
}
