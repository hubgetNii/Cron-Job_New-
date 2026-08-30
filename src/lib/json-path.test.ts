import { describe, expect, it } from 'vitest';
import { getByPath, parsePath } from './json-path.js';

describe('parsePath', () => {
  it('strips a leading $. and splits on dots and brackets', () => {
    expect(parsePath('$.data.status')).toEqual(['data', 'status']);
    expect(parsePath('data.balance.currency')).toEqual(['data', 'balance', 'currency']);
    expect(parsePath('items[0].id')).toEqual(['items', '0', 'id']);
  });
});

describe('getByPath', () => {
  const doc = {
    data: { status: 'SUCCESS', balance: { currency: 'USD', amount: 12.5 } },
    items: [{ id: 'a' }, { id: 'b' }],
  };

  it('reads nested values', () => {
    expect(getByPath(doc, 'data.status')).toEqual({ found: true, value: 'SUCCESS' });
    expect(getByPath(doc, '$.data.balance.currency')).toEqual({ found: true, value: 'USD' });
    expect(getByPath(doc, 'items[1].id')).toEqual({ found: true, value: 'b' });
  });

  it('reports missing paths', () => {
    expect(getByPath(doc, 'data.missing')).toEqual({ found: false, value: undefined });
    expect(getByPath(doc, 'items[9].id')).toEqual({ found: false, value: undefined });
    expect(getByPath(undefined, 'a.b')).toEqual({ found: false, value: undefined });
  });
});
