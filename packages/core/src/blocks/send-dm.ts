import { z } from "zod";
import { defineBlock, templated } from "./define";

export const sendDm = defineBlock({
  type: "action.send_dm",
  kind: "action",
  label: "Send a DM",
  description: "Sends a direct message to a user. Instagram only allows it if they messaged you in the last 24h.",
  config: z.object({}),
  inputs: z.object({ user_id: templated("User"), message_text: templated("Message") }),
  outputs: ["user_id", "message_text", "execution_status", "message_id"],
  ports: ["out"],
  inputFields: [
    { key: "user_id", label: "Recipient user id" },
    { key: "message_text", label: "Message", multiline: true },
  ],
});
