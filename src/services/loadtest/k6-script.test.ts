import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PlanConfigSchema } from '../../domain/load-plan.js';
import { PACKS, planFromPack } from '../../loadtest/packs/packs.js';
import { renderK6Script } from './k6-script.js';

const k6Up = ((): boolean => {
  try {
    execFileSync('k6', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const plan = (over: Record<string, unknown> = {}) =>
  PlanConfigSchema.parse({
    profile: 'LOAD',
    method: 'POST',
    targetRps: 50,
    durationSeconds: 100,
    maxVus: 120,
    body: { amount: '10.00', currency: 'GHS', reference: '{{ref}}' },
    ...over,
  });

const render = (p = plan(), over: Partial<Parameters<typeof renderK6Script>[0]> = {}) =>
  renderK6Script({
    plan: p,
    url: 'http://localhost:4010/v1/payouts',
    auth: 'none',
    hasData: false,
    ...over,
  });

describe('renderK6Script', () => {
  it('embeds stages, VU bounds and the target as JSON literals', () => {
    const s = render();
    expect(s).toContain("executor: 'ramping-arrival-rate'");
    expect(s).toContain('maxVUs: 120');
    expect(s).toContain('"duration":"10s","target":50');
    expect(s).toContain('"url":"http://localhost:4010/v1/payouts"');
    expect(s).toContain('"expectedStatuses":[200,201,202,204]');
    expect(s).toContain('"idempotencyHeader":"Idempotency-Key"');
  });

  it('never embeds credentials — they come from env at run time', () => {
    const s = render(plan(), { auth: 'form' });
    expect(s).toContain('__ENV.LT_TOKEN_USER');
    expect(s).toContain('__ENV.LT_TOKEN_PASS');
    expect(s).toContain("grant_type: 'client_credentials'");
    expect(s).toContain("__ENV.LT_TOKEN_RESOURCE || 'ismartpay'");
    expect(s).not.toMatch(/Bearer [A-Za-z0-9_-]{8,}/);
  });

  it('refreshes tokens proactively, never earlier than 30% of the token life', () => {
    const s = render(plan(), { auth: 'form' });
    expect(s).toContain('ttl * 0.3');
    expect(s).toContain('tokenExp = data.exp - skew(data.ttl)');
  });

  it('cannot be broken out of by hostile plan values', () => {
    const evil = "'; throw new Error('pwn'); //";
    const s = render(plan({ headers: { 'X-Note': evil }, body: { note: evil } }));
    const hits = s.split('\n').filter((l) => l.includes('pwn'));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.startsWith('const CFG = ')).toBe(true);
    const cfg = JSON.parse(hits[0]!.slice('const CFG = '.length, -1)) as {
      headers: Record<string, string>;
    };
    expect(cfg.headers['X-Note']).toBe(evil);
  });

  it('keeps GET bodyless and loads data only when asked', () => {
    const get = render(plan({ method: 'GET', body: undefined, idempotencyHeader: null }));
    expect(get).toContain('"idempotencyHeader":null');
    expect(get).toContain('"body":null');
    expect(get).toContain('const DATA = []');
    const withData = render(plan(), { hasData: true });
    expect(withData).toContain("import { SharedArray } from 'k6/data'");
    expect(withData).toContain("open('./data.json')");
  });
});

describe.skipIf(!k6Up)('generated scripts are valid k6 (k6 inspect)', () => {
  const inspect = (script: string): void => {
    const dir = mkdtempSync(join(tmpdir(), 'lt-inspect-'));
    try {
      writeFileSync(join(dir, 'script.js'), script);
      writeFileSync(join(dir, 'data.json'), '[{}]');
      execFileSync('k6', ['inspect', join(dir, 'script.js')], {
        stdio: 'pipe',
        env: { PATH: process.env['PATH'] ?? '' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it.each(PACKS.map((p) => [p.id, p] as const))('%s', (_id, pack) => {
    const cfg = planFromPack(pack, {});
    const url = `http://localhost:4010${cfg.path ?? ''}`;
    for (const auth of ['none', 'form', 'basic'] as const) {
      expect(() =>
        inspect(renderK6Script({ plan: cfg, url, auth, hasData: pack.dataFields.length > 0 })),
      ).not.toThrow();
    }
  });
});
