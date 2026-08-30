import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCheck } from './executor.service.js';
import { makeMonitoredApi } from '../../tests/fixtures.js';

type Handler = (
  path: string,
  requestNo: number,
) => {
  status?: number;
  body?: string;
  delayMs?: number;
  headers?: Record<string, string>;
};

let server: Server;
let baseUrl: string;
let handler: Handler = () => ({ status: 200, body: '{"ok":true}' });
let requestCount = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    requestCount += 1;
    const r = handler(req.url ?? '/', requestCount);
    const send = (): void => {
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...r.headers });
      res.end(r.body ?? '');
    };
    if (r.delayMs) setTimeout(send, r.delayMs);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no server address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function setHandler(h: Handler): void {
  handler = h;
  requestCount = 0;
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('executeCheck', () => {
  it('returns UP when status and validation pass', async () => {
    setHandler(() => ({ status: 200, body: '{"data":{"status":"SUCCESS"}}' }));
    const target = makeMonitoredApi({
      url: `${baseUrl}/status`,
      expectedStatus: 200,
      expectedResponse: { type: 'json_equals', path: 'data.status', equals: 'SUCCESS' },
    });
    const outcome = await executeCheck(target, { credentials: null, sleep: noSleep });
    expect(outcome.status).toBe('UP');
    expect(outcome.attempts).toBe(1);
    expect(outcome.httpStatus).toBe(200);
    expect(outcome.validation?.passed).toBe(true);
  });

  it('returns DOWN with VALIDATION_ERROR when the body is wrong (no retry)', async () => {
    setHandler(() => ({ status: 200, body: '{"data":{"status":"FAILED"}}' }));
    const target = makeMonitoredApi({
      url: `${baseUrl}/status`,
      expectedResponse: { type: 'json_equals', path: 'data.status', equals: 'SUCCESS' },
    });
    const outcome = await executeCheck(target, { credentials: null, sleep: noSleep });
    expect(outcome.status).toBe('DOWN');
    expect(outcome.failureType).toBe('VALIDATION_ERROR');
    expect(outcome.attempts).toBe(1);
  });

  it('retries a 503 and recovers', async () => {
    setHandler((_p, n) =>
      n < 3
        ? { status: 503, body: 'nope' }
        : { status: 200, body: '{"data":{"status":"SUCCESS"}}' },
    );
    const target = makeMonitoredApi({
      url: `${baseUrl}/flaky`,
      expectedResponse: { type: 'json_equals', path: 'data.status', equals: 'SUCCESS' },
    });
    const outcome = await executeCheck(target, { credentials: null, sleep: noSleep });
    expect(outcome.status).toBe('UP');
    expect(outcome.attempts).toBe(3);
  });

  it('exhausts retries on a persistent 503', async () => {
    setHandler(() => ({ status: 503, body: 'down' }));
    const target = makeMonitoredApi({ url: `${baseUrl}/down` });
    const outcome = await executeCheck(target, { credentials: null, sleep: noSleep });
    expect(outcome.status).toBe('DOWN');
    expect(outcome.failureType).toBe('HTTP_5XX');
    expect(outcome.attempts).toBe(3);
  });

  it('does not retry a 404', async () => {
    setHandler(() => ({ status: 404, body: 'missing' }));
    const target = makeMonitoredApi({ url: `${baseUrl}/missing` });
    const outcome = await executeCheck(target, { credentials: null, sleep: noSleep });
    expect(outcome.status).toBe('DOWN');
    expect(outcome.failureType).toBe('HTTP_4XX');
    expect(outcome.attempts).toBe(1);
  });

  it('classifies a timeout and retries it', async () => {
    setHandler(() => ({ status: 200, body: 'slow', delayMs: 400 }));
    const target = makeMonitoredApi({ url: `${baseUrl}/slow`, timeoutMs: 80 });
    const outcome = await executeCheck(target, { credentials: null, sleep: noSleep });
    expect(outcome.status).toBe('DOWN');
    expect(outcome.failureType).toBe('TIMEOUT');
    expect(outcome.attempts).toBe(3);
  });

  it('treats HTTP 429 as UNKNOWN, not a hard DOWN', async () => {
    setHandler(() => ({ status: 429, body: 'slow down' }));
    const target = makeMonitoredApi({ url: `${baseUrl}/limited` });
    const outcome = await executeCheck(target, { credentials: null, sleep: noSleep });
    expect(outcome.status).toBe('UNKNOWN');
    expect(outcome.failureType).toBe('RATE_LIMITED');
  });

  it('flags DEGRADED when latency is near the timeout', async () => {
    setHandler(() => ({ status: 200, body: '{"ok":true}', delayMs: 900 }));
    const target = makeMonitoredApi({
      url: `${baseUrl}/degraded`,
      timeoutMs: 1000,
      retry: { count: 0, baseDelayMs: 0, backoffMultiplier: 2, maxDelayMs: 0 },
    });
    const outcome = await executeCheck(target, { credentials: null, sleep: noSleep });
    expect(outcome.status).toBe('DEGRADED');
  });

  it('blocks a private URL without the override', async () => {
    const target = makeMonitoredApi({ url: `${baseUrl}/x`, allowPrivateNetwork: false });
    const outcome = await executeCheck(target, { credentials: null, sleep: noSleep });
    expect(outcome.status).toBe('UNKNOWN');
    expect(outcome.errorMessage).toMatch(/SSRF/i);
  });
});
