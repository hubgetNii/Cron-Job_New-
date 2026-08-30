import { getByPath } from '../../lib/json-path.js';
import type { ValidationRule } from '../../domain/target.js';

export interface RuleResult {
  rule: string;
  passed: boolean;
  detail?: string | undefined;
}

export interface ValidationOutcome {
  passed: boolean;
  results: RuleResult[];
}

export interface ResponseFacts {
  httpStatus: number;
  bodyText: string;
  /** Parsed JSON body, or undefined if the body was not JSON. */
  json: unknown;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function evaluate(rule: ValidationRule, facts: ResponseFacts): RuleResult {
  switch (rule.type) {
    case 'status': {
      const passed = facts.httpStatus === rule.equals;
      return {
        rule: `status == ${rule.equals}`,
        passed,
        detail: passed ? undefined : `got ${facts.httpStatus}`,
      };
    }
    case 'json_equals':
    case 'json_path_equals': {
      const lookup = getByPath(facts.json, rule.path);
      const passed = lookup.found && deepEqual(lookup.value, rule.equals);
      return {
        rule: `${rule.path} == ${JSON.stringify(rule.equals)}`,
        passed,
        detail: passed
          ? undefined
          : lookup.found
            ? `got ${JSON.stringify(lookup.value)}`
            : 'path not found',
      };
    }
    case 'contains': {
      const has = facts.bodyText.includes(rule.value);
      const passed = rule.negate ? !has : has;
      return {
        rule: `body ${rule.negate ? 'excludes' : 'contains'} "${rule.value}"`,
        passed,
      };
    }
    case 'numeric': {
      const lookup = getByPath(facts.json, rule.path);
      const n = typeof lookup.value === 'number' ? lookup.value : Number(lookup.value);
      let passed = false;
      if (lookup.found && !Number.isNaN(n)) {
        passed =
          rule.op === '<'
            ? n < rule.value
            : rule.op === '<='
              ? n <= rule.value
              : rule.op === '>'
                ? n > rule.value
                : rule.op === '>='
                  ? n >= rule.value
                  : n === rule.value;
      }
      return {
        rule: `${rule.path} ${rule.op} ${rule.value}`,
        passed,
        detail: passed
          ? undefined
          : lookup.found
            ? `got ${String(lookup.value)}`
            : 'path not found',
      };
    }
    case 'json_schema': {
      // Structural check only: every declared top-level key must be present.
      // A full JSON-schema validator is out of scope for v1 (spec calls it advanced).
      const obj = (facts.json ?? {}) as Record<string, unknown>;
      const missing = Object.keys(rule.schema).filter((k) => !(k in obj));
      return {
        rule: `body matches declared schema`,
        passed: missing.length === 0,
        detail: missing.length ? `missing keys: ${missing.join(', ')}` : undefined,
      };
    }
    case 'composite': {
      const sub = rule.rules.map((r) => evaluate(r, facts));
      const passed = rule.mode === 'all' ? sub.every((s) => s.passed) : sub.some((s) => s.passed);
      return {
        rule: `${rule.mode} of [${sub.map((s) => s.rule).join(', ')}]`,
        passed,
      };
    }
  }
}

/**
 * Runs a target's validation rule against the response. `HTTP 200` is never
 * healthy on its own — a target with no rule still requires the response to have
 * been received, which the caller has already established (see vault:
 * "Response Validation Rules").
 */
export function validateResponse(
  rule: ValidationRule | null,
  expectedStatus: number | null,
  facts: ResponseFacts,
): ValidationOutcome {
  const results: RuleResult[] = [];

  if (expectedStatus !== null) {
    results.push(evaluate({ type: 'status', equals: expectedStatus }, facts));
  }
  if (rule) {
    results.push(evaluate(rule, facts));
  }
  if (results.length === 0) {
    // No explicit expectation: treat a 2xx as the implicit contract.
    results.push({
      rule: 'status is 2xx (implicit)',
      passed: facts.httpStatus >= 200 && facts.httpStatus < 300,
      detail: undefined,
    });
  }

  return { passed: results.every((r) => r.passed), results };
}
