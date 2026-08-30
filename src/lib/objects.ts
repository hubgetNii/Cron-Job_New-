/**
 * Returns a shallow copy with every `undefined`-valued key removed, and a type
 * that reflects it — the result satisfies `exactOptionalPropertyTypes` targets
 * that zod's `.infer` (which adds an explicit `| undefined`) otherwise fails.
 */
export function pruneUndefined<T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: { [K in keyof T]?: Exclude<T[K], undefined> } = {};
  for (const key of Object.keys(obj) as Array<keyof T>) {
    const value = obj[key];
    if (value !== undefined) out[key] = value as Exclude<T[typeof key], undefined>;
  }
  return out;
}
