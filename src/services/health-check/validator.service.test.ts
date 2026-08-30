import { describe, expect, it } from 'vitest';
import { validateResponse, type ResponseFacts } from './validator.service.js';
import type { ValidationRule } from '../../domain/target.js';

function facts(over: Partial<ResponseFacts> = {}): ResponseFacts {
  const bodyText = over.bodyText ?? '{"data":{"status":"SUCCESS","latency_ms":120}}';
  let json: unknown = over.json;
  if (json === undefined) {
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = undefined;
    }
  }
  return { httpStatus: over.httpStatus ?? 200, bodyText, json };
}

describe('validateResponse', () => {
  it('treats a bare 200 with no rule as the implicit contract', () => {
    expect(validateResponse(null, null, facts({ httpStatus: 204 })).passed).toBe(true);
    expect(validateResponse(null, null, facts({ httpStatus: 500 })).passed).toBe(false);
  });

  it('checks an explicit expected status', () => {
    expect(validateResponse(null, 201, facts({ httpStatus: 200 })).passed).toBe(false);
    expect(validateResponse(null, 200, facts({ httpStatus: 200 })).passed).toBe(true);
  });

  it('json field equality', () => {
    const rule: ValidationRule = { type: 'json_equals', path: 'data.status', equals: 'SUCCESS' };
    expect(validateResponse(rule, null, facts()).passed).toBe(true);
    expect(
      validateResponse(rule, null, facts({ bodyText: '{"data":{"status":"FAILED"}}' })).passed,
    ).toBe(false);
  });

  it('numeric threshold', () => {
    const rule: ValidationRule = { type: 'numeric', path: 'data.latency_ms', op: '<', value: 2000 };
    expect(validateResponse(rule, null, facts()).passed).toBe(true);
    expect(
      validateResponse(rule, null, facts({ bodyText: '{"data":{"latency_ms":5000}}' })).passed,
    ).toBe(false);
  });

  it('contains / not-contains', () => {
    expect(
      validateResponse({ type: 'contains', value: 'ERROR', negate: true }, null, facts()).passed,
    ).toBe(true);
    expect(
      validateResponse(
        { type: 'contains', value: 'ERROR', negate: true },
        null,
        facts({ bodyText: 'internal ERROR occurred' }),
      ).passed,
    ).toBe(false);
  });

  it('json schema (structural key presence)', () => {
    const rule: ValidationRule = { type: 'json_schema', schema: { data: {}, meta: {} } };
    expect(validateResponse(rule, null, facts()).passed).toBe(false); // no meta
    expect(validateResponse(rule, null, facts({ bodyText: '{"data":1,"meta":2}' })).passed).toBe(
      true,
    );
  });

  it('composite all / any', () => {
    const all: ValidationRule = {
      type: 'composite',
      mode: 'all',
      rules: [
        { type: 'json_equals', path: 'data.status', equals: 'SUCCESS' },
        { type: 'numeric', path: 'data.latency_ms', op: '<', value: 2000 },
      ],
    };
    expect(validateResponse(all, 200, facts()).passed).toBe(true);

    const any: ValidationRule = {
      type: 'composite',
      mode: 'any',
      rules: [
        { type: 'json_equals', path: 'data.status', equals: 'NOPE' },
        { type: 'json_equals', path: 'data.status', equals: 'SUCCESS' },
      ],
    };
    expect(validateResponse(any, null, facts()).passed).toBe(true);
  });

  it('reports which rule failed', () => {
    const rule: ValidationRule = { type: 'json_equals', path: 'data.status', equals: 'PENDING' };
    const outcome = validateResponse(rule, null, facts());
    expect(outcome.passed).toBe(false);
    expect(outcome.results.at(-1)?.detail).toMatch(/SUCCESS/);
  });
});
