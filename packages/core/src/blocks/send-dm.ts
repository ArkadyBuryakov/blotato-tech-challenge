import { z } from "zod";
import { defineBlock, templated } from "./define";

export const sendDm = defineBlock({
  type: "action.send_dm",
  kind: "action",
  label: "Send a DM",
  description:
    "Sends a direct message. The first DM to the commenter in a comment-triggered run is a private reply to their comment.",
  config: z.object({}),
  inputs: z.object({ user_id: templated("User"), message_text: templated("Message") }),
  outputs: ["user_id", "message_text", "execution_status", "message_id"],
  ports: ["out"],
  inputFields: [
    { key: "user_id", label: "Recipient user id" },
    { key: "message_text", label: "Message", multiline: true },
  ],
});

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
