import {
  eventContactId,
  findNode,
  triggerMatches,
  triggerNode,
  triggerOutput,
  type InboundEvent,
} from "@app/core";
import { sql } from "kysely";
import type { DB, Tx } from "../db/client";
import { handlerFor } from "./blocks";
import type { EngineDeps } from "./deps";
import { eventHandler, type ContactProfile } from "./events";
import { lockRun, refreshRunStatus, scheduleNext } from "./runs";
import { deliverEvent } from "./steps";

/**
 * Ingress: store normalized events in the inbox (deduplicated) and enqueue routing in the same
 * transaction. This is all the webhook request does, so we can answer Meta quickly.
 */
export const ingestEvents = async (
  deps: Pick<EngineDeps, "db" | "enqueue">,
  events: readonly InboundEvent[],
): Promise<{ inserted: number; duplicates: number }> =>
  deps.db.transaction().execute(async (trx) => {
    let inserted = 0;
    for (const e of events) {
      const row = await trx
        .insertInto("inbox_events")
        .values({ ig_account_id: e.accountId, external_id: e.externalId, kind: e.kind, payload: e })
        .onConflict((oc) => oc.columns(["ig_account_id", "external_id"]).doNothing())
        .returning("id")
        .executeTakeFirst();
      if (row) {
        inserted++;
        await deps.enqueue(trx, "route-event", { eventId: row.id });
      }
    }
    return { inserted, duplicates: events.length - inserted };
  });

/** Remember who interacted with the account (shown in the execution log, used as user_data). */
const upsertContact = (db: DB | Tx, accountId: string, igsid: string, profile: ContactProfile | null) =>
  db
    .insertInto("contacts")
    .values({ ig_account_id: accountId, igsid, username: profile?.username || null, full_name: profile?.name || null })
    .onConflict((oc) =>
      oc.columns(["ig_account_id", "igsid"]).doUpdateSet({
        username: sql`coalesce(excluded.username, contacts.username)`,
        full_name: sql`coalesce(excluded.full_name, contacts.full_name)`,
        updated_at: sql`now()`,
      }),
    )
    .execute();

/**
 * Route one inbox event, whatever its kind:
 * 1. if a suspended step of this contact consumes the event kind, it resumes that step (and is
 *    not used as a trigger);
 * 2. otherwise every active automation whose trigger declares this kind and matches starts a run.
 * The whole decision commits atomically with the jobs it enqueues; re-running it is a no-op.
 */
export const routeEvent = async (deps: EngineDeps, eventId: number): Promise<void> => {
  const head = await deps.db.selectFrom("inbox_events").select(["payload", "processed_at"]).where("id", "=", eventId).executeTakeFirst();
  if (!head || head.processed_at) return;
  const event = head.payload;
  const contactId = eventContactId(event);

  // Network call outside the transaction.
  const profile = await eventHandler(event.kind).profile(deps, event);

  await deps.db.transaction().execute(async (trx) => {
    const locked = await trx.selectFrom("inbox_events").select("processed_at").where("id", "=", eventId).forUpdate().executeTakeFirstOrThrow();
    if (locked.processed_at) return;
    const now = deps.now();
    await trx.updateTable("inbox_events").set({ processed_at: now }).where("id", "=", eventId).execute();
    await upsertContact(trx, event.accountId, contactId, profile);

    if (await resumeSuspendedStep(deps, trx, event, contactId)) return;

    const contact = await trx
      .selectFrom("contacts")
      .select(["username", "full_name"])
      .where("ig_account_id", "=", event.accountId)
      .where("igsid", "=", contactId)
      .executeTakeFirst();
    const user = { username: contact?.username ?? "", full_name: contact?.full_name ?? "" };

    const candidates = await trx
      .selectFrom("automations as a")
      .innerJoin("automation_versions as v", "v.id", "a.active_version_id")
      .select(["a.id as automationId", "v.id as versionId", "v.graph"])
      .where("a.ig_account_id", "=", event.accountId)
      .where("a.status", "=", "active")
      .execute();

    for (const c of candidates) {
      const trigger = triggerNode(c.graph);
      if (!trigger || !triggerMatches(trigger, event)) continue;
      // ON CONFLICT DO NOTHING covers both "same event already started this automation" and
      // "this person already has an in-flight run of this automation".
      const run = await trx
        .insertInto("runs")
        .values({
          automation_id: c.automationId,
          version_id: c.versionId,
          ig_account_id: event.accountId,
          contact_id: contactId,
          trigger_event_id: eventId,
          status: "running",
        })
        .onConflict((oc) => oc.doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!run) {
        deps.log.info({ automationId: c.automationId, eventId }, "run not started: duplicate or in-flight run for contact");
        continue;
      }
      await trx
        .insertInto("run_steps")
        .values({ run_id: run.id, node_id: trigger.id, status: "succeeded", attempts: 1, output: triggerOutput(trigger, event, user), started_at: now, ended_at: now })
        .execute();
      await scheduleNext(deps, trx, run.id, c.graph, trigger.id, "out");
      await refreshRunStatus(trx, run.id, now);
      deps.log.info({ runId: run.id, automationId: c.automationId, eventId }, "run started");
    }
  });
};

/**
 * Correlation: an event resumes the most recently suspended step, in any run of its contact,
 * whose block consumes that event kind (whatever else the run is doing in parallel branches).
 * If several automations wait on the same person, the latest question gets the answer.
 */
const resumeSuspendedStep = async (deps: EngineDeps, trx: Tx, event: InboundEvent, contactId: string): Promise<boolean> => {
  const waiting = await trx
    .selectFrom("run_steps as s")
    .innerJoin("runs as r", "r.id", "s.run_id")
    .innerJoin("automation_versions as v", "v.id", "r.version_id")
    .select(["s.run_id", "s.node_id", "v.graph"])
    .where("r.ig_account_id", "=", event.accountId)
    .where("r.contact_id", "=", contactId)
    .where("s.status", "=", "waiting")
    .orderBy("s.started_at", "desc")
    .execute();
  for (const w of waiting) {
    const type = findNode(w.graph, w.node_id)?.type;
    if (!type || !handlerFor(type)?.on?.[event.kind]) continue;
    const run = await lockRun(trx, w.run_id);
    // Re-checked under the lock: the step may have moved on since the select.
    if (run && (await deliverEvent({ deps, trx, run, graph: w.graph, nodeId: w.node_id }, event))) return true;
  }
  return false;
};
