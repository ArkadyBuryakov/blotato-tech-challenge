import { arr, defineEvent, iso, obj, str, type Obj } from "./define";

export type CommentEvent = {
  readonly kind: "comment";
  readonly accountId: string;
  readonly externalId: string;
  readonly commentId: string;
  readonly mediaId: string;
  readonly parentId: string | null;
  readonly text: string;
  readonly from: { readonly id: string; readonly username: string };
  readonly occurredAt: string;
};

const fromChange = (accountId: string, time: unknown, change: Obj): CommentEvent[] => {
  if (change.field !== "comments") return [];
  const v = obj(change.value);
  const from = obj(v.from);
  const commentId = str(v.id);
  const fromId = str(from.id);
  // Loop prevention: our own replies come back as comment webhooks.
  if (!commentId || !fromId || fromId === accountId) return [];
  return [
    {
      kind: "comment",
      accountId,
      externalId: `comment:${commentId}`,
      commentId,
      mediaId: str(obj(v.media).id),
      parentId: str(v.parent_id) || null,
      text: str(v.text),
      from: { id: fromId, username: str(from.username) },
      occurredAt: iso(time),
    },
  ];
};

export const commentEvent = defineEvent<CommentEvent>({
  kind: "comment",
  fromEntry: (entry, accountId) => arr(entry.changes).flatMap((c) => fromChange(accountId, entry.time, obj(c))),
  contactId: (e) => e.from.id,
});
