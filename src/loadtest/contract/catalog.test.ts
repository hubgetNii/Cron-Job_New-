import { describe, expect, it } from 'vitest';
import { PACKS } from '../packs/packs.js';
import { CATALOG, catalogSummary, normalizePackPath } from './catalog.js';

/** Compare path SHAPES: parameter names may differ between a pack's data field and the docs. */
const shape = (path: string): string => path.replace(/\{[^}]+\}/g, '{}');

describe('API catalog', () => {
  it('has no duplicate endpoints', () => {
    const keys = CATALOG.map((c) => `${c.method} ${c.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every catalog pack reference exists, and its method/path match the pack', () => {
    for (const c of CATALOG.filter((x) => x.packId)) {
      const pack = PACKS.find((p) => p.id === c.packId);
      expect(pack, `${c.method} ${c.path} → ${c.packId}`).toBeDefined();
      expect(pack!.endpoint.method).toBe(c.method);
      expect(shape(normalizePackPath(pack!.endpoint.path))).toBe(shape(c.path));
      expect(pack!.moneyMoving).toBe(
        c.moneyMoving && c.kind === 'money' ? true : pack!.moneyMoving,
      );
      expect(pack!.realSideEffects).toBe(c.realSideEffects);
    }
  });

  it('every pack drives exactly one documented endpoint', () => {
    for (const p of PACKS) {
      const hit = CATALOG.filter((c) => c.packId === p.id);
      expect(hit, p.id).toHaveLength(1);
    }
  });

  it('flags every money-moving or real-effect endpoint as ready/caution only with a pack, never silently', () => {
    for (const c of CATALOG.filter((x) => x.kind === 'money' || x.realSideEffects)) {
      if (c.loadTest === 'ready' || c.loadTest === 'caution') expect(c.packId).toBeDefined();
    }
    const utility = CATALOG.find((c) => c.path === '/v1/utility-purchases' && c.method === 'POST')!;
    expect([utility.loadTest, utility.realSideEffects]).toEqual(['caution', true]);
  });

  it('excludes anything that reconfigures or pays out settlement money', () => {
    for (const path of [
      '/v1/settlement-policy',
      '/v1/settlements',
      '/v1/settlements/{id}/resettlements',
    ]) {
      const writes = CATALOG.filter((c) => c.path === path && c.method !== 'GET');
      expect(writes.length).toBeGreaterThan(0);
      for (const w of writes) expect(w.loadTest).toBe('excluded');
    }
  });

  it('summarises coverage', () => {
    const s = catalogSummary();
    expect(s.apiEndpoints).toBe(CATALOG.filter((c) => c.kind !== 'webhook').length);
    expect(s.withPack).toBe(PACKS.length);
    expect(Object.values(s.byStatus).reduce((a, b) => a + b, 0)).toBe(s.total);
  });
});
