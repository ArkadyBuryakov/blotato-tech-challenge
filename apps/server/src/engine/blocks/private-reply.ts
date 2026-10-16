import type { BlockHandler } from "./types";

/**
 * DM to a comment's author (`recipient: {comment_id}`). Instagram allows one per comment, within
 * 7 days; a rejection fails the step. `user_id` is who Instagram delivered it to.
 */
export const privateReplyHandler: BlockHandler<"action.private_reply", Record<string, never>, { commentId: string; text: string }> = {
  async start({ input }) {
    return { kind: "effect", plan: { commentId: input.comment_id ?? "", text: input.message_text ?? "" } };
  },
  async perform(deps, plan, run) {
    const r = await deps.ig.sendMessage(await deps.tokens.get(run.ig_account_id), { comment_id: plan.commentId }, plan.text);
    return { message_id: r.messageId, user_id: r.recipientId };
  },
};
