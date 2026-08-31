-- Up Migration
-- The standing list of people/addresses that receive notifications "day in and
-- out" — email addresses and phone numbers, each with what it should receive.
-- The digest job and (later) per-event alerting read recipients from here rather
-- than only from env (see vault: "SMS Health Digest Notifications").

CREATE TYPE notification_contact_channel AS ENUM ('EMAIL', 'SMS');

CREATE TABLE notification_contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text,                       -- "Ibrahim", "Ops on-call"
  channel         notification_contact_channel NOT NULL,
  address         text NOT NULL,              -- email address, or E.164-ish phone
  -- what this contact receives:
  digest          boolean NOT NULL DEFAULT true,   -- the periodic system-health digest
  -- true  → every digest run (a "full status" heartbeat, e.g. email)
  -- false → only when the overall level changes (Rule A, e.g. SMS)
  digest_every_run boolean NOT NULL DEFAULT false,
  incident_alerts boolean NOT NULL DEFAULT false,  -- per-incident open/recover alerts
  is_active       boolean NOT NULL DEFAULT true,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_contacts_address_not_blank CHECK (btrim(address) <> ''),
  CONSTRAINT notification_contacts_channel_address_unique UNIQUE (channel, address)
);

CREATE INDEX notification_contacts_active_idx
  ON notification_contacts (channel, is_active) WHERE is_active;

CREATE TRIGGER notification_contacts_set_updated_at
  BEFORE UPDATE ON notification_contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration
DROP TABLE IF EXISTS notification_contacts;
DROP TYPE IF EXISTS notification_contact_channel;
