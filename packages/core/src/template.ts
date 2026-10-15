/**
 * Minimal, side-effect-free templating: `{{nodeId.path.to.value}}`.
 * Deliberately not a full expression language: references only, no logic.
 */

const REF = /\{\{\s*([A-Za-z0-9_-]+)((?:\.[A-Za-z0-9_]+)+)\s*\}\}/g;

export type Ref = { readonly nodeId: string; readonly path: string };

export const extractRefs = (text: string): readonly Ref[] =>
  [...text.matchAll(REF)].map((m) => ({ nodeId: m[1]!, path: m[2]!.slice(1) }));

export const getPath = (value: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (acc, key) =>
        acc !== null && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined,
      value,
    );

const stringify = (v: unknown): string =>
  v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v);

/** Scope maps node ids to that node's output object. */
export type Scope = Readonly<Record<string, unknown>>;

export const renderTemplate = (text: string, scope: Scope): string =>
  text.replace(REF, (_, nodeId: string, path: string) =>
    stringify(getPath(scope[nodeId], path.slice(1))),
  );

export const renderInputs = (
  inputs: Readonly<Record<string, string>>,
  scope: Scope,
): Record<string, string> =>
  Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, renderTemplate(v, scope)]));

/** Template parameters (`[[param]]`) used by automation templates, filled at instantiation. */
const PARAM = /\[\[\s*([A-Za-z0-9_]+)\s*\]\]/g;

export const fillParams = <T>(value: T, params: Readonly<Record<string, unknown>>): T => {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const whole = v.match(/^\[\[\s*([A-Za-z0-9_]+)\s*\]\]$/);
      // A string that is exactly one param is replaced by the raw value (keeps arrays/objects).
      if (whole) return params[whole[1]!];
      return v.replace(PARAM, (_, k: string) => stringify(params[k]));
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
};
