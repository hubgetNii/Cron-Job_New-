import { query } from '../lib/db.js';

type Row = Record<string, unknown>;

export interface Sink {
  id: string;
  apiId: string | null;
  label: string;
  slug: string;
  hasSecret: boolean;
  enabled: boolean;
  createdAt: string;
  deliveries: number;
  lastDeliveryAt: string | null;
}

export interface Delivery {
  id: number;
  sinkId: string;
  eventId: string;
  eventType: string | null;
  reference: string | null;
  attempt: number;
  signatureOk: boolean;
  reason: string | null;
  bodyMasked: string | null;
  respondedWith: number;
  receivedAt: string;
}

const toSink = (r: Row): Sink => ({
  id: r['id'] as string,
  apiId: (r['api_id'] as string | null) ?? null,
  label: r['label'] as string,
  slug: r['slug'] as string,
  hasSecret: r['encrypted_secret'] != null,
  enabled: r['enabled'] as boolean,
  createdAt: (r['created_at'] as Date).toISOString(),
  deliveries: Number(r['deliveries'] ?? 0),
  lastDeliveryAt: r['last_delivery_at'] ? (r['last_delivery_at'] as Date).toISOString() : null,
});

const SINK_SELECT = `SELECT s.*,
    (SELECT count(*) FROM load_test_webhook_deliveries d WHERE d.sink_id = s.id) AS deliveries,
    (SELECT max(received_at) FROM load_test_webhook_deliveries d WHERE d.sink_id = s.id) AS last_delivery_at
  FROM load_test_webhook_sinks s`;

export async function createSink(i: {
  apiId: string | null;
  label: string;
  slug: string;
  createdBy: string | null;
}): Promise<Sink> {
  const { rows } = await query<Row>(
    `INSERT INTO load_test_webhook_sinks (api_id, label, slug, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
    [i.apiId, i.label, i.slug, i.createdBy],
  );
  return (await getSink(rows[0]!['id'] as string))!;
}

export async function getSink(id: string): Promise<Sink | null> {
  const { rows } = await query<Row>(`${SINK_SELECT} WHERE s.id = $1`, [id]);
  return rows[0] ? toSink(rows[0]) : null;
}

export async function listSinks(): Promise<Sink[]> {
  const { rows } = await query<Row>(`${SINK_SELECT} ORDER BY s.created_at DESC`);
  return rows.map(toSink);
}

export async function setSecret(id: string, envelope: unknown): Promise<void> {
  await query(`UPDATE load_test_webhook_sinks SET encrypted_secret = $2 WHERE id = $1`, [
    id,
    JSON.stringify(envelope),
  ]);
}

export async function setEnabled(id: string, enabled: boolean): Promise<void> {
  await query(`UPDATE load_test_webhook_sinks SET enabled = $2 WHERE id = $1`, [id, enabled]);
}

export async function deleteSink(id: string): Promise<boolean> {
  const res = await query('DELETE FROM load_test_webhook_sinks WHERE id = $1', [id]);
  return (res.rowCount ?? 0) > 0;
}

/** For the public endpoint: the sink plus its secret envelope, by URL slug. */
export async function findBySlug(
  slug: string,
): Promise<{ id: string; enabled: boolean; secret: unknown } | null> {
  const { rows } = await query<Row>(
    `SELECT id, enabled, encrypted_secret FROM load_test_webhook_sinks WHERE slug = $1`,
    [slug],
  );
  const r = rows[0];
  return r
    ? { id: r['id'] as string, enabled: r['enabled'] as boolean, secret: r['encrypted_secret'] }
    : null;
}

export async function countDeliveries(sinkId: string): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*) AS n FROM load_test_webhook_deliveries WHERE sink_id = $1`,
    [sinkId],
  );
  return Number(rows[0]!.n);
}

export async function priorAttempts(sinkId: string, eventId: string): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*) AS n FROM load_test_webhook_deliveries WHERE sink_id = $1 AND event_id = $2`,
    [sinkId, eventId],
  );
  return Number(rows[0]!.n);
}

export async function insertDelivery(d: {
  sinkId: string;
  eventId: string;
  eventType: string | null;
  reference: string | null;
  attempt: number;
  signatureOk: boolean;
  reason: string | null;
  bodySha256: string;
  bodyMasked: string | null;
  respondedWith: number;
}): Promise<void> {
  await query(
    `INSERT INTO load_test_webhook_deliveries
       (sink_id, event_id, event_type, reference, attempt, signature_ok, reason, body_sha256, body_masked, responded_with)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      d.sinkId,
      d.eventId,
      d.eventType,
      d.reference,
      d.attempt,
      d.signatureOk,
      d.reason,
      d.bodySha256,
      d.bodyMasked,
      d.respondedWith,
    ],
  );
}

export async function listDeliveries(sinkId: string, limit: number): Promise<Delivery[]> {
  const { rows } = await query<Row>(
    `SELECT * FROM load_test_webhook_deliveries WHERE sink_id = $1 ORDER BY id DESC LIMIT $2`,
    [sinkId, limit],
  );
  return rows.map((r) => ({
    id: Number(r['id']),
    sinkId: r['sink_id'] as string,
    eventId: r['event_id'] as string,
    eventType: (r['event_type'] as string | null) ?? null,
    reference: (r['reference'] as string | null) ?? null,
    attempt: r['attempt'] as number,
    signatureOk: r['signature_ok'] as boolean,
    reason: (r['reason'] as string | null) ?? null,
    bodyMasked: (r['body_masked'] as string | null) ?? null,
    respondedWith: r['responded_with'] as number,
    receivedAt: (r['received_at'] as Date).toISOString(),
  }));
}
