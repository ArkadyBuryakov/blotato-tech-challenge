import { z } from "zod";
import { matchesKeywords } from "../text";
import { defineBlock, userDataOutputs } from "./define";

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

export const commentTrigger = defineBlock({
  type: "trigger.comment",
  kind: "trigger",
  label: "New comment",
  description: "Someone comments on one of your publications.",
  config: z.object({ publications: publicationsSchema, keywords: z.array(z.string().trim().min(1)).default([]) }),
  inputs: z.object({}),
  defaultConfig: { publications: { mode: "all" } },
  outputs: ["comment_data.publication_id", "comment_data.comment_id", "comment_data.comment_text", ...userDataOutputs],
  ports: ["out"],
  inputFields: [],
  trigger: {
    on: "comment",
    matches: (cfg, e) =>
      (cfg.publications.mode === "all" || cfg.publications.items.some((p) => p.mediaId === e.mediaId)) &&
      matchesKeywords(e.text, cfg.keywords),
    output: (e, user) => ({
      comment_data: { publication_id: e.mediaId, comment_id: e.commentId, comment_text: e.text },
      user_data: { user_id: e.from.id, username: e.from.username, full_name: user.full_name ?? "" },
    }),
  },
});
