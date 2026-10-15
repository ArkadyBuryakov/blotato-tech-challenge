/**
 * Normalization of Meta (Instagram) webhook payloads into domain events.
 * Pure: no I/O, so the whole ingress mapping is unit-testable with captured payloads.
 */

export type CommentEvent = {
  readonly kind: "comment";
  readonly accountId: string;
  /** Dedupe key: Meta retries deliveries and may batch duplicates. */
  readonly externalId: string;
  readonly commentId: string;
  readonly mediaId: string;
  readonly parentId: string | null;
  readonly text: string;
  readonly from: { readonly id: string; readonly username: string };
  readonly occurredAt: string;
};

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

export type InboundEvent = CommentEvent | MessageEvent;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v !== null && typeof v === "object" ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const iso = (seconds: unknown): string => {
  const n = Number(seconds);
  // Messaging timestamps are in ms, entry.time is in seconds.
  return Number.isFinite(n) && n > 0 ? new Date(n > 1e12 ? n : n * 1000).toISOString() : new Date().toISOString();
};

const commentFromChange = (accountId: string, time: unknown, change: Obj): CommentEvent[] => {
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

const messageFromMessaging = (accountId: string, m: Obj): MessageEvent[] => {
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

export const normalizeWebhook = (body: unknown): readonly InboundEvent[] => {
  const root = obj(body);
  if (root.object !== "instagram") return [];
  return arr(root.entry).flatMap((e) => {
    const entry = obj(e);
    const accountId = str(entry.id);
    if (!accountId) return [];
    return [
      ...arr(entry.changes).flatMap((c) => commentFromChange(accountId, entry.time, obj(c))),
      ...arr(entry.messaging).flatMap((m) => messageFromMessaging(accountId, obj(m))),
    ];
  });
};

// ---------- matching ----------

const normalize = (s: string) => s.normalize("NFKC").toLowerCase().trim();

/** Whole-word (or whole-phrase), case-insensitive. Empty keyword list matches everything. */
export const matchesKeywords = (text: string, keywords: readonly string[]): boolean => {
  if (keywords.length === 0) return true;
  const t = normalize(text);
  return keywords.some((k) => {
    const kw = normalize(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return kw.length > 0 && new RegExp(`(^|[^\\p{L}\\p{N}])${kw}($|[^\\p{L}\\p{N}])`, "u").test(t);
  });
};

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
export const extractEmail = (text: string): string | null => text.match(EMAIL)?.[0]?.toLowerCase() ?? null;
