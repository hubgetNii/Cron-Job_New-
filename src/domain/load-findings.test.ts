import { describe, expect, it } from 'vitest';
import {
  CONTROL_INFO,
  describeFindings,
  findingsFromSlo,
  findingsFromSuite,
  sortFindings,
} from './load-findings.js';
import type { SloEvaluation } from './load-slo.js';

const ev = (checks: SloEvaluation['checks']): SloEvaluation => ({
  checks,
  verdict: 'FAIL',
  reason: '',
  expectedRequests: 1,
});
const check = (id: string, status: 'FAIL' | 'WARN' | 'PASS') => ({
  id,
  name: id,
  target: '≤ 1',
  actual: '5',
  status,
  why: '',
});

describe('findingsFromSlo', () => {
  it('turns failed and warned objectives into customer-impact findings, ignoring passes', () => {
    const f = findingsFromSlo(
      ev([check('p95', 'FAIL'), check('server-errors', 'WARN'), check('p99', 'PASS')]),
      { targetRps: 20 },
    );
    expect(f.map((x) => x.reference)).toEqual(['p95', 'server-errors']);
    expect(f[0]).toMatchObject({ source: 'performance', severity: 'HIGH', advisory: false });
    expect(f[1]).toMatchObject({ severity: 'HIGH', advisory: true });
    expect(f[0]!.cause).toContain('planned rate 20/s');
    expect(f[0]!.impact).toMatch(/customers/i);
  });

  it('treats 5xx failures as critical', () => {
    expect(
      findingsFromSlo(ev([check('server-errors', 'FAIL')]), { targetRps: 1 })[0]!.severity,
    ).toBe('CRITICAL');
  });
});

describe('findingsFromSuite', () => {
  const r = (over: Record<string, unknown>) => ({
    id: 'x',
    title: 'X',
    controls: ['idempotency'],
    status: 'FAIL' as const,
    assertions: [],
    ...over,
  });

  it('rates a failed check by its worst control and quotes what failed', () => {
    const [f] = findingsFromSuite(
      [
        r({
          id: 'idem.sequential-replay',
          title: 'Same key applied once',
          assertions: [
            { name: 'exactly one payment exists', pass: false, detail: '2' },
            { name: 'ok', pass: true },
          ],
        }),
      ],
      'correctness',
    );
    expect(f).toMatchObject({
      source: 'correctness',
      severity: 'CRITICAL',
      reference: 'idem.sequential-replay',
      advisory: false,
    });
    expect(f!.cause).toBe('exactly one payment exists (2)');
    expect(f!.impact).toContain('charged or paid out twice');
    expect(f!.recommendation).toContain('Idempotency-Key');
  });

  it('reports advisory misses as LOW hardening suggestions without failing', () => {
    const f = findingsFromSuite(
      [
        r({
          status: 'PASS',
          controls: ['secure-configuration'],
          owasp: 'API8:2023',
          assertions: [
            { name: 'Cache-Control: no-store', pass: false, advisory: true, detail: 'absent' },
          ],
        }),
      ],
      'security',
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'LOW', advisory: true, owasp: 'API8:2023' });
    expect(f[0]!.title).toBe('Hardening: Cache-Control: no-store');
  });

  it('reports an errored check as unverified, and never reports a skipped one as a finding', () => {
    const f = findingsFromSuite(
      [
        r({ status: 'ERROR', note: 'Token request failed with HTTP 401' }),
        r({ id: 'y', status: 'SKIPPED' }),
      ],
      'security',
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'HIGH' });
    expect(f[0]!.impact).toContain('unknown');
  });

  it('covers every control tag the checks use (no silent fallback for a known tag)', () => {
    for (const tag of [
      'idempotency',
      'ledger-integrity',
      'reconciliation',
      'authentication',
      'access-control',
      'data-isolation',
      'input-validation',
      'availability',
      'webhook-authenticity',
      'contract-integrity',
      'pci-data-protection',
      'ssrf',
      'injection',
    ]) {
      expect(CONTROL_INFO[tag], tag).toBeDefined();
    }
  });
});

describe('ordering and description', () => {
  it('sorts critical first, defects before advisories', () => {
    const base = {
      source: 'security' as const,
      title: '',
      impact: '',
      cause: '',
      recommendation: '',
      reference: '',
    };
    const sorted = sortFindings([
      { ...base, id: 'c', severity: 'LOW', advisory: true },
      { ...base, id: 'b', severity: 'HIGH', advisory: false },
      { ...base, id: 'a', severity: 'CRITICAL', advisory: false },
    ]);
    expect(sorted.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(describeFindings(sorted)).toBe('2 findings, 1 critical, 1 high.');
    expect(describeFindings([])).toBe('No findings.');
  });
});
