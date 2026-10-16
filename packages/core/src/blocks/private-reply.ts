import { z } from "zod";
import { defineBlock, templated } from "./define";

export const privateReply = defineBlock({
  type: "action.private_reply",
  kind: "action",
  label: "Private reply",
  description:
    "Sends a DM to the author of a comment, the only way to reach someone who has not messaged you. Once per comment, within 7 days.",
  config: z.object({}),
  inputs: z.object({ comment_id: templated("Comment"), message_text: templated("Message") }),
  outputs: ["comment_id", "message_text", "execution_status", "message_id", "user_id"],
  ports: ["out"],
  inputFields: [
    { key: "comment_id", label: "Comment id" },
    { key: "message_text", label: "Message", multiline: true },
  ],
});
