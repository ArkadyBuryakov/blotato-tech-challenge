import { normalizeWebhook } from "@app/core";
import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ingestEvents } from "../engine/router";
import { HttpError, type AppContext } from "./app";

/**
 * Development/demo tools. Simulated events are built as real Meta webhook payloads and go
 * through the exact same normalize → inbox → router path as production webhooks.
 */
export const devRoutes =
  ({ cfg, deps, mock, requireUser }: AppContext): FastifyPluginAsync =>
  async (app) => {
    if (cfg.INSTAGRAM_MODE === "mock") {
      // Stand-in for instagram.com/oauth/authorize: immediately "approves" and redirects back.
      app.get("/api/dev/oauth/authorize", async (req, reply) => {
        const q = z.object({ redirect_uri: z.string().url(), state: z.string() }).parse(req.query);
        if (new URL(q.redirect_uri).origin !== new URL(cfg.BETTER_AUTH_URL).origin) throw new HttpError(400, "Bad redirect_uri");
        const url = new URL(q.redirect_uri);
        url.searchParams.set("code", `mock_code_${randomUUID()}`);
        url.searchParams.set("state", q.state);
        return reply.redirect(url.toString());
      });
    }

    app.post("/api/dev/simulate", async (req) => {
      const user = await requireUser(req);
      const body = z
        .discriminatedUnion("kind", [
          z.object({
            kind: z.literal("comment"),
            text: z.string().min(1),
            mediaId: z.string().min(1),
            fromId: z.string().min(1),
            username: z.string().default("commenter"),
          }),
          z.object({ kind: z.literal("message"), text: z.string().min(1), fromId: z.string().min(1) }),
        ])
        .parse(req.body);
      const now = Date.now();
      const entry =
        body.kind === "comment"
          ? {
              id: user.igAccountId,
              time: Math.floor(now / 1000),
              changes: [
                {
                  field: "comments",
                  value: { id: `sim_c_${randomUUID()}`, text: body.text, from: { id: body.fromId, username: body.username }, media: { id: body.mediaId } },
                },
              ],
            }
          : {
              id: user.igAccountId,
              time: Math.floor(now / 1000),
              messaging: [
                { sender: { id: body.fromId }, recipient: { id: user.igAccountId }, timestamp: now, message: { mid: `sim_m_${randomUUID()}`, text: body.text } },
              ],
            };
      const events = normalizeWebhook({ object: "instagram", entry: [entry] });
      mock?.observe(events); // the fake Instagram now "knows" this comment / DM
      return { events, ...(await ingestEvents(deps, events)) };
    });
  };
