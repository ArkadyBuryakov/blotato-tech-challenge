import type { BlockHandler } from "./types";

export const commentReplyHandler: BlockHandler<"action.comment_reply", Record<string, never>, { commentId: string; text: string }> = {
  async start({ input }) {
    return { kind: "effect", plan: { commentId: input.comment_id ?? "", text: input.message_text ?? "" } };
  },
  async perform(deps, plan, run) {
    const r = await deps.ig.replyToComment(await deps.tokens.get(run.ig_account_id), plan.commentId, plan.text);
    return { reply_id: r.replyId };
  },
};
