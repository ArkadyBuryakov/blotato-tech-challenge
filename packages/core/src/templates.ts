import type { Graph } from "./graph";
import { fillParams } from "./template";

/**
 * Automation templates: a ready graph with `[[param]]` placeholders.
 * The user fills only the params; instantiation is a pure substitution, and the result
 * goes through the same validation as any hand-built graph.
 */

export type TemplateParam = {
  readonly key: string;
  readonly label: string;
  readonly kind: "text" | "multiline" | "keywords" | "publications" | "url";
  readonly placeholder?: string;
  readonly defaultValue?: unknown;
};

export type AutomationTemplate = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly params: readonly TemplateParam[];
  readonly graph: Graph;
};

const at = (x: number, y: number) => ({ x, y });

export const automationTemplates: readonly AutomationTemplate[] = [
  {
    id: "comment-keyword-email-capture",
    name: "Comment keyword → collect email → send link",
    description:
      "When someone comments a keyword, reply publicly, DM them asking for their email, wait for a valid email and send a link.",
    params: [
      { key: "keywords", label: "Keywords", kind: "keywords", placeholder: "pricing" },
      { key: "publications", label: "Publications", kind: "publications", defaultValue: { mode: "all" } },
      { key: "public_reply", label: "Public reply", kind: "text", defaultValue: "Sent you a DM!" },
      {
        key: "ask_email",
        label: "DM asking for email",
        kind: "multiline",
        defaultValue: "Hey! What's your email address? I'll send you the details there.",
      },
      { key: "link", label: "Link to send", kind: "url", placeholder: "https://example.com/pricing" },
    ],
    graph: {
      nodes: [
        {
          id: "trigger",
          type: "trigger.comment",
          position: at(0, 0),
          config: { publications: "[[publications]]", keywords: "[[keywords]]" },
          inputs: {},
        },
        {
          id: "reply",
          type: "action.comment_reply",
          position: at(0, 140),
          config: {},
          inputs: { comment_id: "{{trigger.comment_data.comment_id}}", message_text: "[[public_reply]]" },
        },
        {
          id: "ask",
          type: "action.private_reply",
          position: at(0, 280),
          config: {},
          inputs: { comment_id: "{{trigger.comment_data.comment_id}}", message_text: "[[ask_email]]" },
        },
        {
          id: "wait",
          type: "control.wait_for_reply",
          position: at(0, 420),
          config: {
            expect: "email",
            timeoutHours: 23,
            retryMessage: "Hmm, that doesn't look like an email address. Could you double-check it?",
            maxRetries: 2,
          },
          inputs: { user_id: "{{trigger.user_data.user_id}}" },
        },
        {
          id: "send_link",
          type: "action.send_dm",
          position: at(-160, 580),
          config: {},
          inputs: {
            user_id: "{{trigger.user_data.user_id}}",
            message_text: "Thanks! Here is the link: [[link]] (we'll also reach out at {{wait.email}})",
          },
        },
      ],
      edges: [
        { id: "e1", source: "trigger", sourcePort: "out", target: "reply" },
        { id: "e2", source: "reply", sourcePort: "out", target: "ask" },
        { id: "e3", source: "ask", sourcePort: "out", target: "wait" },
        { id: "e4", source: "wait", sourcePort: "received", target: "send_link" },
      ],
    },
  },
  {
    id: "comment-keyword-dm",
    name: "Comment keyword → DM",
    description: "When someone comments a keyword, reply publicly and send them a DM.",
    params: [
      { key: "keywords", label: "Keywords", kind: "keywords", placeholder: "link" },
      { key: "publications", label: "Publications", kind: "publications", defaultValue: { mode: "all" } },
      { key: "public_reply", label: "Public reply", kind: "text", defaultValue: "Check your DMs 📩" },
      { key: "dm", label: "DM text", kind: "multiline", placeholder: "Here you go: https://..." },
    ],
    graph: {
      nodes: [
        {
          id: "trigger",
          type: "trigger.comment",
          position: at(0, 0),
          config: { publications: "[[publications]]", keywords: "[[keywords]]" },
          inputs: {},
        },
        {
          id: "reply",
          type: "action.comment_reply",
          position: at(0, 140),
          config: {},
          inputs: { comment_id: "{{trigger.comment_data.comment_id}}", message_text: "[[public_reply]]" },
        },
        {
          id: "dm",
          type: "action.private_reply",
          position: at(0, 280),
          config: {},
          inputs: { comment_id: "{{trigger.comment_data.comment_id}}", message_text: "[[dm]]" },
        },
      ],
      edges: [
        { id: "e1", source: "trigger", sourcePort: "out", target: "reply" },
        { id: "e2", source: "reply", sourcePort: "out", target: "dm" },
      ],
    },
  },
  {
    id: "dm-auto-reply",
    name: "DM auto-reply",
    description: "Reply to every incoming DM with a fixed message.",
    params: [{ key: "dm", label: "Reply text", kind: "multiline", placeholder: "Thanks for reaching out!" }],
    graph: {
      nodes: [
        { id: "trigger", type: "trigger.dm", position: at(0, 0), config: {}, inputs: {} },
        {
          id: "dm",
          type: "action.send_dm",
          position: at(0, 140),
          config: {},
          inputs: { user_id: "{{trigger.message_data.user_id}}", message_text: "[[dm]]" },
        },
      ],
      edges: [{ id: "e1", source: "trigger", sourcePort: "out", target: "dm" }],
    },
  },
];

export const findTemplate = (id: string) => automationTemplates.find((t) => t.id === id);

const isBlank = (v: unknown) =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

/** Params without a default are the "few fields missing" the user must fill in. */
export const templateParamIssues = (
  template: AutomationTemplate,
  params: Readonly<Record<string, unknown>>,
): readonly { param: string; message: string }[] =>
  template.params
    .filter((p) => p.defaultValue === undefined && p.kind !== "keywords" && isBlank(params[p.key]))
    .map((p) => ({ param: p.key, message: `${p.label} is required` }));

export const instantiateTemplate = (
  template: AutomationTemplate,
  params: Readonly<Record<string, unknown>>,
): Graph =>
  fillParams(template.graph, {
    ...Object.fromEntries(template.params.map((p) => [p.key, p.defaultValue])),
    ...params,
  });
