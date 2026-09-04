/**
 * Minimal per-run templating for JSON request bodies: deep-replaces the
 * literal placeholder `{{uuid}}` with a caller-supplied value. Nothing more
 * general is supported — this exists so a target's `requestBody` (or an
 * OAuth2 token endpoint's body) can carry a fresh idempotency key each check
 * without the executor mutating a static, stored value in place.
 */

const UUID_PLACEHOLDER = '{{uuid}}';

function walk(value: unknown, uuid: string): unknown {
  if (typeof value === 'string') {
    return value.includes(UUID_PLACEHOLDER) ? value.split(UUID_PLACEHOLDER).join(uuid) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, uuid));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = walk(v, uuid);
    }
    return out;
  }
  return value;
}

export function substituteUuid<T>(value: T, uuid: string): T {
  return walk(value, uuid) as T;
}
