import { createHash, randomBytes } from 'node:crypto';
import { NotFoundError } from '../../lib/errors.js';
import { decryptCredentials, encryptCredentials } from '../../lib/crypto/credential-cipher.js';
import { maskBody } from '../../lib/masking.js';
import { verifyWebhook, type WebhookEnvelope } from '../../loadtest/contract/ismartpay.js';
import { isCredentialEnvelope } from '../../lib/crypto/credential-cipher.js';
import * as repo from '../../repositories/load-test-webhooks.repo.js';
import { recordAudit, type AuditActor } from '../audit/audit.service.js';

/**
 * Webhook sink (B9). A public endpoint behaves like a CORRECT integration:
 * it verifies the signature over the raw body with the documented tolerance, answers
 * 401 to anything it cannot authenticate, and records every attempt — including the
 * bad ones — so duplicate delivery, retries and forgery can be inspected afterwards.
 */

/** Hard stop so a leaked URL cannot fill the table. */
export const MAX_DELIVERIES_PER_SINK = 20_000;
export const MAX_BODY_BYTES = 256 * 1024;

export interface IncomingHook {
  slug: string;
  rawBody: string;
  headers: {
    id: string | undefined;
    timestamp: string | undefined;
    signature: string | undefined;
  };
}

export async function createSink(
  input: { label: string; apiId: string | null },
  actor: AuditActor,
): Promise<repo.Sink> {
  const slug = randomBytes(24).toString('hex');
  const sink = await repo.createSink({
    apiId: input.apiId,
    label: input.label,
    slug,
    createdBy: actor.userId ?? null,
  });
  await recordAudit({
    actor,
    action: 'load_test.webhook_sink.created',
    entityType: 'load_test_webhook_sink',
    entityId: sink.id,
    summary: input.label,
  });
  return sink;
}

export async function setSinkSecret(
  id: string,
  secret: string,
  actor: AuditActor,
): Promise<repo.Sink> {
  if (!(await repo.getSink(id))) throw new NotFoundError('Webhook sink not found');
  await repo.setSecret(id, encryptCredentials({ secret }));
  await recordAudit({
    actor,
    action: 'load_test.webhook_sink.secret_set',
    entityType: 'load_test_webhook_sink',
    entityId: id,
    summary: 'signing secret set (value not logged)',
  });
  return (await repo.getSink(id))!;
}

export async function removeSink(id: string, actor: AuditActor): Promise<void> {
  if (!(await repo.deleteSink(id))) throw new NotFoundError('Webhook sink not found');
  await recordAudit({
    actor,
    action: 'load_test.webhook_sink.deleted',
    entityType: 'load_test_webhook_sink',
    entityId: id,
    summary: 'deleted with its deliveries',
  });
}

/** Returns the HTTP status to send back to the caller. Never throws on bad input. */
export async function receiveHook(h: IncomingHook): Promise<number> {
  const sink = await repo.findBySlug(h.slug);
  // Unknown or disabled: indistinguishable from "no such page".
  if (!sink || !sink.enabled) return 404;
  if (Buffer.byteLength(h.rawBody) > MAX_BODY_BYTES) return 413;
  if ((await repo.countDeliveries(sink.id)) >= MAX_DELIVERIES_PER_SINK) return 429;

  let secret: string | null = null;
  if (isCredentialEnvelope(sink.secret)) {
    secret = decryptCredentials(sink.secret)['secret'] ?? null;
  }

  let ok = false;
  let reason: string | null = null;
  if (!secret) {
    reason = 'no signing secret configured on this sink';
  } else {
    const v = verifyWebhook({ secret, ...h.headers, rawBody: h.rawBody });
    ok = v.ok;
    if (!v.ok) reason = v.reason;
  }

  let envelope: Partial<WebhookEnvelope> | null = null;
  try {
    envelope = JSON.parse(h.rawBody) as Partial<WebhookEnvelope>;
  } catch {
    envelope = null;
  }
  const eventId = h.headers.id ?? envelope?.id ?? '(none)';
  const data = envelope?.data;
  const reference = typeof data?.['reference'] === 'string' ? data['reference'] : null;
  // 503 (not 401) when we simply cannot verify yet, so the sender keeps retrying.
  const status = ok ? 200 : secret ? 401 : 503;

  await repo.insertDelivery({
    sinkId: sink.id,
    eventId,
    eventType: typeof envelope?.type === 'string' ? envelope.type : null,
    reference,
    attempt: (await repo.priorAttempts(sink.id, eventId)) + 1,
    signatureOk: ok,
    reason,
    bodySha256: createHash('sha256').update(h.rawBody).digest('hex'),
    bodyMasked: maskBody(h.rawBody, 8 * 1024),
    respondedWith: status,
  });
  return status;
}
