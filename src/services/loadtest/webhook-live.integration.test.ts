import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDbHealth, closePool, query } from '../../lib/db.js';

const dbUp = (await checkDbHealth()).ok;

const { runSuite } = await import('../../loadtest/correctness/suite.js');
const { signWebhook } = await import('../../loadtest/contract/ismartpay.js');
const sinks = await import('./webhook-sink.service.js');
const repo = await import('../../repositories/load-test-webhooks.repo.js');

/**
 * A stand-in for the live iSmartPay sandbox: it accepts a collection, reports it settled,
 * and — like the real service — pushes a signed webhook to the receiver's public address.
 * The receiver, repository and live check under test are all the real code.
 */
const SECRET = 'whsec_live_check_secret';
let server: Server;
let base: string;
let slug = '';
let apiId = '';
let mode: 'good' | 'forged' | 'silent' | 'mismatched-id' = 'good';
const status = new Map<string, string>();

const deliver = async (id: string, body: string, secret: string): Promise<void> => {
  const ts = String(Math.floor(Date.now() / 1000));
  await sinks.receiveHook({
    slug,
    rawBody: body,
    headers: { id, timestamp: ts, signature: signWebhook(secret, id, ts, body) },
  });
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0]!;
      const send = (code: number, body: unknown): void => {
        res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      };
      if (url === '/v1/oauth/token') return send(200, { access_token: 'tok', expires_in: 300 });
      if (req.method === 'POST' && url === '/v1/collections') {
        const ref = (JSON.parse(Buffer.concat(chunks).toString()) as { reference: string })
          .reference;
        status.set(ref, 'settled');
        send(202, { reference: ref, status: 'accepted' });
        if (mode === 'silent') return;
        const id = `evt_${ref}`;
        const body = JSON.stringify({
          id: mode === 'mismatched-id' ? 'evt_other' : id,
          type: 'collection.settled',
          createdAt: new Date().toISOString(),
          data: { reference: ref, status: 'settled' },
        });
        setTimeout(() => {
          void deliver(id, body, mode === 'forged' ? 'not-the-secret-at-all' : SECRET);
          if (mode === 'good') void deliver(id, body, SECRET); // a retry of the same event
        }, 150);
        return;
      }
      const m = /^\/v1\/collections\/(.+)$/.exec(url);
      if (m) return send(200, { reference: m[1], status: status.get(m[1]!) ?? 'accepted' });
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  if (dbUp) {
    await query(`DELETE FROM load_test_webhook_sinks`);
    await query(`DELETE FROM monitored_apis WHERE name = 'lt-whlive'`);
    const { rows } = await query<{ id: string }>(
      `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron, environment, authentication_type)
       VALUES ('lt-whlive','internal','LOW','http://127.0.0.1:9','*/5 * * * *','sandbox','NONE') RETURNING id`,
    );
    apiId = rows[0]!.id;
    const sink = await sinks.createSink(
      { label: 'live check', apiId },
      { userId: null, label: 'test' },
    );
    slug = sink.slug;
    await sinks.setSinkSecret(sink.id, SECRET, { userId: null, label: 'test' });
  }
});
beforeEach(() => status.clear());
afterAll(async () => {
  await new Promise((r) => server.close(r));
  if (dbUp) {
    await query(`DELETE FROM load_test_webhook_sinks`);
    await query(`DELETE FROM monitored_apis WHERE name = 'lt-whlive'`);
    await closePool();
  }
});

async function runLive(waitMs: number) {
  const sink = await repo.findUsableSink(apiId);
  const probe = sink
    ? {
        label: sink.label,
        deliveriesFor: async (reference: string) =>
          (await repo.deliveriesForReference(sink.id, reference)) as never,
      }
    : undefined;
  return runSuite({
    client: { baseUrl: base, tokenUrl: `${base}/v1/oauth/token`, clientId: 'c', clientSecret: 's' },
    salt: `wh${Math.random().toString(36).slice(2, 7)}`,
    settleTimeoutMs: 5_000,
    liveWebhook: probe,
    liveWebhookWaitMs: waitMs,
    only: ['webhook.live-delivery'],
  });
}

describe.skipIf(!dbUp)('live webhook check against the real receiver', () => {
  it('passes when authentic webhooks arrive, and tolerates a retry of the same event', async () => {
    mode = 'good';
    const r = (await runLive(8_000)).results[0]!;
    expect(r.status, JSON.stringify(r.assertions)).toBe('PASS');
    expect(r.assertions.find((a) => a.name.startsWith('repeat deliveries'))?.pass).toBe(true);
  }, 60_000);

  it('fails when a delivery cannot be authenticated', async () => {
    mode = 'forged';
    const r = (await runLive(8_000)).results[0]!;
    // The forged webhook is recorded (unverified), so the check sees it and fails on the signature.
    expect(r.status).toBe('FAIL');
    expect(r.assertions.find((a) => a.name.includes('valid signature'))?.pass).toBe(false);
  }, 60_000);

  it('fails when the envelope id disagrees with the Webhook-Id header', async () => {
    mode = 'mismatched-id';
    const r = (await runLive(8_000)).results[0]!;
    expect(r.status).toBe('FAIL');
    expect(r.assertions.find((a) => a.name.startsWith('envelope id'))?.pass).toBe(false);
  }, 60_000);

  it('is skipped (not failed) with a clear reason when nothing arrives', async () => {
    mode = 'silent';
    const r = (await runLive(2_000)).results[0]!;
    expect(r.status).toBe('SKIPPED');
    expect(r.note).toMatch(/registered in the iSmart test console/);
  }, 60_000);

  it('is skipped when no usable receiver exists', async () => {
    mode = 'good';
    await query(`UPDATE load_test_webhook_sinks SET encrypted_secret = NULL`);
    const r = (await runLive(2_000)).results[0]!;
    expect(r.status).toBe('SKIPPED');
    expect(r.note).toMatch(/no webhook receiver/);
  }, 60_000);
});
