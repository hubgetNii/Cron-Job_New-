import 'dotenv/config';

export { env, loadEnv, resetEnvCache, type Env } from './env.js';

export const isProduction = (): boolean => process.env['NODE_ENV'] === 'production';
export const isTest = (): boolean => process.env['NODE_ENV'] === 'test';
