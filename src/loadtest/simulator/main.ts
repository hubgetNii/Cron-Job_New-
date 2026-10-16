import 'dotenv/config';
import { createSimulatorApp } from './app.js';

/**
 * Starts the iSmartPay simulator on loopback only (control plane included, so
 * it must never be reachable from outside the host). `SIM_PORT` defaults to 4010.
 *
 *   npm run simulator
 *   curl -s localhost:4010/__sim/health
 */
const port = Number(process.env['SIM_PORT'] ?? 4010);
const host = process.env['SIM_HOST'] ?? '127.0.0.1';
if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
  throw new Error('The simulator control plane must bind to loopback; refusing SIM_HOST=' + host);
}

const { app } = createSimulatorApp();
app.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`iSmartPay simulator listening on http://${host}:${port}`);
});
