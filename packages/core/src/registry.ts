/**
 * Declarative registries: declarations are listed once and indexed by their own key field, so
 * the key union (e.g. `BlockType`) is derived from what is declared, never maintained by hand.
 */
export const registry = <F extends string, const T extends readonly Readonly<Record<F, string>>[]>(field: F, ...items: T) => {
  const entries = items.map((i) => [i[field], i] as const);
  if (new Set(entries.map(([k]) => k)).size !== entries.length) throw new Error(`Duplicate ${field} in registry`);
  return Object.fromEntries(entries) as { readonly [I in T[number] as I[F]]: I };
};
