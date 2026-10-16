/**
 * Event kinds are declared, not hardcoded: each one says how to extract itself from a Meta
 * webhook entry and who it is about. Normalization, contact bookkeeping, trigger matching and
 * resuming suspended steps all go through these declarations.
 * Pure: no I/O, so the whole ingress mapping is unit-testable with captured payloads.
 */

export type EventBase<K extends string = string> = {
  readonly kind: K;
  readonly accountId: string;
  /** Dedupe key: Meta retries deliveries and may batch duplicates. */
  readonly externalId: string;
  readonly occurredAt: string;
};

export type EventSpec<E extends EventBase> = {
  readonly kind: E["kind"];
  /** Events of this kind in one webhook `entry` (loop prevention included). */
  readonly fromEntry: (entry: Obj, accountId: string) => readonly E[];
  /** The Instagram user the event is about: keys contacts and runs, correlates replies. */
  readonly contactId: (e: E) => string;
};

export const defineEvent = <E extends EventBase>(spec: EventSpec<E>): EventSpec<E> => spec;

// ---------- payload parsing helpers ----------

export type Obj = Record<string, unknown>;
export const obj = (v: unknown): Obj => (v !== null && typeof v === "object" ? (v as Obj) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
export const iso = (seconds: unknown): string => {
  const n = Number(seconds);
  // Messaging timestamps are in ms, entry.time is in seconds.
  return Number.isFinite(n) && n > 0 ? new Date(n > 1e12 ? n : n * 1000).toISOString() : new Date().toISOString();
};
