import {
  automationTemplates,
  findTemplate,
  graphSchema,
  instantiateTemplate,
  templateParamIssues,
  validateGraph,
  type Graph,
} from "@app/core";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import type { DB } from "../db/client";
import { HttpError, type AppContext, type SessionUser } from "./app";

const idParams = z.object({ id: z.string().uuid() });

const defaultGraph: Graph = {
  nodes: [
    { id: "trigger", type: "trigger.comment", position: { x: 0, y: 0 }, config: { publications: { mode: "all" }, keywords: [] }, inputs: {} },
  ],
  edges: [],
};

const assertValid = (graph: Graph) => {
  const issues = validateGraph(graph);
  if (issues.length) throw new HttpError(422, "Automation is not valid", { issues });
};

const ownAutomation = async (db: DB, user: SessionUser, id: string) => {
  const a = await db.selectFrom("automations").selectAll().where("id", "=", id).where("user_id", "=", user.id).executeTakeFirst();
  if (!a) throw new HttpError(404, "Automation not found");
  return a;
};

/** Creates an automation and its first version atomically. */
const createAutomation = (db: DB, user: SessionUser, name: string, graph: Graph, activate: boolean) =>
  db.transaction().execute(async (trx) => {
    const a = await trx
      .insertInto("automations")
      .values({ user_id: user.id, ig_account_id: user.igAccountId, name, status: activate ? "active" : "disabled" })
      .returningAll()
      .executeTakeFirstOrThrow();
    const v = await trx
      .insertInto("automation_versions")
      .values({ automation_id: a.id, version: 1, graph })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    await trx.updateTable("automations").set({ active_version_id: v.id }).where("id", "=", a.id).execute();
    return { ...a, active_version_id: v.id };
  });

export const automationRoutes =
  ({ deps, requireUser }: AppContext): FastifyPluginAsync =>
  async (app) => {
    const { db } = deps;

    app.get("/api/automations", async (req) => {
      const user = await requireUser(req);
      const { archived } = z.object({ archived: z.enum(["true", "false"]).default("false").transform((v) => v === "true") }).parse(req.query);
      return db
        .selectFrom("automations as a")
        .leftJoin("automation_versions as v", "v.id", "a.active_version_id")
        .select([
          "a.id", "a.name", "a.status", "a.active_version_id", "a.created_at", "a.updated_at", "v.version as active_version",
          sql<string | null>`v.graph->'nodes'->0->>'type'`.as("trigger_type"),
          (eb) => eb.selectFrom("runs").select(eb.fn.countAll<number>().as("n")).whereRef("runs.automation_id", "=", "a.id").as("run_count"),
        ])
        .where("a.user_id", "=", user.id)
        .where("a.status", archived ? "=" : "!=", "archived")
        .orderBy("a.updated_at", "desc")
        .execute();
    });

    app.post("/api/automations", async (req) => {
      const user = await requireUser(req);
      const body = z.object({ name: z.string().trim().min(1).max(200), graph: graphSchema.optional() }).parse(req.body);
      const graph = body.graph ?? defaultGraph;
      assertValid(graph);
      return createAutomation(db, user, body.name, graph, false);
    });

    app.get("/api/automations/:id", async (req) => {
      const user = await requireUser(req);
      const a = await ownAutomation(db, user, idParams.parse(req.params).id);
      const versions = await db
        .selectFrom("automation_versions")
        .select(["id", "version", "created_at", "graph"])
        .where("automation_id", "=", a.id)
        .orderBy("version", "desc")
        .execute();
      return {
        ...a,
        versions: versions.map(({ graph: _g, ...v }) => v),
        latest: versions[0],
        active: versions.find((v) => v.id === a.active_version_id) ?? null,
      };
    });

    /** name / status / active version. Activation requires the version to belong to the automation. */
    app.patch("/api/automations/:id", async (req) => {
      const user = await requireUser(req);
      const a = await ownAutomation(db, user, idParams.parse(req.params).id);
      const body = z
        .object({
          name: z.string().trim().min(1).max(200).optional(),
          status: z.enum(["disabled", "active", "archived"]).optional(),
          activeVersionId: z.string().uuid().optional(),
        })
        .parse(req.body);
      if (body.status === "active" && !(body.activeVersionId ?? a.active_version_id))
        throw new HttpError(422, "Save a version before activating");
      return db
        .updateTable("automations")
        .set({
          ...(body.name ? { name: body.name } : {}),
          ...(body.status ? { status: body.status } : {}),
          ...(body.activeVersionId ? { active_version_id: body.activeVersionId } : {}),
          updated_at: sql`now()`,
        })
        .where("id", "=", a.id)
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch((e) => {
          if (String(e).includes("automations_active_version_fk")) throw new HttpError(422, "Unknown version");
          throw e;
        });
    });

    /** Saving always creates a new immutable version; in-flight runs keep the version they started with. */
    app.post("/api/automations/:id/versions", async (req) => {
      const user = await requireUser(req);
      const a = await ownAutomation(db, user, idParams.parse(req.params).id);
      const body = z.object({ graph: graphSchema, activate: z.boolean().default(true) }).parse(req.body);
      assertValid(body.graph);
      return db.transaction().execute(async (trx) => {
        // Lock the automation so concurrent saves get consecutive version numbers.
        await trx.selectFrom("automations").select("id").where("id", "=", a.id).forUpdate().execute();
        const v = await trx
          .insertInto("automation_versions")
          .values((eb) => ({
            automation_id: a.id,
            version: eb.selectFrom("automation_versions").select(sql<number>`coalesce(max(version), 0) + 1`.as("v")).where("automation_id", "=", a.id),
            graph: body.graph,
          }))
          .returning(["id", "version", "created_at"])
          .executeTakeFirstOrThrow();
        await trx
          .updateTable("automations")
          .set({ updated_at: sql`now()`, ...(body.activate ? { active_version_id: v.id } : {}) })
          .where("id", "=", a.id)
          .execute();
        return v;
      });
    });

    app.get("/api/automations/:id/versions/:versionId", async (req) => {
      const user = await requireUser(req);
      const p = z.object({ id: z.string().uuid(), versionId: z.string().uuid() }).parse(req.params);
      await ownAutomation(db, user, p.id);
      const v = await db.selectFrom("automation_versions").selectAll().where("id", "=", p.versionId).where("automation_id", "=", p.id).executeTakeFirst();
      if (!v) throw new HttpError(404, "Version not found");
      return v;
    });

    // ---- templates ----

    app.get("/api/templates", async () => automationTemplates);

    app.post("/api/templates/:id/instantiate", async (req) => {
      const user = await requireUser(req);
      const template = findTemplate(z.object({ id: z.string() }).parse(req.params).id);
      if (!template) throw new HttpError(404, "Template not found");
      const body = z
        .object({ name: z.string().trim().min(1).max(200), params: z.record(z.string(), z.unknown()), activate: z.boolean().default(false) })
        .parse(req.body);
      const paramIssues = templateParamIssues(template, body.params);
      if (paramIssues.length) throw new HttpError(422, "Fill in the template fields", { issues: paramIssues });
      const raw = instantiateTemplate(template, body.params);
      assertValid(raw); // reports missing params per block, before the strict shape check
      const graph = graphSchema.parse(raw);
      return createAutomation(db, user, body.name, graph, body.activate);
    });

    // ---- instagram helpers for the editor ----

    app.get("/api/instagram/media", async (req) => {
      const user = await requireUser(req);
      return deps.ig.listMedia(await deps.tokens.get(user.igAccountId));
    });
  };
