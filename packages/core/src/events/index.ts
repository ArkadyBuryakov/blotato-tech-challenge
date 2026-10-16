import { registry } from "../registry";
import { commentEvent } from "./comment";
import { arr, obj, str, type EventSpec } from "./define";
import { messageEvent } from "./message";

export { defineEvent, type EventBase, type EventSpec } from "./define";
export type { CommentEvent } from "./comment";
export type { MessageEvent } from "./message";

/** Every event kind the app understands. Add a kind by declaring it and listing it here. */
export const eventSpecs = registry("kind", commentEvent, messageEvent);

export type EventKind = keyof typeof eventSpecs;
export type EventOf<K extends EventKind> = (typeof eventSpecs)[K] extends EventSpec<infer E> ? E : never;
export type InboundEvent = { [K in EventKind]: EventOf<K> }[EventKind];

/** Widened view of a spec, for code that dispatches on a runtime `kind`. */
export const eventSpec = (kind: EventKind): EventSpec<InboundEvent> => eventSpecs[kind] as EventSpec<InboundEvent>;

/** The Instagram user an event is about: used to correlate replies and to dedupe runs. */
export const eventContactId = (e: InboundEvent): string => eventSpec(e.kind).contactId(e);

export const normalizeWebhook = (body: unknown): readonly InboundEvent[] => {
  const root = obj(body);
  if (root.object !== "instagram") return [];
  return arr(root.entry).flatMap((e) => {
    const entry = obj(e);
    const accountId = str(entry.id);
    if (!accountId) return [];
    return Object.values(eventSpecs).flatMap((spec): readonly InboundEvent[] => spec.fromEntry(entry, accountId));
  });
};
