import { z } from "zod";
import { blockCatalog, blockSchemas, isBlockType, type BlockType } from "./blocks";
import { extractRefs } from "./template";

export const graphNodeSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, "Node id must be alphanumeric"),
  type: z.string(),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  config: z.record(z.string(), z.unknown()).default({}),
  inputs: z.record(z.string(), z.string()).default({}),
});

export const graphEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  sourcePort: z.string().default("out"),
  target: z.string(),
});

export const graphSchema = z.object({
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
});

export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphEdge = z.infer<typeof graphEdgeSchema>;
export type Graph = z.infer<typeof graphSchema>;

export type GraphIssue = { readonly nodeId?: string; readonly message: string };

// ---------- pure graph queries ----------

export const findNode = (g: Graph, id: string): GraphNode | undefined =>
  g.nodes.find((n) => n.id === id);

export const triggerNode = (g: Graph): GraphNode | undefined =>
  g.nodes.find((n) => isBlockType(n.type) && blockCatalog[n.type].kind === "trigger");

export const incoming = (g: Graph, id: string): readonly GraphEdge[] =>
  g.edges.filter((e) => e.target === id);

/** Nodes to schedule after `nodeId` completed through `port`. */
export const nextNodes = (g: Graph, nodeId: string, port: string): readonly string[] =>
  g.edges.filter((e) => e.source === nodeId && e.sourcePort === port).map((e) => e.target);

/** Ancestors along the (unique, since the graph is a tree) path from the trigger. */
export const ancestors = (g: Graph, id: string): readonly string[] => {
  const parent = incoming(g, id)[0]?.source;
  return parent === undefined ? [] : [parent, ...ancestors(g, parent)];
};

// ---------- validation ----------

const nodeIssues = (n: GraphNode): GraphIssue[] => {
  if (!isBlockType(n.type)) return [{ nodeId: n.id, message: `Unknown block type "${n.type}"` }];
  const schema = blockSchemas[n.type];
  return [schema.config.safeParse(n.config), schema.inputs.safeParse(n.inputs)].flatMap((r) =>
    r.success ? [] : r.error.issues.map((i) => ({ nodeId: n.id, message: i.message })),
  );
};

const refIssues = (g: Graph, n: GraphNode): GraphIssue[] => {
  const upstream = new Set(ancestors(g, n.id));
  return Object.values(n.inputs)
    .flatMap((v) => (typeof v === "string" ? extractRefs(v) : []))
    .flatMap(({ nodeId, path }) => {
      const src = findNode(g, nodeId);
      if (!src || !upstream.has(nodeId))
        return [{ nodeId: n.id, message: `{{${nodeId}.${path}}} must reference an upstream block` }];
      const outputs = isBlockType(src.type) ? blockCatalog[src.type].outputs : [];
      return outputs.includes(path)
        ? []
        : [{ nodeId: n.id, message: `Block "${nodeId}" has no output "${path}"` }];
    });
};

/**
 * Structural rules (kept intentionally strict, see docs/architecture.md):
 * - exactly one trigger, with no incoming edges
 * - every other node has exactly one incoming edge (the graph is a tree rooted at the trigger),
 *   which removes join semantics and makes "what ran before me" unambiguous
 * - edges use ports that the source block declares
 * - template references point to upstream blocks and declared outputs
 */
export const validateGraph = (g: Graph): readonly GraphIssue[] => {
  const ids = new Set(g.nodes.map((n) => n.id));
  const triggers = g.nodes.filter(
    (n) => isBlockType(n.type) && blockCatalog[n.type].kind === "trigger",
  );
  const trigger = triggers[0];

  const structural: GraphIssue[] = [
    ...(ids.size !== g.nodes.length ? [{ message: "Node ids must be unique" }] : []),
    ...(triggers.length !== 1 ? [{ message: "An automation needs exactly one trigger" }] : []),
    ...g.edges.flatMap((e): GraphIssue[] => {
      if (!ids.has(e.source) || !ids.has(e.target))
        return [{ message: `Edge ${e.id} references a missing block` }];
      const src = findNode(g, e.source)!;
      return isBlockType(src.type) && !blockCatalog[src.type].ports.includes(e.sourcePort)
        ? [{ nodeId: src.id, message: `Block has no port "${e.sourcePort}"` }]
        : [];
    }),
    ...g.nodes.flatMap((n): GraphIssue[] => {
      const count = incoming(g, n.id).length;
      if (n === trigger)
        return count > 0 ? [{ nodeId: n.id, message: "Trigger cannot have incoming connections" }] : [];
      if (count === 0) return [{ nodeId: n.id, message: "Block is not connected" }];
      if (count > 1) return [{ nodeId: n.id, message: "Block can have only one incoming connection" }];
      return [];
    }),
  ];

  // Reachability also rules out cycles: in a graph where every non-root node has one parent,
  // a node is reachable from the root iff it is not on a cycle.
  const reachable = new Set<string>();
  const visit = (id: string): void => {
    if (reachable.has(id)) return;
    reachable.add(id);
    g.edges.filter((e) => e.source === id).forEach((e) => visit(e.target));
  };
  if (trigger) visit(trigger.id);
  const unreachable: GraphIssue[] =
    structural.length === 0
      ? g.nodes
          .filter((n) => !reachable.has(n.id))
          .map((n) => ({ nodeId: n.id, message: "Block is not reachable from the trigger" }))
      : [];

  const perNode = g.nodes.flatMap(nodeIssues);
  const refs = structural.length === 0 && unreachable.length === 0 ? g.nodes.flatMap((n) => refIssues(g, n)) : [];
  return [...structural, ...unreachable, ...perNode, ...refs];
};

/** Parses config with defaults applied. Assumes the graph was validated. */
export const parseConfig = <T extends BlockType>(type: T, config: unknown) =>
  blockSchemas[type].config.parse(config) as z.infer<(typeof blockSchemas)[T]["config"]>;
