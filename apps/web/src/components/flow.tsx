"use client";

import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { blockCatalog, isBlockType, type Graph, type GraphNode } from "@app/core";
import { createContext, useContext, useMemo } from "react";

export type BlockData = { block: Omit<GraphNode, "position"> };
export type BlockFlowNode = Node<BlockData, "block">;

/** Per-node decorations (validation issues in the editor, step statuses in the run view). */
export type Decorations = { issues?: ReadonlyMap<string, string[]>; statuses?: ReadonlyMap<string, string> };
export const DecorationsContext = createContext<Decorations>({});

export const toFlow = (graph: Graph): { nodes: BlockFlowNode[]; edges: Edge[] } => ({
  nodes: graph.nodes.map(({ position, ...block }) => ({
    id: block.id,
    type: "block",
    position,
    data: { block },
    deletable: !(isBlockType(block.type) && blockCatalog[block.type].kind === "trigger"),
  })),
  edges: graph.edges.map(toFlowEdge),
});

export const toFlowEdge = (e: Graph["edges"][number]): Edge => ({
  id: e.id,
  source: e.source,
  sourceHandle: e.sourcePort,
  target: e.target,
  label: e.sourcePort === "out" ? undefined : e.sourcePort,
  markerEnd: { type: MarkerType.ArrowClosed },
});

export const fromFlow = (nodes: BlockFlowNode[], edges: Edge[]): Graph => ({
  nodes: nodes.map((n) => ({ ...n.data.block, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } })),
  edges: edges.map((e) => ({ id: e.id, source: e.source, sourcePort: e.sourceHandle ?? "out", target: e.target })),
});

/** A one-line summary of what the block is configured to do. */
const summary = (b: BlockData["block"]): string => {
  if (b.type === "trigger.comment") {
    const cfg = b.config as { keywords?: string[]; publications?: { mode: string; items?: unknown[] } };
    const kw = cfg.keywords?.length ? `“${cfg.keywords.join("”, “")}”` : "any text";
    const pubs = cfg.publications?.mode === "list" ? `${cfg.publications.items?.length ?? 0} posts` : "all posts";
    return `${kw} on ${pubs}`;
  }
  if (b.type === "control.wait_for_reply") {
    const cfg = b.config as { expect?: string; timeoutHours?: number };
    return `${cfg.expect === "email" ? "an email" : "any reply"}, up to ${cfg.timeoutHours ?? 23}h`;
  }
  return b.inputs.message_text ?? "";
};

function BlockNodeView({ id, data, selected }: NodeProps<BlockFlowNode>) {
  const { issues, statuses } = useContext(DecorationsContext);
  const def = isBlockType(data.block.type) ? blockCatalog[data.block.type] : null;
  const status = statuses?.get(id);
  const invalid = (issues?.get(id)?.length ?? 0) > 0;
  const cls = ["flow-node", `kind-${def?.kind ?? "action"}`, selected && "selected", invalid && "invalid", status && `st-${status}`]
    .filter(Boolean)
    .join(" ");
  const ports = def?.ports ?? ["out"];
  return (
    <div className={cls}>
      {def?.kind !== "trigger" && <Handle type="target" position={Position.Top} />}
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
        <span className="kind">{def?.kind ?? "unknown"}</span>
        {status ? <span className={`badge badge-${status}`}>{status.replace("_", " ")}</span> : <span className="muted mono">{id}</span>}
      </div>
      <div className="title">{def?.label ?? data.block.type}</div>
      <div className="detail">{summary(data.block) || " "}</div>
      {ports.length > 1 && (
        <div className="port-labels">
          {ports.map((p) => (
            <span key={p}>{p}</span>
          ))}
        </div>
      )}
      {ports.map((p, i) => (
        <Handle key={p} id={p} type="source" position={Position.Bottom} style={{ left: `${((i + 1) / (ports.length + 1)) * 100}%` }} />
      ))}
    </div>
  );
}

export const nodeTypes = { block: BlockNodeView };

/** Read-only graph (execution log graph view). */
export function GraphView({
  graph,
  statuses,
  onSelect,
  height = 420,
}: {
  graph: Graph;
  statuses?: ReadonlyMap<string, string>;
  onSelect?: (nodeId: string) => void;
  height?: number;
}) {
  const flow = useMemo(() => toFlow(graph), [graph]);
  return (
    <DecorationsContext.Provider value={{ statuses }}>
      <ReactFlowProvider>
        <div style={{ height }}>
          <ReactFlow
            nodes={flow.nodes}
            edges={flow.edges}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={!!onSelect}
            onNodeClick={(_, n) => onSelect?.(n.id)}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </ReactFlowProvider>
    </DecorationsContext.Provider>
  );
}
