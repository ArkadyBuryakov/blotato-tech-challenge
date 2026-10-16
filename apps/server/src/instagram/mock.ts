import type { InboundEvent } from "@app/core";
import { randomUUID } from "node:crypto";
import { MetaApiError, type InstagramApi, type Media } from "./client";

export const MOCK_ACCOUNT = { id: "17841400000000001", username: "demo.creator", name: "Demo Creator" };

/**
 * A stand-in for Instagram used in mock mode (local dev, simulator, tests).
 *
 * The app itself does not imitate Instagram's messaging rules; this fake does, so the engine
 * gets the same rejections it would get from the real Graph API:
 * - a DM by user id needs the user to have messaged the account in the last 24h;
 * - a private reply needs a known comment, at most 7 days old, and is allowed once per comment.
 *
 * It learns what "Instagram knows" (comments, inbound DMs) through `observe`, which the
 * simulator calls for every event it fabricates.
 */
export type MockInstagram = InstagramApi & { readonly observe: (events: readonly InboundEvent[]) => void };

const DAY = 24 * 3600_000;

// Shape of Graph API errors: (#10) is Instagram's "not allowed" for messaging.
const rejected = (message: string) => new MetaApiError(`(#10) ${message}`, false, 10);

export const createMockInstagramApi = (
  log: (msg: string, data: object) => void,
  now: () => Date = () => new Date(),
): MockInstagram => {
  const comments = new Map<string, { fromId: string; at: number }>();
  const lastInbound = new Map<string, number>();
  const privateReplied = new Set<string>();

  const media: Media[] = [1, 2, 3].map((i) => ({
    id: `1790000000000000${i}`,
    permalink: `https://www.instagram.com/p/MOCKPOST${i}/`,
    caption: ["Launch day 🚀 Comment 'pricing' for details", "Behind the scenes", "Q&A: ask me anything"][i - 1]!,
    thumbnailUrl: null,
    timestamp: new Date(Date.now() - i * DAY).toISOString(),
  }));

  return {
    observe: (events) => {
      for (const e of events) {
        if (e.kind === "comment") comments.set(e.commentId, { fromId: e.from.id, at: Date.parse(e.occurredAt) });
        else lastInbound.set(e.senderId, Math.max(lastInbound.get(e.senderId) ?? 0, Date.parse(e.occurredAt)));
      }
    },
    sendMessage: async (_t, recipient, text) => {
      // Lets tests and demos exercise the permanent-failure path.
      if (text.includes("[fail]")) throw new MetaApiError("Mock permanent failure", false, 100);
      const t = now().getTime();
      let recipientId: string;
      if ("comment_id" in recipient) {
        const c = comments.get(recipient.comment_id);
        if (!c) throw new MetaApiError("(#100) Invalid comment_id", false, 100);
        if (t - c.at > 7 * DAY) throw rejected("Private replies can only be sent within 7 days of the comment");
        if (privateReplied.has(recipient.comment_id)) throw rejected("A private reply has already been sent to this comment");
        privateReplied.add(recipient.comment_id);
        recipientId = c.fromId;
      } else {
        const last = lastInbound.get(recipient.id);
        if (!last || t - last > DAY) throw rejected("This message is sent outside of allowed window.");
        recipientId = recipient.id;
      }
      log("mock instagram: send message", { recipient, text });
      return { messageId: `mock_mid_${randomUUID()}`, recipientId };
    },
    replyToComment: async (_t, commentId, text) => {
      log("mock instagram: reply to comment", { commentId, text });
      return { replyId: `mock_reply_${randomUUID()}` };
    },
    listMedia: async () => media,
    listComments: async () => [],
    getUserProfile: async (_t, igsid) => ({ username: `user_${igsid.slice(-4)}`, name: `Mock User ${igsid.slice(-4)}` }),
    subscribeWebhooks: async () => log("mock instagram: subscribed webhooks", {}),
    refreshToken: async () => ({ accessToken: `mock_token_${randomUUID()}`, expiresAt: new Date(Date.now() + 60 * DAY) }),
  };
};
