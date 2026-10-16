/**
 * Streaming aggregation of k6's `--out json` line protocol (Phase 23). Memory is
 * bounded no matter how long the run is: latencies go into a log-scale
 * histogram, and only open 5-second buckets are held.
 */

/** Log-scale histogram, ~2% relative error, 0.1ms … ~10min. */
export class LogHistogram {
  private static readonly GROWTH = 1.02;
  private static readonly LN = Math.log(LogHistogram.GROWTH);
  private counts = new Map<number, number>();
  count = 0;
  sum = 0;
  max = 0;

  private static index(ms: number): number {
    return Math.floor(Math.log(Math.max(ms, 0.1) / 0.1) / LogHistogram.LN);
  }
  private static value(idx: number): number {
    // Upper bound of the bucket — never under-reports a percentile.
    return 0.1 * Math.pow(LogHistogram.GROWTH, idx + 1);
  }

  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const i = LogHistogram.index(ms);
    this.counts.set(i, (this.counts.get(i) ?? 0) + 1);
    this.count++;
    this.sum += ms;
    if (ms > this.max) this.max = ms;
  }

  quantile(q: number): number {
    if (this.count === 0) return 0;
    const rank = Math.ceil(q * this.count);
    let seen = 0;
    for (const idx of [...this.counts.keys()].sort((a, b) => a - b)) {
      seen += this.counts.get(idx)!;
      if (seen >= rank) return Math.min(LogHistogram.value(idx), this.max);
    }
    return this.max;
  }

  get avg(): number {
    return this.count === 0 ? 0 : this.sum / this.count;
  }
}

export interface BucketRow {
  bucketStart: Date;
  requests: number;
  failures: number;
  rps: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  statusCounts: Record<string, number>;
}

export interface ErrorClasses {
  server5xx: number;
  rateLimited429: number;
  client4xx: number;
  networkOrTimeout: number;
  unexpectedOther: number;
}

export interface RunSummary {
  totalRequests: number;
  failedRequests: number;
  errorRate: number;
  statusCounts: Record<string, number>;
  errorClasses: ErrorClasses;
  latencyMs: { avg: number; p50: number; p90: number; p95: number; p99: number; max: number };
  achievedAvgRps: number;
  peakRps: number;
  /** Highest 5s-bucket rps whose failure rate stayed ≤1%. */
  maxSustainedRps: number;
  droppedIterations: number;
  /** True when k6 could not start iterations on time — the generator, not the target, was the limit. */
  generatorSaturated: boolean;
  authRequests: number;
  activeSeconds: number;
}

export const BUCKET_MS = 5000;

export type GuardrailKind = 'server_failures' | 'auth_refused' | 'rate_limited';

export interface GuardrailOptions {
  windowSeconds: number;
  /** Server-failure (5xx / network / timeout) share that trips the guardrail. */
  maxErrorRate: number;
  minSamples: number;
  /** 401/403 share that trips it — a bad/expired key or a limit/suspension refusal. Default 0.5. */
  maxRefusalRate?: number;
  /** 429 share that trips it — the run is no longer measuring the target. Default 0.5. */
  maxRateLimitedRate?: number;
}

export interface GuardrailResult {
  breach: boolean;
  kind: GuardrailKind | null;
  total: number;
  /** Server-failure share over the window (kept for callers that only need this). */
  errorRate: number;
  refusalRate: number;
  rateLimitedRate: number;
}

interface Open {
  hist: LogHistogram;
  requests: number;
  failures: number;
  statusCounts: Record<string, number>;
}

interface Point {
  time: number;
  value: number;
  tags: Record<string, string>;
}

/** Parses one k6 JSON line into a Point, or null if it is not a metric sample. */
export function parseK6Line(line: string): { metric: string; point: Point } | null {
  // k6 emits `{"metric":…,"type":"Point",…}` (key order is not guaranteed), so
  // cheap-filter on the substring and verify the parsed type.
  if (!line.includes('"type":"Point"')) return null;
  try {
    const o = JSON.parse(line) as {
      type: string;
      metric: string;
      data: { time: string; value: number; tags?: Record<string, string> };
    };
    if (o.type !== 'Point') return null;
    return {
      metric: o.metric,
      point: { time: Date.parse(o.data.time), value: o.data.value, tags: o.data.tags ?? {} },
    };
  } catch {
    return null;
  }
}

/** A request counts as a server-side failure for guardrail purposes. */
export function isServerFailure(status: number): boolean {
  return status === 0 || status >= 500;
}

export class RunAggregator {
  private open = new Map<number, Open>();
  private overall = new LogHistogram();
  private statusCounts: Record<string, number> = {};
  private classes: ErrorClasses = {
    server5xx: 0,
    rateLimited429: 0,
    client4xx: 0,
    networkOrTimeout: 0,
    unexpectedOther: 0,
  };
  private total = 0;
  private failed = 0;
  private dropped = 0;
  private auth = 0;
  private perSecond = new Map<
    number,
    { total: number; serverFailures: number; authRefusals: number; rateLimited: number }
  >();
  private bucketHistory: { rps: number; errorRate: number }[] = [];
  private peakSecond = 0;
  private firstMs = Infinity;
  private lastMs = 0;

  /** Feeds one raw k6 output line. Returns true if it contributed a sample. */
  feed(line: string): boolean {
    const parsed = parseK6Line(line);
    if (!parsed) return false;
    const { metric, point } = parsed;
    if (metric === 'dropped_iterations') {
      this.dropped += point.value;
      return true;
    }
    if (metric !== 'http_req_duration') return false;
    if (point.tags['phase'] === 'auth') {
      this.auth++;
      return true;
    }
    const status = Number(point.tags['status'] ?? 0);
    const expected = point.tags['expected_response'] !== 'false';
    this.record(point.time, point.value, status, expected);
    return true;
  }

