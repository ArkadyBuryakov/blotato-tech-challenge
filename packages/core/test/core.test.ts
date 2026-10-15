import { describe, expect, it } from "vitest";
import {
  automationTemplates,
  chooseDelivery,
  deriveRunStatus,
  evaluateReply,
  findTemplate,
  instantiateTemplate,
  matchesKeywords,
  nextNodes,
  normalizeWebhook,
  renderTemplate,
  triggerMatches,
  validateGraph,
  type Graph,
  type MessageEvent,
} from "../src";

const pricingGraph = (): Graph =>
  instantiateTemplate(findTemplate("comment-keyword-email-capture")!, {
    keywords: ["pricing"],
    link: "https://example.com/pricing",
  });

describe("templates", () => {
  it("instantiates every template into a valid graph when params are filled", () => {
    const params = { keywords: ["x"], link: "https://x.io", dm: "hi" };
    for (const t of automationTemplates) expect(validateGraph(instantiateTemplate(t, params))).toEqual([]);
  });

  it("reports missing params as validation issues", () => {
    const g = instantiateTemplate(findTemplate("dm-auto-reply")!, {});
    expect(validateGraph(g).map((i) => i.nodeId)).toContain("dm");
  });
});

describe("validateGraph", () => {
  it("rejects fan-in, unknown refs and bad ports", () => {
    const g = pricingGraph();
    const bad: Graph = {
      nodes: g.nodes.map((n) =>
        n.id === "send_link" ? { ...n, inputs: { ...n.inputs, message_text: "{{send_link.email}}" } } : n,
      ),
      edges: [...g.edges, { id: "x", source: "reply", sourcePort: "nope", target: "wait" }],
    };
    const msgs = validateGraph(bad).map((i) => i.message);
    expect(msgs).toContain('Block has no port "nope"');
    expect(msgs).toContain("Block can have only one incoming connection");
  });

  it("rejects references to non-upstream blocks", () => {
    const g = pricingGraph();
    const bad: Graph = {
      ...g,
      nodes: g.nodes.map((n) => (n.id === "reply" ? { ...n, inputs: { ...n.inputs, message_text: "{{wait.email}}" } } : n)),
    };
    expect(validateGraph(bad)).toEqual([{ nodeId: "reply", message: "{{wait.email}} must reference an upstream block" }]);
  });

  it("detects cycles as unreachable nodes", () => {
    const g: Graph = {
      nodes: [
        { id: "t", type: "trigger.dm", position: { x: 0, y: 0 }, config: {}, inputs: {} },
        { id: "a", type: "action.send_dm", position: { x: 0, y: 0 }, config: {}, inputs: { user_id: "1", message_text: "x" } },
        { id: "b", type: "action.send_dm", position: { x: 0, y: 0 }, config: {}, inputs: { user_id: "1", message_text: "x" } },
      ],
      edges: [
        { id: "1", source: "a", sourcePort: "out", target: "b" },
        { id: "2", source: "b", sourcePort: "out", target: "a" },
      ],
    };
    expect(validateGraph(g).map((i) => i.message)).toContain("Block is not reachable from the trigger");
  });
});

describe("webhooks", () => {
  const payload = {
    object: "instagram",
    entry: [
      {
        id: "acc",
        time: 1_700_000_000,
        changes: [
          { field: "comments", value: { id: "c1", text: "Pricing?", from: { id: "u1", username: "bob" }, media: { id: "m1" } } },
          { field: "comments", value: { id: "c2", text: "thanks", from: { id: "acc", username: "me" }, media: { id: "m1" } } },
        ],
        messaging: [
          { sender: { id: "u1" }, recipient: { id: "acc" }, timestamp: 1_700_000_000_000, message: { mid: "m-1", text: "bob@x.io" } },
          { sender: { id: "acc" }, recipient: { id: "u1" }, timestamp: 1_700_000_000_000, message: { mid: "m-2", text: "hi", is_echo: true } },
        ],
      },
    ],
  };

  it("normalizes comments and messages and drops our own echoes", () => {
    const events = normalizeWebhook(payload);
    expect(events.map((e) => e.externalId)).toEqual(["comment:c1", "message:m-1"]);
  });

  it("matches the comment trigger by keyword", () => {
    const [comment] = normalizeWebhook(payload);
    const trigger = pricingGraph().nodes[0]!;
    expect(triggerMatches(trigger, comment!)).toBe(true);
    expect(triggerMatches(trigger, { ...(comment as any), text: "expensive pricings" })).toBe(false);
  });
});

describe("rules", () => {
  it("matches keywords as whole words, case-insensitively", () => {
    expect(matchesKeywords("What's the PRICING?", ["pricing"])).toBe(true);
    expect(matchesKeywords("repricing", ["pricing"])).toBe(false);
    expect(matchesKeywords("anything", [])).toBe(true);
  });

  it("renders templates from upstream outputs", () => {
    expect(renderTemplate("hi {{t.user_data.username}}!", { t: { user_data: { username: "bob" } } })).toBe("hi bob!");
  });

  const reply = (text: string): MessageEvent => ({
    kind: "message", accountId: "a", externalId: "x", messageId: "mid", senderId: "u",
    text, messageType: "text", payload: { text }, occurredAt: new Date().toISOString(),
  });

  it("waits for a valid email, re-asking a limited number of times", () => {
    const wait = pricingGraph().nodes.find((n) => n.id === "wait")!;
    expect(evaluateReply(wait, reply("my mail is Bob@Example.com"), 0)).toMatchObject({ kind: "accept", output: { email: "bob@example.com" } });
    expect(evaluateReply(wait, reply("what?"), 0).kind).toBe("retry");
    expect(evaluateReply(wait, reply("what?"), 2).kind).toBe("ignore");
  });

  it("addresses the commenter by private reply first, then by user id", () => {
    const sourceComment = { commentId: "c1", fromId: "u" };
    expect(chooseDelivery({ userId: "u", sourceComment, privateReplySentInRun: false })).toEqual({ kind: "private_reply", commentId: "c1" });
    expect(chooseDelivery({ userId: "u", sourceComment, privateReplySentInRun: true })).toEqual({ kind: "user", userId: "u" });
    expect(chooseDelivery({ userId: "other", sourceComment, privateReplySentInRun: false })).toEqual({ kind: "user", userId: "other" });
    expect(chooseDelivery({ userId: "u", sourceComment: null, privateReplySentInRun: false })).toEqual({ kind: "user", userId: "u" });
  });

  it("derives run status and routes by port", () => {
    expect(deriveRunStatus(["succeeded", "waiting"])).toBe("waiting");
    expect(deriveRunStatus(["succeeded", "failed"])).toBe("failed");
    expect(deriveRunStatus(["succeeded", "timed_out"])).toBe("succeeded");
    expect(nextNodes(pricingGraph(), "wait", "received")).toEqual(["send_link"]);
    expect(nextNodes(pricingGraph(), "wait", "timeout")).toEqual([]);
  });
});
