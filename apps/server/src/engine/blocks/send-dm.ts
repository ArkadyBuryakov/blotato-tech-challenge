import type { BlockHandler } from "./types";

/** Whether Instagram accepts the DM (24h window) is its call; a rejection fails the step. */
export const sendDmHandler: BlockHandler<"action.send_dm", Record<string, never>, { userId: string; text: string }> = {
  async start({ input }) {
    return { kind: "effect", plan: { userId: input.user_id ?? "", text: input.message_text ?? "" } };
  },
  async perform(deps, plan, run) {
    const r = await deps.ig.sendMessage(await deps.tokens.get(run.ig_account_id), { id: plan.userId }, plan.text);
    return { message_id: r.messageId };
  },
};
