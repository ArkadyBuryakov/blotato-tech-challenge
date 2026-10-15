import { parseConfig, type GraphNode } from "./graph";
import { extractEmail, matchesKeywords, type CommentEvent, type InboundEvent, type MessageEvent } from "./events";

/**
 * Pure execution rules. The worker loads state, calls these, and persists the decision.
 * Keeping decisions pure makes the tricky parts (matching, messaging windows, wait semantics)
 * testable without Postgres or Meta.
 */

// ---------- triggers ----------

export const triggerMatches = (trigger: GraphNode, event: InboundEvent): boolean => {
  if (trigger.type === "trigger.comment" && event.kind === "comment") {
    const cfg = parseConfig("trigger.comment", trigger.config);
    const onPublication =
      cfg.publications.mode === "all" || cfg.publications.items.some((p) => p.mediaId === event.mediaId);
    return onPublication && matchesKeywords(event.text, cfg.keywords);
  }
  return trigger.type === "trigger.dm" && event.kind === "message";
};

export type UserData = { user_id: string; username: string; full_name: string };

export const commentTriggerOutput = (e: CommentEvent, user: Partial<UserData> = {}) => ({
  comment_data: { publication_id: e.mediaId, comment_id: e.commentId, comment_text: e.text },
  user_data: { user_id: e.from.id, username: e.from.username, full_name: user.full_name ?? "" },
});

export const dmTriggerOutput = (e: MessageEvent, user: Partial<UserData> = {}) => ({
  message_data: {
    user_id: e.senderId,
    message_id: e.messageId,
    message_type: e.messageType,
    message_payload: e.payload,
  },
  user_data: { user_id: e.senderId, username: user.username ?? "", full_name: user.full_name ?? "" },
});

/** The Instagram user a run is "about": used to correlate replies and to dedupe runs. */
export const eventContactId = (e: InboundEvent): string => (e.kind === "comment" ? e.from.id : e.senderId);

// ---------- wait for reply ----------

export type ReplyDecision =
  | { readonly kind: "accept"; readonly output: { message_id: string; message_text: string; email: string } }
  | { readonly kind: "retry"; readonly message: string }
  | { readonly kind: "ignore" };

export const evaluateReply = (
  waitNode: GraphNode,
  reply: MessageEvent,
  retriesUsed: number,
): ReplyDecision => {
  const cfg = parseConfig("control.wait_for_reply", waitNode.config);
  const email = extractEmail(reply.text);
  const output = { message_id: reply.messageId, message_text: reply.text, email: email ?? "" };
  if (cfg.expect === "any" || email) return { kind: "accept", output };
  // Invalid reply: re-ask while we have retries left, otherwise keep waiting silently until timeout.
  return cfg.retryMessage && retriesUsed < cfg.maxRetries
    ? { kind: "retry", message: cfg.retryMessage }
    : { kind: "ignore" };
};

export const waitTimeoutMs = (waitNode: GraphNode): number =>
  parseConfig("control.wait_for_reply", waitNode.config).timeoutHours * 3600_000;

// ---------- DM addressing ----------

export type Delivery =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "private_reply"; readonly commentId: string };

/**
 * How a "Send a DM" step addresses the recipient. Structural only: messaging windows and
 * per-comment limits are Instagram's to enforce, and its errors fail the step.
 * A commenter can only be reached through a private reply to their comment, so the first DM
 * to the commenter in a comment-triggered run is a private reply; later DMs use their user id.
 */
export const chooseDelivery = (args: {
  readonly userId: string;
  readonly sourceComment: { readonly commentId: string; readonly fromId: string } | null;
  readonly privateReplySentInRun: boolean;
}): Delivery =>
  args.sourceComment && args.sourceComment.fromId === args.userId && !args.privateReplySentInRun
    ? { kind: "private_reply", commentId: args.sourceComment.commentId }
    : { kind: "user", userId: args.userId };

// ---------- run status ----------

export const stepStatuses = [
  "pending",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "timed_out",
  "skipped",
] as const;
export type StepStatus = (typeof stepStatuses)[number];
export type RunStatus = "running" | "waiting" | "succeeded" | "failed";

const ACTIVE: readonly StepStatus[] = ["pending", "running"];

export const deriveRunStatus = (statuses: readonly StepStatus[]): RunStatus =>
  statuses.some((s) => ACTIVE.includes(s))
    ? "running"
    : statuses.includes("waiting")
      ? "waiting"
      : statuses.includes("failed")
        ? "failed"
        : "succeeded";

export const statusCounters = (statuses: readonly StepStatus[]): Partial<Record<StepStatus, number>> =>
  statuses.reduce<Partial<Record<StepStatus, number>>>((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {});
