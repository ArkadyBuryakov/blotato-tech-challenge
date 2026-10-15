import { normalizeWebhook } from "@app/core";
import type { FastifyPluginAsync } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { ingestEvents } from "../engine/router";
import type { AppContext } from "./app";

export const verifySignature = (secret: string, rawBody: string, header: string | undefined): boolean => {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
};

/**
 * Webhook ingress does the minimum: verify, normalize, dedupe-insert into the inbox, enqueue.
 * No matching or Graph API calls in the request, so Meta gets a fast 200 and never times out.
 */
export const webhookRoutes =
  ({ cfg, deps }: AppContext): FastifyPluginAsync =>
  async (app) => {
    // Subscription handshake.
    app.get<{ Querystring: Record<string, string> }>("/api/webhooks/instagram", async (req, reply) => {
      const q = req.query;
      if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === cfg.META_WEBHOOK_VERIFY_TOKEN)
        return reply.type("text/plain").send(q["hub.challenge"]);
      return reply.status(403).send({ error: "Verification failed" });
    });

    app.post("/api/webhooks/instagram", async (req, reply) => {
      const secret = cfg.INSTAGRAM_APP_SECRET;
      if (secret || cfg.INSTAGRAM_MODE === "live") {
        if (!verifySignature(secret, req.rawBody ?? "", req.headers["x-hub-signature-256"] as string | undefined)) {
          req.log.warn("webhook signature mismatch");
          return reply.status(401).send({ error: "Invalid signature" });
        }
      }
      const events = normalizeWebhook(req.body);
      const result = await ingestEvents(deps, events);
      req.log.info({ ...result }, "webhook ingested");
      return reply.status(200).send({ ok: true });
    });
  };
