import { describe, expect, it } from 'vitest';
import {
  BUCKET_MS,
  LogHistogram,
  RunAggregator,
  isServerFailure,
  parseK6Line,
} from './metrics-aggregator.js';

const T0 = Date.parse('2026-10-15T12:00:00.000Z');
const line = (
  ms: number,
  status: number,
  atMs: number,
  extra: Record<string, string> = {},
  metric = 'http_req_duration',
): string =>
  // Real k6 key order: metric first, then type.
  JSON.stringify({
    metric,
    type: 'Point',
    data: {
      time: new Date(atMs).toISOString(),
      value: ms,
      tags: {
        status: String(status),
        expected_response: String(status >= 200 && status < 300),
        name: 'target',
        ...extra,
      },
    },
  });

describe('LogHistogram', () => {
  it('reports percentiles within ~2% and never under-reports', () => {
    const h = new LogHistogram();
    for (let i = 1; i <= 1000; i++) h.record(i);
    for (const [q, exact] of [
      [0.5, 500],
      [0.95, 950],
      [0.99, 990],
    ] as const) {
      const v = h.quantile(q);
      expect(v).toBeGreaterThanOrEqual(exact);
      expect(v).toBeLessThanOrEqual(exact * 1.03);
    }
    expect(h.max).toBe(1000);
    expect(h.avg).toBeCloseTo(500.5, 1);
  });

  it('handles empty and invalid input', () => {
    const h = new LogHistogram();
    expect(h.quantile(0.99)).toBe(0);
    h.record(NaN);
    h.record(-1);
    expect(h.count).toBe(0);
  });
});

describe('parseK6Line', () => {
  it('parses points and ignores everything else', () => {
    expect(parseK6Line(line(12, 200, T0))?.metric).toBe('http_req_duration');
    // Either key order is accepted.
    expect(
      parseK6Line('{"type":"Point","metric":"m","data":{"time":"2026-10-15T12:00:00Z","value":1}}')
        ?.metric,
    ).toBe('m');
    expect(parseK6Line('{"type":"Metric","data":{}}')).toBeNull();
    // A Metric declaration that merely mentions "type":"Point" in a name is not a sample.
    expect(
      parseK6Line('{"metric":"x","type":"Metric","data":{"note":"\\"type\\":\\"Point\\""}}'),
    ).toBeNull();
    expect(parseK6Line('garbage')).toBeNull();
    expect(parseK6Line('{"type":"Point", broken')).toBeNull();
  });
});

describe('RunAggregator', () => {
  it('buckets by 5s, classifies failures, and excludes auth traffic', () => {
    const a = new RunAggregator();
    for (let i = 0; i < 10; i++) a.feed(line(20 + i, 202, T0 + i * 100));
    a.feed(line(900, 503, T0 + 1000));
    a.feed(line(5, 429, T0 + 1100));
    a.feed(line(5, 422, T0 + 1200));
    a.feed(line(30000, 0, T0 + 1300));
    a.feed(line(40, 200, T0 + 1400, { phase: 'auth' }));
    a.feed(line(3, 0, T0 + 1500, {}, 'dropped_iterations'));
    for (let i = 0; i < 4; i++) a.feed(line(15, 202, T0 + BUCKET_MS + i));

    const rows = a.drain(Infinity);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ requests: 14, failures: 4 });
    expect(rows[0]!.statusCounts).toMatchObject({
      '202': 10,
      '503': 1,
      '429': 1,
      '422': 1,
      '0': 1,
    });
    expect(rows[1]).toMatchObject({ requests: 4, failures: 0 });

    const s = a.summary();
    expect(s.totalRequests).toBe(18);
    expect(s.errorClasses).toEqual({
      server5xx: 1,
      rateLimited429: 1,
      client4xx: 1,
      networkOrTimeout: 1,
      unexpectedOther: 0,
    });
    expect(s.authRequests).toBe(1);
    expect(s.droppedIterations).toBe(3);
    expect(s.generatorSaturated).toBe(true);
    expect(s.latencyMs.max).toBe(30000);
  });

  it('drain only returns closed buckets', () => {
    const a = new RunAggregator();
    a.feed(line(10, 202, T0));
    a.feed(line(10, 202, T0 + BUCKET_MS));
    expect(a.drain(T0 + BUCKET_MS)).toHaveLength(1); // first bucket closed, second still open
    expect(a.drain(Infinity)).toHaveLength(1);
    expect(a.drain(Infinity)).toHaveLength(0);
  });

  it('computes sustained rps only from healthy buckets', () => {
    const a = new RunAggregator();
    for (let i = 0; i < 50; i++) a.feed(line(10, 202, T0 + i)); // 10 rps healthy
    for (let i = 0; i < 100; i++) a.feed(line(10, i % 2 ? 503 : 202, T0 + BUCKET_MS + i)); // 20 rps, 50% bad
    a.drain(Infinity);
    const s = a.summary();
    expect(s.maxSustainedRps).toBe(10);
    expect(s.peakRps).toBeGreaterThanOrEqual(50);
  });

  describe('guardrail', () => {
    const opts = { windowSeconds: 10, maxErrorRate: 0.25, minSamples: 20 };

    it('does not fire on too few samples, even at 100% errors', () => {
      const a = new RunAggregator();
      for (let i = 0; i < 5; i++) a.feed(line(10, 503, T0 + i));
      expect(a.guardrail(T0 + 1000, opts).breach).toBe(false);
    });

    it('fires once enough samples exceed the server-failure rate', () => {
      const a = new RunAggregator();
      for (let i = 0; i < 30; i++) a.feed(line(10, i < 10 ? 503 : 202, T0 + i * 10));
      const g = a.guardrail(T0 + 1000, opts);
      expect(g.total).toBe(30);
      expect(g.errorRate).toBeCloseTo(10 / 30);
      expect(g.breach).toBe(true);
      expect(g.kind).toBe('server_failures');
    });

    it('does not count 4xx/429 as server failures', () => {
      const a = new RunAggregator();
      for (let i = 0; i < 40; i++) a.feed(line(10, i % 2 ? 429 : 422, T0 + i * 10));
      expect(a.guardrail(T0 + 1000, opts).breach).toBe(false);
      expect(isServerFailure(429)).toBe(false);
      expect(isServerFailure(0)).toBe(true);
      expect(isServerFailure(500)).toBe(true);
    });

    it('trips on a 401/403 flood (bad key, daily limit, suspension) with its own kind', () => {
      const a = new RunAggregator();
      for (let i = 0; i < 40; i++) a.feed(line(5, i % 4 ? 403 : 401, T0 + i * 10));
      const g = a.guardrail(T0 + 1000, opts);
      expect(g).toMatchObject({ breach: true, kind: 'auth_refused' });
    });

    it('trips on sustained 429s — the run is no longer measuring the target', () => {
      const a = new RunAggregator();
      for (let i = 0; i < 40; i++) a.feed(line(5, i < 30 ? 429 : 202, T0 + i * 10));
      expect(a.guardrail(T0 + 1000, opts)).toMatchObject({ breach: true, kind: 'rate_limited' });
      const few = new RunAggregator();
      for (let i = 0; i < 40; i++) few.feed(line(5, i < 8 ? 429 : 202, T0 + i * 10));
      expect(few.guardrail(T0 + 1000, opts).breach).toBe(false); // occasional 429s are normal
    });

    it('forgets old seconds outside the window', () => {
      const a = new RunAggregator();
      for (let i = 0; i < 30; i++) a.feed(line(10, 503, T0 + i));
      expect(a.guardrail(T0 + 60_000, opts)).toMatchObject({ breach: false, total: 0 });
    });
  });
});
