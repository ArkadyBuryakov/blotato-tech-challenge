import type { EventKind, EventOf, InboundEvent } from "@app/core";
import type { EngineDeps } from "./deps";

export type ContactProfile = { readonly username?: string; readonly name?: string };

type EventHandler<E> = {
  /** Best-effort profile of the event's contact, fetched outside any transaction. */
  readonly profile: (deps: EngineDeps, e: E) => Promise<ContactProfile | null>;
};

/**
 * Server-side behaviour of every event kind declared in @app/core; declaring a kind without
 * handling it here is a compile error.
 */
const eventHandlers = {
  comment: { profile: async (_deps, e) => ({ username: e.from.username }) },
  // Profile access is not guaranteed for every sender.
  message: {
    profile: (deps, e) =>
      deps.tokens
        .get(e.accountId)
        .then((t) => deps.ig.getUserProfile(t, e.senderId))
        .catch(() => null),
  },
} satisfies { [K in EventKind]: EventHandler<EventOf<K>> };

export const eventHandler = (kind: EventKind): EventHandler<InboundEvent> => eventHandlers[kind] as EventHandler<InboundEvent>;
