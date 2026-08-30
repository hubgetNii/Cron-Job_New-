/**
 * Minimal JSON accessor for validation rules. Supports dotted paths with an
 * optional leading `$.`, and bracketed array indices:
 *   `data.status`   ·   `$.data.balance.currency`   ·   `items[0].id`
 * This is deliberately not a full JSONPath implementation — the spec's
 * validation rules only need direct field access.
 */

const SEGMENT = /[^.[\]]+/g;

export function parsePath(path: string): string[] {
  const trimmed = path.startsWith('$.')
    ? path.slice(2)
    : path.startsWith('$')
      ? path.slice(1)
      : path;
  return trimmed.match(SEGMENT) ?? [];
}

export interface PathLookup {
  found: boolean;
  value: unknown;
}

export function getByPath(root: unknown, path: string): PathLookup {
  let current: unknown = root;
  for (const segment of parsePath(path)) {
    if (current === null || current === undefined) return { found: false, value: undefined };
    if (Array.isArray(current)) {
      const idx = Number.parseInt(segment, 10);
      if (Number.isNaN(idx) || idx < 0 || idx >= current.length)
        return { found: false, value: undefined };
      current = current[idx];
      continue;
    }
    if (typeof current === 'object') {
      const obj = current as Record<string, unknown>;
      if (!(segment in obj)) return { found: false, value: undefined };
      current = obj[segment];
      continue;
    }
    return { found: false, value: undefined };
  }
  return { found: true, value: current };
}
