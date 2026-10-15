import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ZodError } from "zod";
import type { Auth } from "../auth";
import type { Config } from "../config";
import type { EngineDeps } from "../engine/deps";
import type { MockInstagram } from "../instagram/mock";
import { automationRoutes } from "./automations";
import { devRoutes } from "./dev";
import { runRoutes } from "./runs";
import { webhookRoutes } from "./webhooks";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export type SessionUser = { id: string; name: string; image: string | null; igAccountId: string; username: string };

export type AppContext = {
  readonly cfg: Config;
  readonly auth: Auth;
  readonly deps: EngineDeps;
  /** The fake Instagram in mock mode; the simulator tells it about the events it fabricates. */
  readonly mock?: MockInstagram;
  /** Resolves the signed-in user and their Instagram account, or throws 401. */
  readonly requireUser: (req: FastifyRequest) => Promise<SessionUser>;
};

const toHeaders = (req: FastifyRequest) => {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.append(k, Array.isArray(v) ? v.join(", ") : v);
  return headers;
};

export const buildApp = async (cfg: Config, auth: Auth, deps: EngineDeps, mock?: MockInstagram) => {
  const app = Fastify({ loggerInstance: deps.log, trustProxy: true, bodyLimit: 5 * 1024 * 1024 });

  // Keep the raw body: webhook signatures are computed over the exact bytes Meta sent.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    req.rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch {
      done(new HttpError(400, "Invalid JSON"), undefined);
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number; details?: unknown }, req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: "Invalid request", issues: err.issues });
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.status(status).send({ error: status >= 500 ? "Internal error" : err.message, details: err.details });
  });

  const requireUser = async (req: FastifyRequest): Promise<SessionUser> => {
    const session = await auth.api.getSession({ headers: toHeaders(req) });
    if (!session) throw new HttpError(401, "Not signed in");
    const account = await deps.db
      .selectFrom("account")
      .select("accountId")
      .where("userId", "=", session.user.id)
      .where("providerId", "=", "instagram")
      .executeTakeFirst();
    if (!account) throw new HttpError(403, "No Instagram account connected");
    const username = (session.user as { username?: string }).username ?? session.user.name;
    return { id: session.user.id, name: session.user.name, image: session.user.image ?? null, igAccountId: account.accountId, username };
  };

  // BetterAuth is a Fetch-API handler; bridge Fastify <-> Request/Response.
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const url = new URL(req.url, cfg.BETTER_AUTH_URL);
      const res = await auth.handler(
        new Request(url, { method: req.method, headers: toHeaders(req), body: req.method === "GET" ? undefined : (req.rawBody ?? undefined) }),
      );
      reply.status(res.status);
      res.headers.forEach((v, k) => k !== "set-cookie" && reply.header(k, v));
      const cookies = res.headers.getSetCookie();
      if (cookies.length) reply.header("set-cookie", cookies);
      return reply.send(res.body ? Buffer.from(await res.arrayBuffer()) : null);
    },
  });

  const ctx: AppContext = { cfg, auth, deps, mock, requireUser };

  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/config", async () => ({ devTools: cfg.ENABLE_DEV_TOOLS || cfg.INSTAGRAM_MODE === "mock", instagramMode: cfg.INSTAGRAM_MODE }));
  app.get("/api/me", async (req) => requireUser(req));
  await app.register(automationRoutes(ctx));
  await app.register(runRoutes(ctx));
  await app.register(webhookRoutes(ctx));
  if (cfg.ENABLE_DEV_TOOLS || cfg.INSTAGRAM_MODE === "mock") await app.register(devRoutes(ctx));

  // The Next.js static export is served from the same origin: no CORS, host-only cookies.
  const staticDir = resolve(process.cwd(), cfg.WEB_STATIC_DIR);
  if (existsSync(staticDir)) {
    await app.register(fastifyStatic, {
      root: staticDir,
      wildcard: false,
      setHeaders: (res, path) =>
        res.header("cache-control", path.includes("/_next/static/") ? "public, max-age=31536000, immutable" : "no-cache"),
    });
    app.get("/*", (req, reply) => {
      const path = req.url.split("?")[0]!;
      if (path.startsWith("/api/")) return reply.status(404).send({ error: "Not found" });
      // trailingSlash export: /automations/edit/ -> automations/edit/index.html
      const candidate = `${path.replace(/^\/+|\/+$/g, "")}/index.html`.replace(/^\//, "");
      return existsSync(resolve(staticDir, candidate)) ? reply.sendFile(candidate) : reply.status(404).sendFile("404.html");
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: "Not found" }));
  }

  return app;
};
