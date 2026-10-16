import { describe, expect, it } from 'vitest';
import {
  evaluateLoadSafety,
  parseCeilings,
  parseHostList,
  type SafetyAuthorization,
  type SafetyInput,
} from './load-safety.js';

const ceilings = parseCeilings(
  'MOCK:5000/2000/3600,SANDBOX:200/500/3600,STAGING:200/500/3600,PRODUCTION:2/5/300',
);
const now = new Date('2026-10-15T10:00:00Z');
const auth: SafetyAuthorization = {
  status: 'APPROVED',
  windowStart: new Date('2026-10-15T09:00:00Z'),
  windowEnd: new Date('2026-10-15T18:00:00Z'),
  maxRps: 100,
  maxVus: 200,
  maxDurationSeconds: 1800,
  allowRealSideEffects: false,
};

function input(over: Partial<SafetyInput> = {}): SafetyInput {
  return {
    now,
    enabled: true,
    killSwitch: false,
    target: {
      url: 'https://stgdeveloper-api.ismartghana.com/v1/collections',
      isMoneyMoving: true,
      environment: 'sandbox',
    },
    config: { environmentClass: 'SANDBOX', hasRealSideEffects: false },
    authorization: auth,
    plan: { rps: 50, vus: 100, durationSeconds: 600, mutating: true },
    hosts: {
      production: parseHostList('api.ismartghana.com,gateway.ismartghana.org'),
      sandbox: parseHostList('stgdeveloper-api.ismartghana.com'),
      mock: parseHostList('localhost,127.0.0.1'),
    },
    ceilings,
    realSideEffectMaxRps: 1,
    ...over,
  };
}
const codes = (i: SafetyInput): string[] => evaluateLoadSafety(i).violations.map((x) => x.code);

