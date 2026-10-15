import {
  commentTriggerOutput,
  dmTriggerOutput,
  eventContactId,
  triggerMatches,
  triggerNode,
  type InboundEvent,
  type MessageEvent,
} from "@app/core";
import { sql } from "kysely";
import type { DB, Tx } from "../db/client";
import type { EngineDeps } from "./deps";
import { refreshRunStatus, scheduleNext } from "./runs";
import { applyReply } from "./waits";

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
const upsertContact = (db: DB | Tx, accountId: string, igsid: string, profile: { username?: string; name?: string } | null) =>
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
 * Route one inbox event:
 * 1. a DM from someone we are waiting on resumes that conversation (and is not used as a trigger);
 * 2. otherwise every active automation whose trigger matches starts a new run.
 * The whole decision commits atomically with the jobs it enqueues; re-running it is a no-op.
 */
export const routeEvent = async (deps: EngineDeps, eventId: number): Promise<void> => {
  const head = await deps.db.selectFrom("inbox_events").select(["payload", "processed_at"]).where("id", "=", eventId).executeTakeFirst();
  if (!head || head.processed_at) return;
  const event = head.payload;

  // Network call outside the transaction; best effort (profile access is not guaranteed).
  const profile =
    event.kind === "message"
      ? await deps.tokens
          .get(event.accountId)
          .then((t) => deps.ig.getUserProfile(t, event.senderId))
          .catch(() => null)
      : null;

  await deps.db.transaction().execute(async (trx) => {
    const locked = await trx.selectFrom("inbox_events").select("processed_at").where("id", "=", eventId).forUpdate().executeTakeFirstOrThrow();
    if (locked.processed_at) return;
    const now = deps.now();
    await trx.updateTable("inbox_events").set({ processed_at: now }).where("id", "=", eventId).execute();

    if (event.kind === "message") {
      await upsertContact(trx, event.accountId, event.senderId, profile);
      if (await resumeWaitingRun(deps, trx, event)) return;
    }

    if (event.kind === "comment") await upsertContact(trx, event.accountId, event.from.id, { username: event.from.username });

    const contactId = eventContactId(event);
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
      const output = event.kind === "comment" ? commentTriggerOutput(event, user) : dmTriggerOutput(event, user);
      await trx
        .insertInto("run_steps")
        .values({ run_id: run.id, node_id: trigger.id, status: "succeeded", attempts: 1, output, started_at: now, ended_at: now })
        .execute();
      await scheduleNext(deps, trx, run.id, c.graph, trigger.id, "out");
      await refreshRunStatus(trx, run.id, now);
      deps.log.info({ runId: run.id, automationId: c.automationId, eventId }, "run started");
    }
  });
};

/**
 * Correlation: a DM resumes the most recent waiting step of a run whose contact is the sender.
 * If several automations wait on the same person, the latest question gets the answer.
 */
const resumeWaitingRun = async (deps: EngineDeps, trx: Tx, event: MessageEvent): Promise<boolean> => {
  const waiting = await trx
    .selectFrom("runs as r")
    .innerJoin("run_steps as s", "s.run_id", "r.id")
    .select(["r.id", "r.version_id", "s.node_id"])
    .where("r.ig_account_id", "=", event.accountId)
    .where("r.contact_id", "=", event.senderId)
    .where("r.status", "=", "waiting")
    .where("s.status", "=", "waiting")
    .orderBy("s.started_at", "desc")
    .limit(1)
    .forUpdate("r")
    .executeTakeFirst();
  return waiting ? applyReply(deps, trx, waiting, waiting.node_id, event) : false;
};
