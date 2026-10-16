import { describe, expect, it } from 'vitest';
import { validateDataSet } from '../../domain/load-test-data.js';
import { dataFieldsUsed, effectiveRps, isStateChanging } from '../../domain/load-plan.js';
import { evaluateLoadSafety, parseCeilings, parseHostList } from '../../domain/load-safety.js';
import { PACKS, packById, planFromPack } from './packs.js';

const opts = { approvedCardFixtures: ['4111111111111111'] };

describe('scenario packs', () => {
  it('has unique ids and every endpoint is documented API surface (/v1/…)', () => {
    expect(new Set(PACKS.map((p) => p.id)).size).toBe(PACKS.length);
    for (const p of PACKS) expect(p.endpoint.path.startsWith('/v1/')).toBe(true);
  });

  it.each(PACKS.map((p) => [p.id, p] as const))(
    '%s builds a valid plan whose data fields are declared',
    (_id, pack) => {
      const plan = planFromPack(pack, {});
      expect(plan.packId).toBe(pack.id);
      expect(plan.method).toBe(pack.endpoint.method);
      expect(plan.idempotencyHeader).toBe(
        pack.endpoint.method === 'GET' ? null : 'Idempotency-Key',
      );
      // Every {{data.*}} the template uses must be declared in dataFields (and vice-versa).
      expect(dataFieldsUsed(plan)).toEqual([...pack.dataFields].sort());
      // POSTs are state-changing for the safety gate; money-moving packs say so.
      if (pack.endpoint.method === 'POST') expect(isStateChanging(plan)).toBe(true);
      expect(plan.moneyMoving).toBe(pack.moneyMoving);
      expect(plan.realSideEffects).toBe(pack.realSideEffects);
    },
  );

  it.each(PACKS.flatMap((p) => p.exampleDataSets.map((d) => [`${p.id}/${d.name}`, p, d] as const)))(
    'example data set %s passes the test-data rules and covers the pack fields',
    (_name, pack, ds) => {
      const r = validateDataSet({ environment: ds.environment, records: ds.records }, opts);
      expect(r.violations).toEqual([]);
      for (const rec of ds.records) {
        for (const f of pack.dataFields) expect(rec).toHaveProperty(f);
      }
    },
  );

  it('uses ONLY documented Telecel fixture numbers (never guessed MTN/CalBank numbers)', () => {
    const numbers = new Set<string>();
    for (const p of PACKS) {
      for (const d of p.exampleDataSets) {
        for (const r of d.records) {
          for (const [k, v] of Object.entries(r)) {
            if (/msisdn/i.test(k) && typeof v === 'string' && !v.startsWith('{{')) numbers.add(v);
          }
        }
      }
    }
    for (const n of numbers) expect(['233000000001', '233000000003', '233000000004']).toContain(n);
  });

  it('payout batch: body expands per item and the safety gate sees the fan-out', () => {
    const pack = packById('payout-batch-telecel')!;
    const plan = planFromPack(pack, {
      batchSize: 20,
      targetRps: 2,
      durationSeconds: 60,
      profile: 'LOAD',
    });
    expect(plan.fanout).toBe(20);
    expect(JSON.stringify(plan.body)).toContain('"$repeat":20');
    expect(effectiveRps(plan)).toBe(40);
    expect(() => planFromPack(pack, { batchSize: 500 })).not.toThrow(); // clamped to 100
    expect(planFromPack(pack, { batchSize: 500 }).fanout).toBe(100);
  });

  it('the utility pack is blocked on the sandbox without explicit real-side-effect authorization', () => {
    const pack = packById('utility-purchase-airtime')!;
    const plan = planFromPack(pack, {});
    const decision = evaluateLoadSafety({
      now: new Date('2026-10-15T10:00:00Z'),
      enabled: true,
      killSwitch: false,
      target: {
        url: 'https://stgdeveloper-api.ismartghana.com',
        isMoneyMoving: false,
        environment: 'sandbox',
      },
      config: { environmentClass: 'SANDBOX', hasRealSideEffects: false },
      authorization: {
        status: 'APPROVED',
        windowStart: new Date('2026-10-15T09:00:00Z'),
        windowEnd: new Date('2026-10-15T18:00:00Z'),
        maxRps: 5,
        maxVus: 10,
        maxDurationSeconds: 600,
        allowRealSideEffects: false,
      },
      plan: {
        rps: effectiveRps(plan),
        vus: plan.maxVus,
        durationSeconds: plan.durationSeconds,
        mutating: isStateChanging(plan),
        realSideEffects: plan.realSideEffects,
      },
      hosts: {
        production: parseHostList('api.ismartghana.com'),
        sandbox: parseHostList('stgdeveloper-api.ismartghana.com'),
        mock: [],
      },
      ceilings: parseCeilings(
        'MOCK:5/5/5,SANDBOX:25/100/1800,STAGING:25/100/1800,PRODUCTION:2/5/300',
      ),
      realSideEffectMaxRps: 1,
    });
    expect(decision.violations.map((v) => v.code)).toContain('REAL_SIDE_EFFECTS');
  });
});
