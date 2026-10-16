import { buildStages, peakRps, type PlanConfig } from '../../domain/load-plan.js';

export type AuthMode = 'none' | 'basic' | 'form';

export interface ScriptInput {
  plan: PlanConfig;
  /** Absolute URL template (origin from the target + the plan's path). May hold {{data.x}}. */
  url: string;
  /**
   * none  — no auth.
   * basic — Basic-auth handshake, JSON body (legacy MPSMS style).
   * form  — OAuth2 client_credentials as application/x-www-form-urlencoded
   *         (iSmartPay: `grant_type`, `client_id`, `client_secret`, `resource`).
   */
  auth: AuthMode;
  /** True when a data.json sits next to the script. */
  hasData: boolean;
}

/**
 * Renders the k6 script for a plan. All plan-derived values are embedded as JSON
 * literals (never string-concatenated into code), and no secret ever appears in
 * the script: credentials arrive via environment variables at run time.
 *
 * Request shaping (all evaluated per iteration inside k6):
 *  - `{{idem}}` `{{ref}}` `{{iter}}` `{{uuid}}`   run-unique values. LT_RUN_SALT
 *    is derived from the run id, because iSmartPay references are unique FOREVER.
 *  - `{{data.path}}`  field of the data-set record chosen for this iteration.
 *  - `{"$repeat": N, "template": {...}}`  expands to N items, `{{i}}` = index
 *    (used for payout batches, whose items need unique references).
 *
 * Tokens live 5 minutes with no refresh grant, so each VU refreshes BEFORE
 * expiry (with jitter to avoid a thundering herd) instead of reacting to 401s.
 */
