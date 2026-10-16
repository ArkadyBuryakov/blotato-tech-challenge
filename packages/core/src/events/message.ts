import { arr, defineEvent, iso, obj, str, type Obj } from "./define";

export type MessageEvent = {
  readonly kind: "message";
  readonly accountId: string;
  readonly externalId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly text: string;
  readonly messageType: "text" | "attachment" | "other";
  readonly payload: unknown;
  readonly occurredAt: string;
};

const fromMessaging = (accountId: string, m: Obj): MessageEvent[] => {
  const message = obj(m.message);
  const mid = str(message.mid);
  const senderId = str(obj(m.sender).id);
  // Loop prevention: echoes of messages we sent, and deleted/unsupported messages.
  if (!mid || message.is_echo === true || message.is_deleted === true || senderId === accountId) return [];
  const attachments = arr(message.attachments);
  const text = str(message.text);
  return [
    {
      kind: "message",
      accountId,
      externalId: `message:${mid}`,
      messageId: mid,
      senderId,
      text,
      messageType: text ? "text" : attachments.length > 0 ? "attachment" : "other",
      payload: text ? { text } : { attachments },
      occurredAt: iso(m.timestamp),
    },
  ];
};

export const messageEvent = defineEvent<MessageEvent>({
  kind: "message",
  fromEntry: (entry, accountId) => arr(entry.messaging).flatMap((m) => fromMessaging(accountId, obj(m))),
  contactId: (e) => e.senderId,
});
