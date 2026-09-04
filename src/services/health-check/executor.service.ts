import { randomUUID } from 'node:crypto';
import { request } from 'undici';
import { componentLogger } from '../../lib/logger.js';
import { assertUrlAllowed, SsrfBlockedError } from '../../lib/ssrf.js';
import { responseSample } from '../../lib/pci.js';
import { maskBody, maskHeaders, maskUrl } from '../../lib/masking.js';
import { substituteUuid } from '../../lib/templating.js';
import { findTargetCredentialEnvelope } from '../../repositories/monitored-apis.repo.js';
import { decryptCredentials } from '../../lib/crypto/credential-cipher.js';
import type { MonitoredApi } from '../../domain/target.js';
import type { HealthCheckOutcome, RequestResponseTrace } from '../../domain/health-check.js';
import type { CheckFailureType, HealthStatus } from '../../domain/enums.js';
import { buildAuthMaterial } from './auth.js';
import {
  classifyHttpStatus,
  classifyTransportError,
  RETRYABLE_FAILURES,
} from './failure-classifier.js';
import { validateResponse, type ResponseFacts } from './validator.service.js';

const log = componentLogger('health-check');
const DEGRADED_LATENCY_RATIO = 0.8;
const MAX_BODY_BYTES = 256 * 1024;

export interface ExecuteOptions {
  /** Pre-resolved plaintext credentials; if omitted, the target's envelope is decrypted. */
  credentials?: Record<string, string> | null;
  /** Override sleep between retries (tests). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface AttemptResult {
  status: HealthStatus;
  httpStatus: number | null;
  responseTimeMs: number | null;
  failureType: CheckFailureType | null;
  errorMessage: string | null;
  validation: HealthCheckOutcome['validation'];
  responseSample: string | null;
  trace: RequestResponseTrace | null;
}

interface SentRequest {
  method: MonitoredApi['method'];
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

/** Assembles the trace from what was sent and (optionally) what came back. */
function buildTrace(
  sent: SentRequest,
  responseTimeMs: number | null,
  response?: {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
  } | null,
): RequestResponseTrace {
  const resHeaders = response?.headers ?? {};
  const resBody = response?.body ?? null;
  return {
    requestMethod: sent.method,
    requestUrlMasked: maskUrl(sent.url),
    requestHeadersMasked: maskHeaders(sent.headers),
    requestBodyMasked: maskBody(sent.body),
    responseStatus: response?.statusCode ?? null,
    responseHeadersMasked: maskHeaders(resHeaders),
    responseBodyMasked: maskBody(resBody),
    responseBytes: resBody != null ? Buffer.byteLength(resBody) : null,
    responseContentType: resHeaders['content-type'] ?? null,
    responseTimeMs,
    raw: {
      requestUrl: sent.url,
      requestHeaders: sent.headers,
      requestBody: sent.body,
      responseHeaders: resHeaders,
      responseBody: resBody,
    },
  };
}

function flattenHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v == null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

async function resolveCredentials(
  target: MonitoredApi,
  opts: ExecuteOptions,
): Promise<Record<string, string> | null> {
  if (opts.credentials !== undefined) return opts.credentials;
  if (!target.hasCredentials) return null;
  const envelope = await findTargetCredentialEnvelope(target.id);
  return envelope ? decryptCredentials(envelope) : null;
}

function buildUrl(base: string, query: Record<string, string>): string {
  if (Object.keys(query).length === 0) return base;
  const url = new URL(base);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url.toString();
}

async function preflightSsrf(target: MonitoredApi): Promise<CheckFailureType | null> {
  try {
    await assertUrlAllowed(target.url, { allowPrivateNetwork: target.allowPrivateNetwork });
    return null;
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      return /could not resolve|no addresses/.test(err.message) ? 'DNS_ERROR' : 'UNKNOWN';
    }
    throw err;
  }
}

