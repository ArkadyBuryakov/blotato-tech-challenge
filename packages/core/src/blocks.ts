import { z } from "zod";

/**
 * Block catalog: the single source of truth for what an automation graph can contain.
 * Shared by the API (validation), the worker (execution) and the web app (editor UI).
 *
 * - `config` holds static values (triggers may only have static config).
 * - `inputs` are templated strings (`{{nodeId.path}}`) resolved at run time from upstream outputs.
 * - `outputs` lists the variables a block exposes to downstream blocks.
 * - `ports` are the named outgoing connection points (most blocks have a single `out`).
 */

export const publicationsSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }),
  z.object({
    mode: z.literal("list"),
    items: z
      .array(z.object({ mediaId: z.string().min(1), url: z.string().url() }))
      .min(1, "Select at least one publication"),
  }),
]);
export type Publications = z.infer<typeof publicationsSchema>;

const keywordsSchema = z.array(z.string().trim().min(1)).default([]);

const templated = (label: string) => z.string().trim().min(1, `${label} is required`);

export const blockSchemas = {
  "trigger.comment": {
    config: z.object({ publications: publicationsSchema, keywords: keywordsSchema }),
    inputs: z.object({}),
  },
  "trigger.dm": {
    config: z.object({}),
    inputs: z.object({}),
  },
  "action.send_dm": {
    config: z.object({}),
    inputs: z.object({ user_id: templated("User"), message_text: templated("Message") }),
  },
  "action.comment_reply": {
    config: z.object({}),
    inputs: z.object({ comment_id: templated("Comment"), message_text: templated("Message") }),
  },
  "control.wait_for_reply": {
    config: z.object({
      expect: z.enum(["any", "email"]).default("any"),
      timeoutHours: z.number().positive().max(24 * 7).default(23),
      retryMessage: z.string().trim().default(""),
      maxRetries: z.number().int().min(0).max(5).default(2),
    }),
    inputs: z.object({ user_id: templated("User") }),
  },
} as const;

export type BlockType = keyof typeof blockSchemas;
export const blockTypes = Object.keys(blockSchemas) as BlockType[];
export type BlockKind = "trigger" | "action" | "control";

export type BlockDefinition = {
  readonly type: BlockType;
  readonly kind: BlockKind;
  readonly label: string;
  readonly description: string;
  /** Output variable paths available to downstream blocks. */
  readonly outputs: readonly string[];
  readonly ports: readonly string[];
  /** Input fields shown in the editor (templated strings). */
  readonly inputFields: readonly { key: string; label: string; multiline?: boolean }[];
};

const userData = ["user_data.user_id", "user_data.username", "user_data.full_name"];

export const blockCatalog: Readonly<Record<BlockType, BlockDefinition>> = {
  "trigger.comment": {
    type: "trigger.comment",
    kind: "trigger",
    label: "New comment",
    description: "Someone comments on one of your publications.",
    outputs: [
      "comment_data.publication_id",
      "comment_data.comment_id",
      "comment_data.comment_text",
      ...userData,
    ],
    ports: ["out"],
    inputFields: [],
  },
  "trigger.dm": {
    type: "trigger.dm",
    kind: "trigger",
    label: "New DM",
    description: "Someone sends you a direct message.",
    outputs: [
      "message_data.user_id",
      "message_data.message_id",
      "message_data.message_type",
      "message_data.message_payload",
      ...userData,
    ],
    ports: ["out"],
    inputFields: [],
  },
  "action.send_dm": {
    type: "action.send_dm",
    kind: "action",
    label: "Send a DM",
    description:
      "Sends a direct message. The first DM to the commenter in a comment-triggered run is a private reply to their comment.",
    outputs: ["user_id", "message_text", "execution_status", "message_id"],
    ports: ["out"],
    inputFields: [
      { key: "user_id", label: "Recipient user id" },
      { key: "message_text", label: "Message", multiline: true },
    ],
  },
  "action.comment_reply": {
    type: "action.comment_reply",
    kind: "action",
    label: "Reply to comment",
    description: "Publicly replies to a comment.",
    outputs: ["comment_id", "message_text", "execution_status", "reply_id"],
    ports: ["out"],
    inputFields: [
      { key: "comment_id", label: "Comment id" },
      { key: "message_text", label: "Reply", multiline: true },
    ],
  },
  "control.wait_for_reply": {
    type: "control.wait_for_reply",
    kind: "control",
    label: "Wait for reply",
    description:
      "Pauses the run until the user replies by DM. Optionally requires an email and re-asks on invalid replies.",
    outputs: ["message_id", "message_text", "email"],
    ports: ["received", "timeout"],
    inputFields: [{ key: "user_id", label: "Wait for user id" }],
  },
};

export const isBlockType = (t: string): t is BlockType => t in blockSchemas;
export const isTriggerType = (t: string): boolean =>
  isBlockType(t) && blockCatalog[t].kind === "trigger";
