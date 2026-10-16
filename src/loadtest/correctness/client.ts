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
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

export class ApiClient {
  readonly exchanges: Exchange[] = [];
  private token: string | null = null;
  private tokenExp = 0;

  constructor(private readonly opts: ClientOptions) {}

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
    const headers: Record<string, string> = {};
    const useClientToken = o.token === undefined;
    if (o.token === undefined) headers['authorization'] = `Bearer ${await this.getToken()}`;
    else if (o.token !== null) headers['authorization'] = `Bearer ${o.token}`;
    if (o.key !== undefined) headers['idempotency-key'] = o.key;
    let body: string | undefined;
    if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      headers['content-type'] = 'application/json';
    }

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

    // A reset/expired token → fetch a fresh one and retry once (client token only).
    if (status === 401 && useClientToken && !retried) {
      await this.getToken(true);
      return this.call(method, path, o, true);
    }
    return { status, body: json, headers: res?.headers ?? null, requestId };
  }
}
