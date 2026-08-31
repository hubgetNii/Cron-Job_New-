import { query } from '../lib/db.js';

export type ContactChannel = 'EMAIL' | 'SMS';

export interface NotificationContact {
  id: string;
  name: string | null;
  channel: ContactChannel;
  address: string;
  digest: boolean;
  digestEveryRun: boolean;
  incidentAlerts: boolean;
  isActive: boolean;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = `
  id, name, channel, address, digest, digest_every_run, incident_alerts, is_active,
  note, created_at, updated_at`;

function toDomain(r: Record<string, unknown>): NotificationContact {
  return {
    id: r['id'] as string,
    name: (r['name'] as string | null) ?? null,
    channel: r['channel'] as ContactChannel,
    address: r['address'] as string,
    digest: r['digest'] as boolean,
    digestEveryRun: r['digest_every_run'] as boolean,
    incidentAlerts: r['incident_alerts'] as boolean,
    isActive: r['is_active'] as boolean,
    note: (r['note'] as string | null) ?? null,
    createdAt: r['created_at'] as Date,
    updatedAt: r['updated_at'] as Date,
  };
}

export async function listContacts(includeInactive = true): Promise<NotificationContact[]> {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM notification_contacts
     ${includeInactive ? '' : 'WHERE is_active'}
     ORDER BY channel, address`,
  );
  return (rows as Array<Record<string, unknown>>).map(toDomain);
}

/** Active contacts on a channel that want the digest. */
export async function digestContacts(channel: ContactChannel): Promise<NotificationContact[]> {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM notification_contacts
     WHERE is_active AND digest AND channel = $1 ORDER BY address`,
    [channel],
  );
  return (rows as Array<Record<string, unknown>>).map(toDomain);
}

export async function getContact(id: string): Promise<NotificationContact | null> {
  const { rows } = await query(`SELECT ${COLUMNS} FROM notification_contacts WHERE id = $1`, [id]);
  return rows[0] ? toDomain(rows[0]) : null;
}

export interface ContactInput {
  name?: string | null;
  channel: ContactChannel;
  address: string;
  digest?: boolean;
  digestEveryRun?: boolean;
  incidentAlerts?: boolean;
  isActive?: boolean;
  note?: string | null;
}

/** Insert, or update the flags if (channel, address) already exists. */
export async function upsertContact(input: ContactInput): Promise<NotificationContact> {
  const { rows } = await query(
    `INSERT INTO notification_contacts
       (name, channel, address, digest, digest_every_run, incident_alerts, is_active, note)
     VALUES ($1, $2, $3, COALESCE($4, true), COALESCE($5, false), COALESCE($6, false),
             COALESCE($7, true), $8)
     ON CONFLICT ON CONSTRAINT notification_contacts_channel_address_unique
     DO UPDATE SET
       name = COALESCE(EXCLUDED.name, notification_contacts.name),
       digest = EXCLUDED.digest,
       digest_every_run = EXCLUDED.digest_every_run,
       incident_alerts = EXCLUDED.incident_alerts,
       is_active = EXCLUDED.is_active,
       note = COALESCE(EXCLUDED.note, notification_contacts.note)
     RETURNING ${COLUMNS}`,
    [
      input.name ?? null,
      input.channel,
      input.address.trim(),
      input.digest ?? null,
      input.digestEveryRun ?? null,
      input.incidentAlerts ?? null,
      input.isActive ?? null,
      input.note ?? null,
    ],
  );
  return toDomain(rows[0] as Record<string, unknown>);
}

export async function updateContact(
  id: string,
  patch: Partial<Omit<ContactInput, 'channel' | 'address'>>,
): Promise<NotificationContact | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const col: Record<string, string> = {
    name: 'name',
    digest: 'digest',
    digestEveryRun: 'digest_every_run',
    incidentAlerts: 'incident_alerts',
    isActive: 'is_active',
    note: 'note',
  };
  for (const [key, dbcol] of Object.entries(col)) {
    const v = (patch as Record<string, unknown>)[key];
    if (v !== undefined) {
      params.push(v);
      sets.push(`${dbcol} = $${params.length}`);
    }
  }
  if (sets.length === 0) return getContact(id);
  const { rows } = await query(
    `UPDATE notification_contacts SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLUMNS}`,
    params,
  );
  return rows[0] ? toDomain(rows[0]) : null;
}

export async function deleteContact(id: string): Promise<boolean> {
  const { rowCount } = await query(`DELETE FROM notification_contacts WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}
