import { z } from "zod";
import { defineBlock, templated } from "./define";

export const commentReply = defineBlock({
  type: "action.comment_reply",
  kind: "action",
  label: "Reply to comment",
  description: "Publicly replies to a comment.",
  config: z.object({}),
  inputs: z.object({ comment_id: templated("Comment"), message_text: templated("Message") }),
  outputs: ["comment_id", "message_text", "execution_status", "reply_id"],
  ports: ["out"],
  inputFields: [
    { key: "comment_id", label: "Comment id" },
    { key: "message_text", label: "Reply", multiline: true },
  ],
});