export function renderK6Script({ plan, url, auth, hasData }: ScriptInput): string {
  const stages = buildStages(plan).map((s) => ({
    duration: `${s.durationSeconds}s`,
    target: s.target,
  }));
  const body = plan.body === undefined || plan.body === null ? null : plan.body;
  const cfg = {
    method: plan.method,
    url,
    headers: plan.headers,
    body,
    idempotencyHeader: plan.idempotencyHeader,
    timeout: `${plan.timeoutMs}ms`,
    expectedStatuses: plan.expectedStatuses,
    authMode: auth,
    dataSelection: plan.dataSelection,
  };
  // Concurrency needed ≈ rate × latency. Assuming a fast target (rate/10) makes k6 drop
  // iterations while it spins up VUs against a slow one, which would wrongly mark the run
  // as a saturated generator. Pre-allocate for a ~2 s response at the PEAK rate instead.
  const preAllocated =
    plan.preAllocatedVus ?? Math.min(plan.maxVus, Math.max(5, Math.ceil(peakRps(plan) * 2)), 1000);

  return `import http from 'k6/http';
import encoding from 'k6/encoding';
import exec from 'k6/execution';
${hasData ? "import { SharedArray } from 'k6/data';" : ''}

const CFG = ${JSON.stringify(cfg)};
const SALT = __ENV.LT_RUN_SALT || '00000000';
const DATA = ${hasData ? "new SharedArray('data', function () { return JSON.parse(open('./data.json')); })" : '[]'};

http.setResponseCallback(http.expectedStatuses(...CFG.expectedStatuses));

export const options = {
  discardResponseBodies: true,
  userAgent: 'ismart-loadtest/1.0',
  scenarios: {
    main: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: ${preAllocated},
      maxVUs: ${plan.maxVus},
      stages: ${JSON.stringify(stages)},
      gracefulStop: '15s',
    },
  },
};

function fetchToken() {
  const params = { responseType: 'text', tags: { phase: 'auth', name: 'token' }, headers: {} };
  let res;
  if (CFG.authMode === 'form') {
    res = http.post(
      __ENV.LT_TOKEN_URL,
      {
        grant_type: 'client_credentials',
        client_id: __ENV.LT_TOKEN_USER,
        client_secret: __ENV.LT_TOKEN_PASS,
        resource: __ENV.LT_TOKEN_RESOURCE || 'ismartpay',
      },
      params,
    );
  } else {
    params.headers.Authorization =
      'Basic ' + encoding.b64encode(__ENV.LT_TOKEN_USER + ':' + __ENV.LT_TOKEN_PASS);
    params.headers['Content-Type'] = 'application/json';
    res = http.post(__ENV.LT_TOKEN_URL, __ENV.LT_TOKEN_BODY || '{}', params);
  }
  try {
    const j = res.json();
    const token = j.access_token || (j.data && j.data.token) || null;
    // Unknown lifetime (legacy handshake) → assume 10 minutes.
    const ttl = typeof j.expires_in === 'number' ? j.expires_in * 1000 : 600000;
    return { token: token, exp: Date.now() + ttl, ttl: ttl };
  } catch (e) {
    return { token: null, exp: 0, ttl: 0 };
  }
}

export function setup() {
  return CFG.authMode === 'none' ? { token: null, exp: 0, ttl: 0 } : fetchToken();
}

// Per-VU token cache. Refresh 45–75 s before expiry (jitter spreads the VUs out),
// but never earlier than 30% of the token's life — a short TTL must not mean
// "refetch on every request".
const skew = function (ttl) {
  return Math.min(45000 + Math.floor(Math.random() * 30000), Math.floor(ttl * 0.3));
};
let token = null;
let tokenExp = 0;
let tokenInit = false;

function ensureToken(data) {
  if (CFG.authMode === 'none') return;
  const now = Date.now();
  if (!tokenInit) { token = data.token; tokenExp = data.exp - skew(data.ttl); tokenInit = true; }
  if (now >= tokenExp) {
    const r = fetchToken();
    if (r.token) { token = r.token; tokenExp = r.exp - skew(r.ttl); }
    else { tokenExp = now + 5000; } // back off instead of hammering the token endpoint
  }
}

function lookup(path, rec) {
  let cur = rec;
  const keys = path.split('.');
  for (let i = 0; i < keys.length; i++) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[keys[i]];
  }
  return cur;
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

function fill(s, ctx, enc) {
  return s.replace(/\\{\\{([A-Za-z0-9_.]+)\\}\\}/g, function (m, key) {
    let v;
    if (key === 'idem') v = ctx.idem;
    else if (key === 'ref') v = ctx.ref;
    else if (key === 'iter') v = String(ctx.n);
    else if (key === 'i') v = ctx.i === undefined ? undefined : String(ctx.i);
    else if (key === 'uuid') v = uuid();
    else if (key.indexOf('data.') === 0) v = lookup(key.slice(5), ctx.rec);
    if (v === undefined || v === null) return m;
    return enc ? encodeURIComponent(String(v)) : String(v);
  });
}

function expand(node, ctx) {
  if (typeof node === 'string') return fill(node, ctx, false);
  if (Array.isArray(node)) {
    const out = [];
    for (let i = 0; i < node.length; i++) {
      const e = expand(node[i], ctx);
      if (node[i] && typeof node[i] === 'object' && node[i].$repeat !== undefined) { for (let j = 0; j < e.length; j++) out.push(e[j]); }
      else out.push(e);
    }
    return out;
  }
  if (node && typeof node === 'object') {
    if (node.$repeat !== undefined) {
      const items = [];
      for (let i = 0; i < node.$repeat; i++) items.push(expand(node.template, Object.assign({}, ctx, { i: i })));
      return items;
    }
    const o = {};
    const keys = Object.keys(node);
    for (let k = 0; k < keys.length; k++) o[keys[k]] = expand(node[keys[k]], ctx);
    return o;
  }
  return node;
}

export default function (data) {
  ensureToken(data);
  const n = exec.scenario.iterationInTest;
  const rec = DATA.length === 0 ? {} : DATA[CFG.dataSelection === 'random' ? Math.floor(Math.random() * DATA.length) : n % DATA.length];
  const ctx = { n: n, idem: 'IDEM-TST-' + SALT + '-' + n, ref: 'LT-' + SALT + '-' + n, rec: rec };

  const headers = {};
  const keys = Object.keys(CFG.headers);
  for (let i = 0; i < keys.length; i++) headers[keys[i]] = fill(CFG.headers[keys[i]], ctx, false);
  let body = null;
  if (CFG.body !== null) {
    body = JSON.stringify(expand(CFG.body, ctx));
    if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
  }
  if (CFG.idempotencyHeader && CFG.method !== 'GET') headers[CFG.idempotencyHeader] = ctx.idem;
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const res = http.request(CFG.method, fill(CFG.url, ctx, true), body, {
    headers: headers,
    timeout: CFG.timeout,
    tags: { name: 'target' },
  });
  // A 401 despite proactive refresh (e.g. revoked key): force a refresh next time.
  if (res.status === 401 && CFG.authMode !== 'none') tokenExp = 0;
}
`;
}
