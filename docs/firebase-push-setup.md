# Firebase Cloud Messaging (PUSH channel) — setup

The `PUSH` alert channel delivers incident notifications through Firebase Cloud
Messaging (FCM HTTP v1). It authenticates with a service-account key the same way
the Firebase Admin SDK does (a signed JWT exchanged for a short-lived OAuth2
token) — no extra npm dependency.

Until `FCM_SERVICE_ACCOUNT_FILE` is set, PUSH alerts are **logged only** (never
dropped), exactly like the other channels.

---

## 1. Firebase console (you must do this — it needs your Google account)

1. <https://console.firebase.google.com> → **Add project** (or pick an existing one).
   Cloud Messaging is included; no billing required for FCM.
2. **Project settings** (gear icon) → **Cloud Messaging** tab — confirm the
   *Firebase Cloud Messaging API (V1)* is **Enabled**.
3. **Project settings → Service accounts → Generate new private key** → downloads
   a JSON file like `your-project-firebase-adminsdk-xxxxx.json`. It contains
   `project_id`, `client_email`, `private_key`.
4. Move that file **outside the repo** (e.g. `~/secrets/fcm-sa.json`) — never commit it.

## 2. Point the monitor at it

In `.env`:

```dotenv
FCM_SERVICE_ACCOUNT_FILE=/Users/you/secrets/fcm-sa.json
FCM_DEFAULT_TOPIC=cron-alerts
ALERT_DEFAULT_CHANNELS=WEBHOOK,PUSH     # fan every auto-alert to both
ALERT_DEFAULT_RECIPIENT=ops
```

Restart the API and scheduler (`npm run dev`, `npm run dev:scheduler`).

## 3. Where do notifications go? (recipient → FCM target)

The alert `recipient` string is resolved like this:

| recipient | FCM target |
|---|---|
| `/topics/cron-alerts` or `topic:cron-alerts` | that **topic** |
| a long opaque string (≥100 chars, no spaces) | that **device registration token** |
| anything else (e.g. the default `ops`) | the `FCM_DEFAULT_TOPIC` |

So for automatic incident alerts (recipient `ops`), subscribe your device(s) to
the `cron-alerts` topic. For a specific on-call phone, put its FCM registration
token as the `recipients` entry in an escalation-policy tier with `"channel": "PUSH"`.

## 4. Get a device token / subscribe to the topic

You need *something* registered with FCM to receive messages:

- **Quickest — a web page.** Add a Firebase Web App in the console (**Project
  settings → General → Your apps → Web**), copy the config, and use the
  Firebase JS SDK (`getMessaging`, `getToken` with your VAPID key) to print a
  registration token. Paste that token as the `recipient` in step 5.
- **A Flutter / Android / iOS app** already wired for FCM — call
  `FirebaseMessaging.instance.getToken()` and, for topic delivery,
  `subscribeToTopic('cron-alerts')`.
- **Server-side topic subscription** (no client): the Admin API can subscribe a
  token to a topic, but you still need a token from a real client first.

## 5. Fire a test notification

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"YOUR_ADMIN_PASSWORD"}' | jq -r '.data.accessToken')

# to the default topic
curl -s -X POST localhost:3000/api/v1/alerts/test \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"channel":"PUSH","recipient":"/topics/cron-alerts","message":"hello"}' | jq

# to one device
curl -s -X POST localhost:3000/api/v1/alerts/test \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"channel":"PUSH","recipient":"<device-registration-token>"}' | jq
```

`{"ok":true,"detail":"FCM ..."}` means FCM accepted it. `ok:false` carries the
FCM error (bad token, unregistered, etc.). `logged only — FCM_SERVICE_ACCOUNT_FILE
not set` means step 2 isn't done.

## 6. End-to-end

With `ALERT_DEFAULT_CHANNELS=WEBHOOK,PUSH`, every incident the engine opens
(`API_DOWN`, `API_DEGRADED`, `FLAPPING_DETECTED`) and every recovery
(`API_RECOVERED`) now also pushes to `cron-alerts`. Register a target that fails
(see [`testing-with-real-endpoints.md`](./testing-with-real-endpoints.md) §8) and
watch the push land on your device.
