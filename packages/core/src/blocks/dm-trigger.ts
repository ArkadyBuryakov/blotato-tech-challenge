import { z } from "zod";
import { defineBlock, userDataOutputs } from "./define";

export const dmTrigger = defineBlock({
  type: "trigger.dm",
  kind: "trigger",
  label: "New DM",
  description: "Someone sends you a direct message.",
  config: z.object({}),
  inputs: z.object({}),
  outputs: [
    "message_data.user_id",
    "message_data.message_id",
    "message_data.message_type",
    "message_data.message_payload",
    ...userDataOutputs,
  ],
  ports: ["out"],
  inputFields: [],
  trigger: {
    on: "message",
    matches: () => true,
    output: (e, user) => ({
      message_data: { user_id: e.senderId, message_id: e.messageId, message_type: e.messageType, message_payload: e.payload },
      user_data: { user_id: e.senderId, username: user.username ?? "", full_name: user.full_name ?? "" },
    }),
  },
});
