import type { StepStatus } from "@app/core";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { HttpError, type AppContext } from "./app";

const PAGE = 50;

/** Keyset cursor over (started_at, id): stable while new runs keep arriving. */
const encodeCursor = (r: { started_at: Date; id: string }) => Buffer.from(`${r.started_at.toISOString()}|${r.id}`).toString("base64url");
const decodeCursor = (c: string) => {
  const [ts, id] = Buffer.from(c, "base64url").toString().split("|");
  return { ts: new Date(ts!), id: id! };
};

export const runRoutes =
  ({ deps, requireUser }: AppContext): FastifyPluginAsync =>
  async (app) => {
    const { db } = deps;

    app.get("/api/runs", async (req) => {
      const user = await requireUser(req);
      const q = z
        .object({
          automationId: z.string().uuid().optional(),
          status: z.enum(["running", "waiting", "succeeded", "failed"]).optional(),
          cursor: z.string().optional(),
        })
        .parse(req.query);
      const cursor = q.cursor ? decodeCursor(q.cursor) : null;

      const rows = await db
        .selectFrom("runs as r")
        .innerJoin("automations as a", "a.id", "r.automation_id")
        .innerJoin("automation_versions as v", "v.id", "r.version_id")
        .leftJoin("contacts as c", (j) => j.onRef("c.ig_account_id", "=", "r.ig_account_id").onRef("c.igsid", "=", "r.contact_id"))
        .select([
          "r.id", "r.status", "r.started_at", "r.ended_at", "r.contact_id", "c.username as contact_username",
          "a.id as automation_id", "a.name as automation_name", "v.id as version_id", "v.version",
          sql<Partial<Record<StepStatus, number>>>`(
            select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
            from (select status, count(*)::int as n from run_steps where run_id = r.id group by status) s
          )`.as("counters"),
        ])
        .where("a.user_id", "=", user.id)
        .$if(!!q.automationId, (qb) => qb.where("r.automation_id", "=", q.automationId!))
        .$if(!!q.status, (qb) => qb.where("r.status", "=", q.status!))
        .$if(!!cursor, (qb) => qb.where(sql<boolean>`(r.started_at, r.id) < (${cursor!.ts}, ${cursor!.id}::uuid)`))
        .orderBy("r.started_at", "desc")
        .orderBy("r.id", "desc")
        .limit(PAGE + 1)
        .execute();

      const page = rows.slice(0, PAGE);
      return { items: page, nextCursor: rows.length > PAGE ? encodeCursor(page[page.length - 1]!) : null };
    });

    app.get("/api/runs/:id", async (req) => {
      const user = await requireUser(req);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const run = await db
        .selectFrom("runs as r")
        .innerJoin("automations as a", "a.id", "r.automation_id")
        .innerJoin("automation_versions as v", "v.id", "r.version_id")
        .innerJoin("inbox_events as e", "e.id", "r.trigger_event_id")
        .select(["r.id", "r.status", "r.started_at", "r.ended_at", "r.contact_id", "a.id as automation_id", "a.name as automation_name", "v.version", "v.graph", "e.payload as trigger_event"])
        .where("r.id", "=", id)
        .where("a.user_id", "=", user.id)
        .executeTakeFirst();
      if (!run) throw new HttpError(404, "Run not found");
      const steps = await db.selectFrom("run_steps").selectAll().where("run_id", "=", id).orderBy("created_at").execute();
      const terminal = run.status === "succeeded" || run.status === "failed";
      // Nodes never reached are shown as skipped once the run has finished.
      const seen = new Set(steps.map((s) => s.node_id));
      const skipped = terminal
        ? run.graph.nodes.filter((n) => !seen.has(n.id)).map((n) => ({ run_id: id, node_id: n.id, status: "skipped" as const }))
        : [];
      return { ...run, steps: [...steps, ...skipped] };
    });
  };
