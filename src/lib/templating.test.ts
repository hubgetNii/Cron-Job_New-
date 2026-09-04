import { describe, expect, it } from 'vitest';
import { substituteUuid } from './templating.js';

describe('substituteUuid', () => {
  it('replaces the placeholder in a top-level string', () => {
    expect(substituteUuid('{{uuid}}', 'abc-123')).toBe('abc-123');
  });

  it('leaves strings without the placeholder untouched', () => {
    expect(substituteUuid('plain string', 'abc-123')).toBe('plain string');
  });

  it('deep-substitutes inside nested objects and arrays', () => {
    const input = {
      trackid: '{{uuid}}',
      amount: 0.1,
      tags: ['{{uuid}}', 'static'],
      nested: { id: '{{uuid}}' },
    };
    expect(substituteUuid(input, 'the-id')).toEqual({
      trackid: 'the-id',
      amount: 0.1,
      tags: ['the-id', 'static'],
      nested: { id: 'the-id' },
    });
  });

  it('substitutes a placeholder embedded within a larger string', () => {
    expect(substituteUuid('{"trackid":"{{uuid}}"}', 'xyz')).toBe('{"trackid":"xyz"}');
  });

  it('passes through non-string primitives and null unchanged', () => {
    expect(substituteUuid(42, 'id')).toBe(42);
    expect(substituteUuid(null, 'id')).toBeNull();
    expect(substituteUuid(true, 'id')).toBe(true);
  });
});