async function attempt(
  target: MonitoredApi,
  creds: Record<string, string> | null,
  runId: string,
): Promise<AttemptResult> {
  const auth = await buildAuthMaterial(target.authenticationType, creds);
  const url = buildUrl(target.url, auth.query);
  const headers: Record<string, string> = {
    accept: 'application/json, text/plain;q=0.9, */*;q=0.5',
    'user-agent': 'fintech-cron-monitor/health-check',
    ...target.headers,
    ...auth.headers,
  };

  let body: string | null = null;
  if (target.method !== 'GET' && target.method !== 'HEAD' && target.requestBody != null) {
    const templated = substituteUuid(target.requestBody, runId);
    body = typeof templated === 'string' ? templated : JSON.stringify(templated);
    headers['content-type'] ??= 'application/json';
  }
  const sent: SentRequest = { method: target.method, url, headers, body };

  const preflight = await preflightSsrf(target);
  if (preflight) {
    const status: HealthStatus = preflight === 'DNS_ERROR' ? 'DOWN' : 'UNKNOWN';
    return {
      status,
      httpStatus: null,
      responseTimeMs: null,
      failureType: preflight,
      errorMessage:
        preflight === 'DNS_ERROR'
          ? `DNS resolution failed for ${target.url}`
          : `Target URL blocked by SSRF policy`,
      validation: null,
      responseSample: null,
      trace: buildTrace(sent, null, null),
    };
  }

  const started = performance.now();
  try {
    const res = await request(url, {
      method: target.method,
      headers,
      body,
      signal: AbortSignal.timeout(target.timeoutMs),
    });
    const raw = await res.body.text();
    const responseTimeMs = Math.round(performance.now() - started);
    const bodyText = raw.length > MAX_BODY_BYTES ? raw.slice(0, MAX_BODY_BYTES) : raw;
    const response = {
      statusCode: res.statusCode,
      headers: flattenHeaders(res.headers),
      body: bodyText,
    };

    let json: unknown;
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = undefined;
    }

    const facts: ResponseFacts = { httpStatus: res.statusCode, bodyText, json };
    const validation = validateResponse(target.expectedResponse, target.expectedStatus, facts);
    const sample = responseSample(bodyText);

    if (res.statusCode === 429) {
      return {
        status: 'UNKNOWN',
        httpStatus: 429,
        responseTimeMs,
        failureType: 'RATE_LIMITED',
        errorMessage: 'Target returned HTTP 429',
        validation,
        responseSample: sample,
        trace: buildTrace(sent, responseTimeMs, response),
      };
    }

    if (validation.passed) {
      const slow = responseTimeMs > target.timeoutMs * DEGRADED_LATENCY_RATIO;
      const status: HealthStatus = slow ? 'DEGRADED' : 'UP';
      return {
        status,
        httpStatus: res.statusCode,
        responseTimeMs,
        failureType: null,
        errorMessage: slow
          ? `Latency ${responseTimeMs}ms near the ${target.timeoutMs}ms timeout`
          : null,
        validation,
        responseSample: sample,
        trace: buildTrace(sent, responseTimeMs, response),
      };
    }

    const statusHealthy = res.statusCode >= 200 && res.statusCode < 300;
    const failureType: CheckFailureType = statusHealthy
      ? 'VALIDATION_ERROR'
      : classifyHttpStatus(res.statusCode);
    return {
      status: 'DOWN',
      httpStatus: res.statusCode,
      responseTimeMs,
      failureType,
      errorMessage: validation.results.find((r) => !r.passed)?.detail
        ? `Validation failed: ${validation.results
            .filter((r) => !r.passed)
            .map((r) => r.rule)
            .join('; ')}`
        : `Unexpected response (HTTP ${res.statusCode})`,
      validation,
      responseSample: sample,
      trace: buildTrace(sent, responseTimeMs, response),
    };
  } catch (err) {
    const responseTimeMs = Math.round(performance.now() - started);
    const failureType = classifyTransportError(err);
    return {
      status: 'DOWN',
      httpStatus: null,
      responseTimeMs,
      failureType,
      errorMessage: err instanceof Error ? err.message : String(err),
      validation: null,
      responseSample: null,
      trace: buildTrace(sent, responseTimeMs, null),
    };
  }
}

/**
 * Executes a health check against a target, applying its retry/backoff policy.
 * A single transient blip must not surface as DOWN — only a failure that
 * survives the retry policy does (see vault: "Failure Classification and Retry
 * Backoff"). Deterministic failures (4xx, validation) are not retried.
 */
export async function executeCheck(
  target: MonitoredApi,
  opts: ExecuteOptions = {},
): Promise<HealthCheckOutcome> {
  const creds = await resolveCredentials(target, opts);
  const sleep = opts.sleep ?? defaultSleep;
  const maxAttempts = target.retry.count + 1;
  // Generated once per check, not per attempt: a retry must reuse the same id
  // so a vendor's own idempotency/dedup on that field can't be defeated by a
  // retry, which matters most for a check that triggers a real purchase.
  const runId = randomUUID();

  let last: AttemptResult | undefined;
  let attempts = 0;

  for (let n = 1; n <= maxAttempts; n += 1) {
    attempts = n;
    last = await attempt(target, creds, runId);

    const failed = last.status === 'DOWN' || last.status === 'UNKNOWN';
    const retryable = last.failureType !== null && RETRYABLE_FAILURES.has(last.failureType);
    if (!failed || !retryable || n === maxAttempts) break;

    const delay = Math.min(
      target.retry.baseDelayMs * target.retry.backoffMultiplier ** (n - 1),
      target.retry.maxDelayMs,
    );
    log.debug(
      {
        targetId: target.id,
        attempt: n,
        failureType: last.failureType,
        delayMs: Math.round(delay),
      },
      'retrying health check',
    );
    await sleep(delay);
  }

  const result = last!;
  return {
    status: result.status,
    httpStatus: result.httpStatus,
    responseTimeMs: result.responseTimeMs,
    failureType: result.failureType,
    errorMessage: result.errorMessage,
    validation: result.validation,
    attempts,
    responseSample: result.responseSample,
    trace: result.trace,
    checkedAt: new Date(),
  };
}
