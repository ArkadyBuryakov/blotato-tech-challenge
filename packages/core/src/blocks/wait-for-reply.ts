import { z } from "zod";
import type { MessageEvent } from "../events";
import { extractEmail } from "../text";
import { defineBlock, templated } from "./define";

export const waitForReply = defineBlock({
  type: "control.wait_for_reply",
  kind: "control",
  label: "Wait for reply",
  description:
    "Pauses the run until the user replies by DM. Optionally requires an email and re-asks on invalid replies.",
  config: z.object({
    expect: z.enum(["any", "email"]).default("any"),
    timeoutHours: z.number().positive().max(24 * 7).default(23),
    retryMessage: z.string().trim().default(""),
    maxRetries: z.number().int().min(0).max(5).default(2),
  }),
  inputs: z.object({ user_id: templated("User") }),
  outputs: ["message_id", "message_text", "email"],
  ports: ["received", "timeout"],
  inputFields: [{ key: "user_id", label: "Wait for user id" }],
});

export type WaitConfig = z.output<typeof waitForReply.config>;

export type ReplyDecision =
  | { readonly kind: "accept"; readonly output: { message_id: string; message_text: string; email: string } }
  | { readonly kind: "retry"; readonly message: string }
  | { readonly kind: "ignore" };

export const evaluateReply = (cfg: WaitConfig, reply: MessageEvent, retriesUsed: number): ReplyDecision => {
  const email = extractEmail(reply.text);
  const output = { message_id: reply.messageId, message_text: reply.text, email: email ?? "" };
  if (cfg.expect === "any" || email) return { kind: "accept", output };
  // Invalid reply: re-ask while we have retries left, otherwise keep waiting silently until timeout.
  return cfg.retryMessage && retriesUsed < cfg.maxRetries
    ? { kind: "retry", message: cfg.retryMessage }
    : { kind: "ignore" };
};

export const waitTimeoutMs = (cfg: WaitConfig): number => cfg.timeoutHours * 3600_000;