  private record(time: number, ms: number, status: number, expected: boolean): void {
    this.total++;
    this.firstMs = Math.min(this.firstMs, time);
    this.lastMs = Math.max(this.lastMs, time);
    const key = Math.floor(time / BUCKET_MS) * BUCKET_MS;
    let b = this.open.get(key);
    if (!b) {
      b = { hist: new LogHistogram(), requests: 0, failures: 0, statusCounts: {} };
      this.open.set(key, b);
    }
    b.requests++;
    b.hist.record(ms);
    this.overall.record(ms);
    const sKey = String(status);
    b.statusCounts[sKey] = (b.statusCounts[sKey] ?? 0) + 1;
    this.statusCounts[sKey] = (this.statusCounts[sKey] ?? 0) + 1;

    if (!expected) {
      this.failed++;
      b.failures++;
      if (status === 0) this.classes.networkOrTimeout++;
      else if (status >= 500) this.classes.server5xx++;
      else if (status === 429) this.classes.rateLimited429++;
      else if (status >= 400) this.classes.client4xx++;
      else this.classes.unexpectedOther++;
    }

    const sec = Math.floor(time / 1000);
    const s = this.perSecond.get(sec) ?? {
      total: 0,
      serverFailures: 0,
      authRefusals: 0,
      rateLimited: 0,
    };
    s.total++;
    if (isServerFailure(status)) s.serverFailures++;
    if (status === 401 || status === 403) s.authRefusals++;
    if (status === 429) s.rateLimited++;
    this.perSecond.set(sec, s);
    if (s.total > this.peakSecond) this.peakSecond = s.total;
  }

  /**
   * Server-failure rate over the trailing window ending at `nowMs`. `breach` only
   * fires once `minSamples` requests exist in the window (no flapping on 3 reqs).
   */
  guardrail(nowMs: number, opts: GuardrailOptions): GuardrailResult {
    const end = Math.floor(nowMs / 1000);
    let total = 0;
    let server = 0;
    let refused = 0;
    let limited = 0;
    for (let s = end - opts.windowSeconds + 1; s <= end; s++) {
      const x = this.perSecond.get(s);
      if (x) {
        total += x.total;
        server += x.serverFailures;
        refused += x.authRefusals;
        limited += x.rateLimited;
      }
    }
    // Opportunistically drop seconds that can never matter again.
    for (const s of this.perSecond.keys())
      if (s < end - opts.windowSeconds - 5) this.perSecond.delete(s);
    const rate = (n: number): number => (total === 0 ? 0 : n / total);
    const enough = total >= opts.minSamples;
    const refusalMax = opts.maxRefusalRate ?? 0.5;
    const limitedMax = opts.maxRateLimitedRate ?? 0.5;
    // Order matters: an auth/limit refusal flood invalidates the run outright,
    // so it is reported ahead of a mere failing target.
    let kind: GuardrailKind | null = null;
    if (enough && rate(refused) > refusalMax) kind = 'auth_refused';
    else if (enough && rate(limited) > limitedMax) kind = 'rate_limited';
    else if (enough && rate(server) > opts.maxErrorRate) kind = 'server_failures';
    return {
      breach: kind !== null,
      kind,
      total,
      errorRate: rate(server),
      refusalRate: rate(refused),
      rateLimitedRate: rate(limited),
    };
  }

  /** Closes and returns buckets that ended before `beforeMs` (pass Infinity at the end). */
  drain(beforeMs: number): BucketRow[] {
    const rows: BucketRow[] = [];
    for (const [start, b] of [...this.open.entries()].sort((a, c) => a[0] - c[0])) {
      if (start + BUCKET_MS > beforeMs) continue;
      this.open.delete(start);
      const rps = b.requests / (BUCKET_MS / 1000);
      this.bucketHistory.push({ rps, errorRate: b.requests ? b.failures / b.requests : 0 });
      rows.push({
        bucketStart: new Date(start),
        requests: b.requests,
        failures: b.failures,
        rps: Math.round(rps * 100) / 100,
        avgMs: round(b.hist.avg),
        p50Ms: round(b.hist.quantile(0.5)),
        p95Ms: round(b.hist.quantile(0.95)),
        p99Ms: round(b.hist.quantile(0.99)),
        maxMs: round(b.hist.max),
        statusCounts: b.statusCounts,
      });
    }
    return rows;
  }

  summary(): RunSummary {
    const activeSeconds = this.total === 0 ? 0 : Math.max(1, (this.lastMs - this.firstMs) / 1000);
    const sustained = Math.max(
      0,
      ...this.bucketHistory.filter((h) => h.errorRate <= 0.01).map((h) => h.rps),
    );
    return {
      totalRequests: this.total,
      failedRequests: this.failed,
      errorRate: this.total === 0 ? 0 : this.failed / this.total,
      statusCounts: this.statusCounts,
      errorClasses: this.classes,
      latencyMs: {
        avg: round(this.overall.avg),
        p50: round(this.overall.quantile(0.5)),
        p90: round(this.overall.quantile(0.9)),
        p95: round(this.overall.quantile(0.95)),
        p99: round(this.overall.quantile(0.99)),
        max: round(this.overall.max),
      },
      achievedAvgRps: round(activeSeconds === 0 ? 0 : this.total / activeSeconds),
      peakRps: this.peakSecond,
      maxSustainedRps: round(sustained),
      droppedIterations: this.dropped,
      generatorSaturated: this.dropped > 0,
      authRequests: this.auth,
      activeSeconds: round(activeSeconds),
    };
  }
}

const round = (n: number): number => Math.round(n * 100) / 100;
