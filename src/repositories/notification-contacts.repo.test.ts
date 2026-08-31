import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDbHealth, closePool, query } from '../lib/db.js';
import {
  deleteContact,
  digestContacts,
  listContacts,
  updateContact,
  upsertContact,
} from './notification-contacts.repo.js';

const dbUp = (await checkDbHealth()).ok;

describe.skipIf(!dbUp)('notification-contacts repo', () => {
  beforeEach(async () => {
    await query(`DELETE FROM notification_contacts`);
  });
  afterAll(async () => {
    await query(`DELETE FROM notification_contacts`);
    await closePool();
  });

  it('upserts and updates flags on the same (channel, address)', async () => {
    const a = await upsertContact({ channel: 'SMS', address: '233553476530', name: 'A' });
    expect(a.digest).toBe(true);
    expect(a.digestEveryRun).toBe(false);

    const b = await upsertContact({
      channel: 'SMS',
      address: '233553476530',
      digestEveryRun: true,
      incidentAlerts: true,
    });
    expect(b.id).toBe(a.id);
    expect(b.digestEveryRun).toBe(true);
    expect(b.incidentAlerts).toBe(true);
    expect(b.name).toBe('A'); // preserved

    expect(await listContacts()).toHaveLength(1);
  });

  it('digestContacts returns only active + digest on the channel', async () => {
    await upsertContact({ channel: 'SMS', address: '233553476530' });
    await upsertContact({ channel: 'SMS', address: '233272900200', digest: false });
    await upsertContact({
      channel: 'EMAIL',
      address: 'ibrahim@ismartghana.com',
      digestEveryRun: true,
    });
    await upsertContact({ channel: 'SMS', address: '233000000000', isActive: false });

    const sms = await digestContacts('SMS');
    expect(sms.map((c) => c.address)).toEqual(['233553476530']);

    const email = await digestContacts('EMAIL');
    expect(email.map((c) => c.address)).toEqual(['ibrahim@ismartghana.com']);
    expect(email[0]!.digestEveryRun).toBe(true);
  });

  it('updates and deletes', async () => {
    const c = await upsertContact({ channel: 'EMAIL', address: 'x@y.com' });
    const u = await updateContact(c.id, { isActive: false, note: 'paused' });
    expect(u?.isActive).toBe(false);
    expect(u?.note).toBe('paused');
    expect(await deleteContact(c.id)).toBe(true);
    expect(await deleteContact(c.id)).toBe(false);
  });
});