describe('evaluateLoadSafety', () => {
  it('allows an authorized money-moving sandbox run within caps', () => {
    const d = evaluateLoadSafety(input());
    expect(d.allowed).toBe(true);
    expect(d.effectiveClass).toBe('SANDBOX');
  });

  it('denies by default with no config', () => {
    expect(codes(input({ config: null }))).toContain('NO_CONFIG');
  });

  it('denies when disabled or kill switch engaged', () => {
    expect(codes(input({ enabled: false }))).toContain('LOAD_TESTING_DISABLED');
    expect(codes(input({ killSwitch: true }))).toContain('KILL_SWITCH');
  });

  it('never allows state-changing load on PRODUCTION, even with authorization', () => {
    const c = codes(
      input({
        target: {
          url: 'https://api.ismartghana.com/v1/payouts',
          isMoneyMoving: true,
          environment: 'production',
        },
        config: { environmentClass: 'PRODUCTION', hasRealSideEffects: false },
        plan: { rps: 1, vus: 1, durationSeconds: 60, mutating: true },
      }),
    );
    expect(c).toContain('PRODUCTION_STATE_CHANGING');
  });

  it('allows a tiny read-only PRODUCTION run only with authorization', () => {
    const base = input({
      target: {
        url: 'https://api.ismartghana.com/v1/limits',
        isMoneyMoving: false,
        environment: 'production',
      },
      config: { environmentClass: 'PRODUCTION', hasRealSideEffects: false },
      plan: { rps: 1, vus: 2, durationSeconds: 120, mutating: false },
    });
    expect(evaluateLoadSafety(base).allowed).toBe(true);
    expect(codes({ ...base, authorization: null })).toContain('AUTH_REQUIRED');
    expect(codes({ ...base, plan: { ...base.plan, rps: 50 } })).toContain('CEILING_RPS');
  });

  it('blocks a production-environment target classified as SANDBOX (downgrade)', () => {
    const c = codes(
      input({
        target: {
          url: 'https://api.ismartghana.com/v1/payouts',
          isMoneyMoving: true,
          environment: 'production',
        },
      }),
    );
    expect(c).toContain('CLASS_DOWNGRADE');
    expect(c).toContain('PRODUCTION_STATE_CHANGING');
  });

  it('blocks a sandbox class pointed at a production host', () => {
    const c = codes(
      input({
        target: {
          url: 'https://api.ismartghana.com/v1/x',
          isMoneyMoving: false,
          environment: 'sandbox',
        },
      }),
    );
    expect(c).toContain('HOST_IS_PRODUCTION');
    expect(c).toContain('HOST_NOT_ALLOWLISTED');
  });

  it('enforces ceilings and authorization caps', () => {
    const c = codes(input({ plan: { rps: 500, vus: 900, durationSeconds: 9000, mutating: true } }));
    expect(c).toEqual(
      expect.arrayContaining([
        'CEILING_RPS',
        'CEILING_VUS',
        'CEILING_DURATION',
        'AUTH_CAP_RPS',
        'AUTH_CAP_VUS',
        'AUTH_CAP_DURATION',
      ]),
    );
  });

  it('requires an approved, in-window authorization', () => {
    expect(codes(input({ authorization: null }))).toContain('AUTH_REQUIRED');
    expect(codes(input({ authorization: { ...auth, status: 'PENDING' } }))).toContain(
      'AUTH_NOT_APPROVED',
    );
    expect(codes(input({ authorization: { ...auth, status: 'REVOKED' } }))).toContain(
      'AUTH_NOT_APPROVED',
    );
    expect(
      codes(input({ authorization: { ...auth, windowEnd: new Date('2026-10-15T10:05:00Z') } })),
    ).toContain('AUTH_OUTSIDE_WINDOW');
    expect(
      codes(input({ authorization: { ...auth, windowStart: new Date('2026-10-15T11:00:00Z') } })),
    ).toContain('AUTH_OUTSIDE_WINDOW');
  });

  it('treats real-side-effect endpoints as blocked unless explicitly authorized and ≤1 rps', () => {
    const config = { environmentClass: 'SANDBOX' as const, hasRealSideEffects: true };
    expect(codes(input({ config }))).toContain('REAL_SIDE_EFFECTS');
    const ok = input({
      config,
      authorization: { ...auth, allowRealSideEffects: true },
      plan: { rps: 1, vus: 1, durationSeconds: 60, mutating: true },
    });
    expect(evaluateLoadSafety(ok).allowed).toBe(true);
    expect(codes({ ...ok, plan: { ...ok.plan, rps: 5 } })).toContain('REAL_SIDE_EFFECTS_RPS');
  });

  it('treats a plan-declared real side effect like a flagged target', () => {
    const base = input({
      plan: { rps: 1, vus: 1, durationSeconds: 60, mutating: true, realSideEffects: true },
    });
    expect(codes(base)).toContain('REAL_SIDE_EFFECTS');
    expect(
      evaluateLoadSafety({ ...base, authorization: { ...auth, allowRealSideEffects: true } })
        .allowed,
    ).toBe(true);
  });

  it('lets the simulator run without authorization but only on mock hosts', () => {
    const mock = input({
      target: {
        url: 'http://localhost:4010/v1/payouts',
        isMoneyMoving: true,
        environment: 'sandbox',
      },
      config: { environmentClass: 'MOCK', hasRealSideEffects: true },
      authorization: null,
      plan: { rps: 1000, vus: 500, durationSeconds: 300, mutating: true },
    });
    expect(evaluateLoadSafety(mock).allowed).toBe(true);
    expect(
      codes({
        ...mock,
        target: { ...mock.target, url: 'https://stgdeveloper-api.ismartghana.com/v1/x' },
      }),
    ).toContain('HOST_NOT_MOCK');
  });
});

describe('parseCeilings', () => {
  it('rejects malformed or incomplete specs', () => {
    expect(() => parseCeilings('MOCK:1/1/1')).toThrow(/missing class/);
    expect(() => parseCeilings('MOCK:a/b/c')).toThrow(/Invalid/);
  });
});
