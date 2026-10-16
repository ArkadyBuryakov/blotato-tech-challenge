import { chooseDelivery, type Delivery } from "@app/core";
import { sql } from "kysely";
import type { Tx } from "../../db/client";
import type { Recipient } from "../../instagram/client";
import type { BlockHandler, Run } from "./types";

/**
 * Address a DM: private reply to the triggering comment, or the user id (see chooseDelivery).
 * Whether Instagram accepts it (24h window, one private reply per comment, ...) is Instagram's
 * call; a rejection fails the step with Instagram's error. Caller holds the run lock, so
 * parallel branches of one run see each other's choice.
 */
const decideDelivery = async (trx: Tx, run: Run, nodeId: string, userId: string): Promise<Delivery> => {
  const trigger = await trx.selectFrom("inbox_events").select("payload").where("id", "=", run.trigger_event_id).executeTakeFirstOrThrow();
  const comment = trigger.payload.kind === "comment" ? trigger.payload : null;
  const earlier = await trx
    .selectFrom("run_steps")
    .select("node_id")
    .where("run_id", "=", run.id)
    .where("node_id", "!=", nodeId)
    .where("status", "in", ["running", "succeeded"])
    .where(sql<string>`input->>'delivery'`, "=", "private_reply")
    .executeTakeFirst();
  return chooseDelivery({
    userId,
    sourceComment: comment ? { commentId: comment.commentId, fromId: comment.from.id } : null,
    privateReplySentInRun: !!earlier,
  });
};

export const sendDmHandler: BlockHandler<"action.send_dm", Record<string, never>, { recipient: Recipient; text: string }> = {
  async start({ trx, run, node, input }) {
    const delivery = await decideDelivery(trx, run, node.id, input.user_id ?? "");
    // Recorded with the input: shows how the DM was addressed, and lets later steps see it.
    input.delivery = delivery.kind;
    const recipient = delivery.kind === "user" ? { id: delivery.userId } : { comment_id: delivery.commentId };
    return { kind: "effect", plan: { recipient, text: input.message_text ?? "" } };
  },
  async perform(deps, plan, run) {
    const r = await deps.ig.sendMessage(await deps.tokens.get(run.ig_account_id), plan.recipient, plan.text);
    return { message_id: r.messageId };
  },
};
