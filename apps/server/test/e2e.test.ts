import { createHmac } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createDb, createPool } from "../src/db/client";
import { migrate } from "../src/db/migrations";
import { expireWait } from "../src/engine/waits";
import { startWorkers } from "../src/engine/workers";
import { buildApp } from "../src/http/app";
import type { InstagramApi, Recipient } from "../src/instagram/client";
import { createMockInstagramApi, MOCK_ACCOUNT } from "../src/instagram/mock";
import { normalizeWebhook } from "@app/core";
import { createRuntime, type Runtime } from "../src/runtime";

/**
 * End-to-end against a real Postgres (docker compose up) with the mock Instagram API:
 * OAuth login → template → webhook → worker → Instagram calls → execution log.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/automations_test";
const cfg = loadConfig({
  DATABASE_URL,
  INSTAGRAM_MODE: "mock",
  INSTAGRAM_APP_SECRET: "test-app-secret",
  BETTER_AUTH_URL: "http://localhost:3000",
  WEB_STATIC_DIR: "/nonexistent",
} as NodeJS.ProcessEnv);

type Sent = { kind: "dm"; recipient: Recipient; text: string } | { kind: "reply"; commentId: string; text: string };
const sent: Sent[] = [];
const mock = createMockInstagramApi(() => {});
const recordingIg: InstagramApi = {
  ...mock,
  sendMessage: async (t, recipient, text) => {
    const r = await mock.sendMessage(t, recipient, text);
    sent.push({ kind: "dm", recipient, text });
    return r;
  },
  replyToComment: async (t, commentId, text) => {
    sent.push({ kind: "reply", commentId, text });
    return mock.replyToComment(t, commentId, text);
  },
};

let rt: Runtime;
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = "";

const waitFor = async <T>(fn: () => Promise<T | undefined | null | false>, ms = 15_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 100));
  }
};

const api = async (method: "GET" | "POST" | "PATCH", url: string, payload?: object) => {
  const res = await app.inject({ method, url, payload, headers: { cookie } });
  return { status: res.statusCode, body: res.json() };
};

const runSteps = (runId: string) =>
  rt.db.selectFrom("run_steps").select(["node_id", "status", "output", "error"]).where("run_id", "=", runId).execute();

beforeAll(async () => {
  const pool = createPool(DATABASE_URL, 1);
  const db = createDb(pool);
  await sql`drop schema if exists public cascade; drop schema if exists pgboss cascade; create schema public;`.execute(db);
  await migrate(db, () => {});
  await db.destroy();

  rt = await createRuntime(cfg, { ig: recordingIg });
  rt.log.level = "error"; // expected failures in these tests log warnings
  await startWorkers(rt.boss, rt.deps, { reconciler: false });
  app = await buildApp(cfg, rt.auth, rt.deps, mock);
}, 30_000);

afterAll(async () => {
  await app?.close();
  await rt?.shutdown();
});

describe("instagram login (BetterAuth genericOAuth, mock provider)", () => {
  it("signs in through the OAuth redirect dance and stores an encrypted token", async () => {
    const start = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/social",
      payload: { provider: "instagram", callbackURL: "/automations/" },
    });
    expect(start.statusCode).toBe(200);
    const authorizeUrl = new URL(start.json().url);
    expect(authorizeUrl.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_messages",
    );
    const stateCookies = ([] as string[]).concat(start.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ");

    const authorize = await app.inject({ method: "GET", url: authorizeUrl.pathname + authorizeUrl.search });
    expect(authorize.statusCode).toBe(302);
    const callback = new URL(authorize.headers.location as string);

    const done = await app.inject({ method: "GET", url: callback.pathname + callback.search, headers: { cookie: stateCookies } });
    expect(done.statusCode).toBe(302);
    cookie = ([] as string[]).concat(done.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ");

    const me = await api("GET", "/api/me");
    expect(me.body).toMatchObject({ igAccountId: MOCK_ACCOUNT.id });

    const row = await rt.db.selectFrom("account").select("accessToken").executeTakeFirstOrThrow();
    expect(row.accessToken).not.toMatch(/^mock_token_/);
    expect(await rt.deps.tokens.get(MOCK_ACCOUNT.id)).toMatch(/^mock_token_/);
  });
});

describe("comment 'pricing' → reply → DM → wait for email → DM link", () => {
  let automationId = "";

  it("creates an automation from a template", async () => {
    const missing = await api("POST", "/api/templates/comment-keyword-email-capture/instantiate", { name: "x", params: { keywords: ["pricing"] } });
    expect(missing.status).toBe(422);
    expect(missing.body.details.issues).toEqual([{ param: "link", message: "Link to send is required" }]);

    const res = await api("POST", "/api/templates/comment-keyword-email-capture/instantiate", {
      name: "Pricing funnel",
      params: { keywords: ["pricing"], link: "https://example.com/pricing" },
      activate: true,
    });
    expect(res.status).toBe(200);
    automationId = res.body.id;
  });

  const webhook = async (entry: object) => {
    const payload = { object: "instagram", entry: [entry] };
    mock.observe(normalizeWebhook(payload)); // what real Instagram would know about
    const body = JSON.stringify(payload);
    const sig = `sha256=${createHmac("sha256", "test-app-secret").update(body).digest("hex")}`;
    return app.inject({
      method: "POST",
      url: "/api/webhooks/instagram",
      payload: body,
      headers: { "content-type": "application/json", "x-hub-signature-256": sig },
    });
  };
  const comment = (id: string, text: string, from = "u1") =>
    webhook({ id: MOCK_ACCOUNT.id, time: Math.floor(Date.now() / 1000), changes: [{ field: "comments", value: { id, text, from: { id: from, username: "bob" }, media: { id: "m1" } } }] });
  const dm = (mid: string, text: string, from = "u1") =>
    webhook({ id: MOCK_ACCOUNT.id, time: 0, messaging: [{ sender: { id: from }, recipient: { id: MOCK_ACCOUNT.id }, timestamp: Date.now(), message: { mid, text } }] });

  it("rejects webhooks with a bad signature", async () => {
    const res = await app.inject({ method: "POST", url: "/api/webhooks/instagram", payload: { object: "instagram", entry: [] }, headers: { "x-hub-signature-256": "sha256=00" } });
    expect(res.statusCode).toBe(401);
  });

  it("ignores comments without the keyword", async () => {
    await comment("c0", "nice post");
    await waitFor(() => rt.db.selectFrom("inbox_events").select("processed_at").where("external_id", "=", "comment:c0").executeTakeFirst().then((r) => r?.processed_at));
    expect(await rt.db.selectFrom("runs").selectAll().execute()).toHaveLength(0);
  });

  let runId = "";
  it("replies publicly and sends a private reply, then waits", async () => {
    expect((await comment("c1", "What's the PRICING?")).statusCode).toBe(200);
    expect((await comment("c1", "What's the PRICING?")).statusCode).toBe(200); // Meta redelivery
    const run = await waitFor(() => rt.db.selectFrom("runs").selectAll().where("status", "=", "waiting").executeTakeFirst());
    runId = run.id;
    expect(await rt.db.selectFrom("runs").selectAll().execute()).toHaveLength(1);
    expect(sent).toEqual([
      { kind: "reply", commentId: "c1", text: "Sent you a DM!" },
      { kind: "dm", recipient: { comment_id: "c1" }, text: expect.stringContaining("email") },
    ]);
  });

  it("does not start a second run for the same person while one is in flight", async () => {
    await comment("c2", "pricing please");
    await waitFor(() => rt.db.selectFrom("inbox_events").select("processed_at").where("external_id", "=", "comment:c2").executeTakeFirst().then((r) => r?.processed_at));
    expect(await rt.db.selectFrom("runs").selectAll().execute()).toHaveLength(1);
  });

  it("re-asks on a reply without an email", async () => {
    await dm("m1", "hmm what?");
    await waitFor(async () => sent.length === 3);
    expect(sent[2]).toEqual({ kind: "dm", recipient: { id: "u1" }, text: expect.stringContaining("doesn't look like an email") });
  });

  it("sends the link once a valid email arrives, as a normal DM", async () => {
    await dm("m2", "sure, it's Bob@Example.com");
    const run = await waitFor(() => rt.db.selectFrom("runs").selectAll().where("id", "=", runId).where("status", "=", "succeeded").executeTakeFirst());
    expect(run.ended_at).toBeTruthy();
    expect(sent[3]).toEqual({ kind: "dm", recipient: { id: "u1" }, text: "Thanks! Here is the link: https://example.com/pricing (we'll also reach out at bob@example.com)" });
    const steps = await runSteps(runId);
    expect(Object.fromEntries(steps.map((s) => [s.node_id, s.status]))).toEqual({
      trigger: "succeeded", reply: "succeeded", ask: "succeeded", wait: "succeeded", send_link: "succeeded",
    });
  });

  it("exposes runs with per-status counters and a detailed view", async () => {
    const list = await api("GET", `/api/runs?automationId=${automationId}`);
    expect(list.body.items[0]).toMatchObject({ id: runId, version: 1, automation_name: "Pricing funnel", counters: { succeeded: 5 } });
    const detail = await api("GET", `/api/runs/${runId}`);
    expect(detail.body.steps).toHaveLength(5);
  });

  it("times out a wait and continues through the timeout port", async () => {
    sent.length = 0;
    await comment("c3", "pricing", "u2");
    const run = await waitFor(() => rt.db.selectFrom("runs").selectAll().where("contact_id", "=", "u2").where("status", "=", "waiting").executeTakeFirst());
    await rt.db.updateTable("run_steps").set({ wait_expires_at: new Date(Date.now() - 1000) }).where("run_id", "=", run.id).where("node_id", "=", "wait").execute();
    await expireWait(rt.deps, run.id, "wait");
    const after = await rt.db.selectFrom("runs").select("status").where("id", "=", run.id).executeTakeFirstOrThrow();
    expect(after.status).toBe("succeeded"); // no block on the timeout port: run just ends
    const detail = await api("GET", `/api/runs/${run.id}`);
    const statuses = Object.fromEntries(detail.body.steps.map((s: { node_id: string; status: string }) => [s.node_id, s.status]));
    expect(statuses).toMatchObject({ wait: "timed_out", send_link: "skipped" });
    // A late reply after the timeout is not applied to the finished run.
    await dm("m3", "late@example.com", "u2");
    await new Promise((r) => setTimeout(r, 500));
    expect(sent.filter((s) => s.kind === "dm" && "id" in s.recipient)).toHaveLength(0);
  });
});

describe("versioning", () => {
  it("creates new immutable versions and lets in-flight runs keep theirs", async () => {
    // The UI always sends the flag explicitly; "false" must not coerce to true.
    const list = await api("GET", "/api/automations?archived=false");
    expect(list.body.length).toBeGreaterThan(0);
    expect((await api("GET", "/api/automations?archived=true")).body).toEqual([]);
    const id = list.body[0].id;
    const detail = await api("GET", `/api/automations/${id}`);
    const graph = detail.body.latest.graph;
    const invalid = await api("POST", `/api/automations/${id}/versions`, { graph: { ...graph, edges: [] } });
    expect(invalid.status).toBe(422);
    const v2 = await api("POST", `/api/automations/${id}/versions`, { graph, activate: true });
    expect(v2.body.version).toBe(2);
    const after = await api("GET", `/api/automations/${id}`);
    expect(after.body.active_version_id).toBe(v2.body.id);
    expect(after.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    const rollback = await api("PATCH", `/api/automations/${id}`, { activeVersionId: after.body.versions[1].id });
    expect(rollback.status).toBe(200);
  });
});

describe("failures", () => {
  it("marks a step and its run failed on a permanent Instagram error, without retrying", async () => {
    const a = await api("POST", "/api/templates/dm-auto-reply/instantiate", { name: "Auto reply", params: { dm: "[fail] hello" }, activate: true });
    expect(a.status).toBe(200);
    const payload = { object: "instagram", entry: [{ id: MOCK_ACCOUNT.id, time: 0, messaging: [{ sender: { id: "u9" }, recipient: { id: MOCK_ACCOUNT.id }, timestamp: Date.now(), message: { mid: "mf", text: "hi" } }] }] };
    mock.observe(normalizeWebhook(payload));
    const body = JSON.stringify(payload);
    const sig = `sha256=${createHmac("sha256", "test-app-secret").update(body).digest("hex")}`;
    await app.inject({ method: "POST", url: "/api/webhooks/instagram", payload: body, headers: { "content-type": "application/json", "x-hub-signature-256": sig } });
    const run = await waitFor(() => rt.db.selectFrom("runs").selectAll().where("automation_id", "=", a.body.id).where("status", "=", "failed").executeTakeFirst());
    const steps = await runSteps(run.id);
    expect(steps.find((s) => s.node_id === "dm")).toMatchObject({ status: "failed", error: "Mock permanent failure" });
  });
});

describe("instagram rules are enforced by (mock) instagram, not by the app", () => {
  const simulate = (body: object) => api("POST", "/api/dev/simulate", body);
  const stepsOf = async (automationId: string) => {
    const run = await waitFor(() =>
      rt.db.selectFrom("runs").selectAll().where("automation_id", "=", automationId).where("status", "in", ["succeeded", "failed"]).executeTakeFirst(),
    );
    return Object.fromEntries((await runSteps(run.id)).map((s) => [s.node_id, s]));
  };

  it("two automations on one comment: both try a private reply, Instagram rejects the second", async () => {
    const params = { keywords: ["collide"], dm: "here you go" };
    const a = await api("POST", "/api/templates/comment-keyword-dm/instantiate", { name: "A", params, activate: true });
    const b = await api("POST", "/api/templates/comment-keyword-dm/instantiate", { name: "B", params, activate: true });
    await simulate({ kind: "comment", text: "collide", mediaId: "m1", fromId: "u7", username: "kim" });
    const dms = [(await stepsOf(a.body.id)).dm!, (await stepsOf(b.body.id)).dm!];
    expect(dms.map((s) => s.status).sort()).toEqual(["failed", "succeeded"]);
    expect(dms.find((s) => s.status === "failed")!.error).toBe("(#10) A private reply has already been sent to this comment");
  });

  it("a DM to someone who never messaged the account is rejected by Instagram", async () => {
    const g = await api("POST", "/api/automations", { name: "cold dm" });
    const graph = {
      nodes: [
        { id: "trigger", type: "trigger.comment", position: { x: 0, y: 0 }, config: { publications: { mode: "all" }, keywords: ["cold"] }, inputs: {} },
        // Addressed to a different user than the commenter: no private reply possible.
        { id: "dm", type: "action.send_dm", position: { x: 0, y: 100 }, config: {}, inputs: { user_id: "stranger", message_text: "hi" } },
      ],
      edges: [{ id: "e", source: "trigger", sourcePort: "out", target: "dm" }],
    };
    await api("POST", `/api/automations/${g.body.id}/versions`, { graph, activate: true });
    await api("PATCH", `/api/automations/${g.body.id}`, { status: "active" });
    await simulate({ kind: "comment", text: "cold", mediaId: "m1", fromId: "u8", username: "lee" });
    const steps = await stepsOf(g.body.id);
    expect(steps.dm).toMatchObject({ status: "failed", error: "(#10) This message is sent outside of allowed window." });
  });
});
