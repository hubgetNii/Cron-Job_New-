/**
 * Minimal iSmartPay API client for the correctness suite. It records an
 * `Exchange` per call (method, path, status, Request-Id, Idempotency-Key and the
 * payment reference) as audit evidence — never bodies, tokens or secrets.
 */

export interface Exchange {
  at: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  requestId: string | null;
  idempotencyKey: string | null;
  reference?: string;
  errorCode?: string;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  headers: Headers | null;
  requestId: string | null;
}

export interface ClientOptions {
  baseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  resource?: string;
  timeoutMs?: number;
}

export interface CallOptions {
  body?: unknown;
  /** Idempotency-Key header. Omit/undefined → none sent. */
  key?: string | undefined;
  /** `undefined` → use the client's token; `null` → send no Authorization; string → send that token. */
  token?: string | null | undefined;
  /** Send this exact string as the body (for malformed-JSON and hostile-payload tests). */
  rawBody?: string | undefined;
  /** Extra request headers (lower-case names). */
  headers?: Record<string, string> | undefined;
}

/**
 * Thrown when the test credential is refused for lacking a named permission
 * ("the credential does not have the X permission"). That is a gap in how the
 * key was issued — not a defect in the service — so the check that hit it is
 * reported as BLOCKED rather than failed, and the same endpoint is not retried.
 */
export class PermissionBlockedError extends Error {
  constructor(
    readonly permission: string,
    readonly endpoint: string,
  ) {
    super(`The test key lacks the ${permission} permission (needed for ${endpoint}).`);
    this.name = 'PermissionBlockedError';
  }
}

const PERMISSION_RE = /does not have the ([A-Za-z0-9_.:-]+) permission/i;
/** `POST /v1/payouts/LTC-1-2` and `POST /v1/payouts` are the same endpoint group. */
const endpointKey = (method: string, path: string): string =>
  `${method} /${path.split('?')[0]!.split('/').filter(Boolean).slice(0, 2).join('/')}`;

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

export class ApiClient {
  readonly exchanges: Exchange[];
  private token: string | null = null;
  private tokenExp = 0;
  /** Endpoint groups the client token was refused for, with the permission it lacks. */
  private readonly denied = new Map<string, string>();

  /** `sink` lets several clients append to one evidence list. */
  constructor(
    private readonly opts: ClientOptions,
    sink?: Exchange[],
  ) {
    this.exchanges = sink ?? [];
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }
  get tokenUrl(): string {
    return this.opts.tokenUrl;
  }
  /** Scopes the current token carries (decoded, not verified — informational only). */
  get scopes(): string[] | null {
    const part = this.token?.split('.')[1];
    if (!part) return null;
    try {
      const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as {
        scopes?: unknown;
        scope?: unknown;
      };
      const raw = claims.scopes ?? claims.scope;
      if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
      if (typeof raw === 'string') return raw.split(/\s+/).filter(Boolean);
    } catch {
      /* not a JWT */
    }
    return null;
  }
  get clientId(): string {
    return this.opts.clientId;
  }

  /** Fetches (or reuses) a bearer token, refreshing 60 s before its documented 5-minute expiry. */
  async getToken(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.tokenExp - 60_000) return this.token;
    const started = Date.now();
    const res = await fetch(this.opts.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        resource: this.opts.resource ?? 'ismartpay',
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    const json = asRecord(await res.json().catch(() => null));
    this.exchanges.push({
      at: new Date().toISOString(),
      method: 'POST',
      path: '/v1/oauth/token',
      status: res.status,
      ms: Date.now() - started,
      requestId: res.headers.get('request-id'),
      idempotencyKey: null,
    });
    const token = json['access_token'];
    if (res.status !== 200 || typeof token !== 'string') {
      throw new Error(`Token request failed with HTTP ${res.status}`);
    }
    this.token = token;
    this.tokenExp =
      Date.now() + (typeof json['expires_in'] === 'number' ? json['expires_in'] * 1000 : 300_000);
    return token;
  }

  async call(
    method: string,
    path: string,
    o: CallOptions = {},
    retried = false,
  ): Promise<ApiResponse> {
    const useClientToken = o.token === undefined;
    const key = endpointKey(method, path);
    const knownDenial = useClientToken ? this.denied.get(key) : undefined;
    if (knownDenial) throw new PermissionBlockedError(knownDenial, key);
    const headers: Record<string, string> = {};
    if (o.token === undefined) headers['authorization'] = `Bearer ${await this.getToken()}`;
    else if (o.token !== null) headers['authorization'] = `Bearer ${o.token}`;
    if (o.key !== undefined) headers['idempotency-key'] = o.key;
    let body: string | undefined;
    if (o.rawBody !== undefined) {
      body = o.rawBody;
      headers['content-type'] = 'application/json';
    } else if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      headers['content-type'] = 'application/json';
    }
    Object.assign(headers, o.headers);

    const started = Date.now();
    let res: Response | null = null;
    let json: unknown = null;
    try {
      res = await fetch(`${this.opts.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      });
      json = await res.json().catch(() => null);
    } catch {
      res = null; // network failure / timeout → status 0
    }
    const status = res?.status ?? 0;
    const requestId = res?.headers.get('request-id') ?? null;
    const rec = asRecord(o.body);
    const bodyRec = asRecord(json);
    const reference =
      typeof rec['reference'] === 'string'
        ? rec['reference']
        : typeof bodyRec['reference'] === 'string'
          ? bodyRec['reference']
          : undefined;
    const errorCode =
      typeof asRecord(bodyRec['error'])['code'] === 'string'
        ? (asRecord(bodyRec['error'])['code'] as string)
        : undefined;
    this.exchanges.push({
      at: new Date().toISOString(),
      method,
      path,
      status,
      ms: Date.now() - started,
      requestId,
      idempotencyKey: o.key ?? null,
      ...(reference ? { reference } : {}),
      ...(errorCode ? { errorCode } : {}),
    });

    // The client credential itself lacks a permission: stop here and say so.
    if (status === 403 && useClientToken) {
      const msg = asRecord(bodyRec['error'])['message'];
      const perm = typeof msg === 'string' ? PERMISSION_RE.exec(msg)?.[1] : undefined;
      if (perm) {
        this.denied.set(key, perm);
        throw new PermissionBlockedError(perm, key);
      }
    }

    // A reset/expired token → fetch a fresh one and retry once (client token only).
    if (status === 401 && useClientToken && !retried) {
      await this.getToken(true);
      return this.call(method, path, o, true);
    }
    return { status, body: json, headers: res?.headers ?? null, requestId };
  }
}
