import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyWebhook, type WebhookEnvelope, type WebhookVerdict } from '../contract/ismartpay.js';

export interface Delivery {
  at: number;
  id: string;
  timestamp: string;
  signature: string;
  rawBody: string;
  verdict: WebhookVerdict;
  envelope: WebhookEnvelope | null;
  /** 1-based attempt number for this event id, as seen by the receiver. */
  attempt: number;
  respondedWith: number;
}

/**
 * A webhook endpoint that behaves like a correct integration: it verifies the
 * signature over the RAW body, enforces the timestamp tolerance, rejects bad
 * deliveries with 401, and exposes everything it saw so checks can assert on
 * duplicates, ordering and retries.
 */
export class WebhookReceiver {
  readonly deliveries: Delivery[] = [];
  private server: Server | null = null;
  private attempts = new Map<string, number>();

  constructor(
    private readonly secret: string,
    /** Return a non-2xx status to simulate our endpoint failing for this attempt. */
    private readonly failWith: (id: string, attempt: number) => number | null = () => null,
  ) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const h = (n: string): string | undefined => {
          const v = req.headers[n];
          return Array.isArray(v) ? v[0] : v;
        };
        const id = h('webhook-id') ?? '';
        const verdict = verifyWebhook({
          secret: this.secret,
          id: h('webhook-id'),
          timestamp: h('webhook-timestamp'),
          signature: h('webhook-signature'),
          rawBody: raw,
        });
        const attempt = (this.attempts.get(id) ?? 0) + 1;
        this.attempts.set(id, attempt);
        let envelope: WebhookEnvelope | null = null;
        try {
          envelope = JSON.parse(raw) as WebhookEnvelope;
        } catch {
          envelope = null;
        }
        const forced = verdict.ok ? this.failWith(id, attempt) : null;
        const status = !verdict.ok ? 401 : (forced ?? 200);
        this.deliveries.push({
          at: Date.now(),
          id,
          timestamp: h('webhook-timestamp') ?? '',
          signature: h('webhook-signature') ?? '',
          rawBody: raw,
          verdict,
          envelope,
          attempt,
          respondedWith: status,
        });
        res.writeHead(status).end();
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/webhook`;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise((r) => s.close(r));
  }

  /** Distinct events by Webhook-Id — what a correct receiver stores after de-duplication. */
  uniqueEvents(): WebhookEnvelope[] {
    const seen = new Map<string, WebhookEnvelope>();
    for (const d of this.deliveries)
      if (d.verdict.ok && d.envelope && !seen.has(d.id)) seen.set(d.id, d.envelope);
    return [...seen.values()];
  }
}
