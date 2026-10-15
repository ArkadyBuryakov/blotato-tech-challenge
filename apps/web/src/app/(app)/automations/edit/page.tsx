"use client";

import {
  addEdge,
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
} from "@xyflow/react";
import { blockCatalog, blockTypes, validateGraph, type BlockType, type Graph } from "@app/core";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { StatusBadge } from "@/components/Badges";
import { DecorationsContext, fromFlow, nodeTypes, toFlow, toFlowEdge, type BlockFlowNode } from "@/components/flow";
import { Inspector } from "@/components/Inspector";
import { api, ApiError, useApi } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import type { AutomationDetail } from "@/lib/types";

const defaults: Record<BlockType, { config: Record<string, unknown>; inputs: Record<string, string> }> = {
  "trigger.comment": { config: { publications: { mode: "all" }, keywords: [] }, inputs: {} },
  "trigger.dm": { config: {}, inputs: {} },
  "action.send_dm": { config: {}, inputs: { user_id: "", message_text: "" } },
  "action.comment_reply": { config: {}, inputs: { comment_id: "", message_text: "" } },
  "control.wait_for_reply": { config: { expect: "any", timeoutHours: 23, retryMessage: "", maxRetries: 2 }, inputs: { user_id: "" } },
};

/** Sensible default references to the trigger's outputs, so new blocks are usually valid right away. */
const prefill = (type: BlockType, trigger?: { id: string; type: string }) => {
  const inputs = { ...defaults[type].inputs };
  if (!trigger) return inputs;
  const userRef = trigger.type === "trigger.comment" ? `{{${trigger.id}.user_data.user_id}}` : `{{${trigger.id}.message_data.user_id}}`;
  if ("user_id" in inputs) inputs.user_id = userRef;
  if ("comment_id" in inputs && trigger.type === "trigger.comment") inputs.comment_id = `{{${trigger.id}.comment_data.comment_id}}`;
  return inputs;
};

function Editor({ automation, reload }: { automation: AutomationDetail; reload: () => Promise<unknown> }) {
  const [versionId, setVersionId] = useState(automation.latest.id);
  const versionGraph = useApi<{ graph: Graph }>(`/api/automations/${automation.id}/versions/${versionId}`);
  const [nodes, setNodes, onNodesChange] = useNodesState<BlockFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [activate, setActivate] = useState(true);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [name, setName] = useState(automation.name);

  const load = useCallback(
    (g: Graph) => {
      const flow = toFlow(g);
      setNodes(flow.nodes);
      setEdges(flow.edges);
      setDirty(false);
      setServerError(null);
      setSelected(flow.nodes[0]?.id ?? null);
    },
    [setNodes, setEdges],
  );
  useEffect(() => {
    if (versionGraph.data) load(versionGraph.data.graph);
  }, [versionGraph.data, load]);

  const graph = useMemo(() => fromFlow(nodes, edges), [nodes, edges]);
  const issues = useMemo(() => validateGraph(graph), [graph]);
  const issuesByNode = useMemo(() => {
    const m = new Map<string, string[]>();
    issues.forEach((i) => i.nodeId && m.set(i.nodeId, [...(m.get(i.nodeId) ?? []), i.message]));
    return m;
  }, [issues]);
  const globalIssues = issues.filter((i) => !i.nodeId).map((i) => i.message);
  const selectedNode = nodes.find((n) => n.id === selected);
  const trigger = graph.nodes.find((n) => n.type.startsWith("trigger."));

  const touch = () => {
    setDirty(true);
    setServerError(null);
  };

  const addBlock = (type: BlockType) => {
    const def = blockCatalog[type];
    if (def.kind === "trigger" && trigger) {
      // Swap the trigger type in place: there is exactly one trigger per automation.
      setNodes((ns) => ns.map((n) => (n.id === trigger.id ? { ...n, data: { block: { ...n.data.block, type, ...defaults[type] } } } : n)));
      touch();
      return;
    }
    const prefix = type.split(".")[1]!;
    let i = 1;
    while (nodes.some((n) => n.id === `${prefix}_${i}`)) i++;
    const id = `${prefix}_${i}`;
    const parent = nodes.find((n) => n.id === selected) ?? nodes[nodes.length - 1];
    const position = parent ? { x: parent.position.x, y: parent.position.y + 150 } : { x: 0, y: 0 };
    setNodes((ns) => [...ns, { id, type: "block", position, data: { block: { id, type, config: defaults[type].config, inputs: prefill(type, trigger) } } }]);
    // Auto-connect from the selected block's first free port.
    if (parent) {
      const ports = blockCatalog[parent.data.block.type as BlockType]?.ports ?? ["out"];
      const port = ports.find((p) => !edges.some((e) => e.source === parent.id && e.sourceHandle === p)) ?? ports[0]!;
      setEdges((es) => [...es, toFlowEdge({ id: `e_${parent.id}_${id}`, source: parent.id, sourcePort: port, target: id })]);
    }
    setSelected(id);
    touch();
  };

  const onConnect = (c: Connection) => {
    setEdges((es) => addEdge({ ...toFlowEdge({ id: `e_${c.source}_${c.sourceHandle}_${c.target}`, source: c.source, sourcePort: c.sourceHandle ?? "out", target: c.target }) }, es));
    touch();
  };

  const save = async () => {
    setSaving(true);
    setServerError(null);
    try {
      const v = await api<{ id: string }>("POST", `/api/automations/${automation.id}/versions`, { graph, activate });
      await reload();
      setVersionId(v.id);
      setDirty(false);
    } catch (e) {
      setServerError(e instanceof ApiError ? [e.message, ...(e.details?.issues?.map((i) => i.message) ?? [])].join(" · ") : String(e));
    } finally {
      setSaving(false);
    }
  };

  const patch = async (body: object) => {
    try {
      await api("PATCH", `/api/automations/${automation.id}`, body);
      await reload();
    } catch (e) {
      setServerError(String((e as Error).message));
    }
  };

  const viewingActive = versionId === automation.active_version_id;
  const viewed = automation.versions.find((v) => v.id === versionId);

  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 260 }}>
          <div className="small muted">
            <Link href="/automations/">Automations</Link> /
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== automation.name && patch({ name })}
            style={{ fontSize: 20, fontWeight: 700, border: "1px solid transparent", padding: "2px 6px", marginLeft: -6, background: "transparent" }}
          />
          <div className="row small" style={{ marginTop: 4 }}>
            <StatusBadge status={automation.status} />
            <span className="muted">Created {fmtDate(automation.created_at)}</span>
            <Link href={`/runs/?automationId=${automation.id}`}>Execution log →</Link>
          </div>
        </div>
        <div className="row">
          <select value={versionId} onChange={(e) => setVersionId(e.target.value)} style={{ width: "auto" }} disabled={dirty} title={dirty ? "Save or discard changes first" : ""}>
            {automation.versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.version}
                {v.id === automation.active_version_id ? " (active)" : ""} · {fmtDate(v.created_at)}
              </option>
            ))}
          </select>
          {!viewingActive && !dirty && (
            <button className="btn" onClick={() => patch({ activeVersionId: versionId })}>
              Make v{viewed?.version} active
            </button>
          )}
          {automation.status === "active" ? (
            <button className="btn" onClick={() => patch({ status: "disabled" })}>Disable</button>
          ) : (
            <button className="btn" onClick={() => patch({ status: "active" })} disabled={automation.status === "archived"}>Activate</button>
          )}
          {dirty && (
            <button className="btn btn-ghost" onClick={() => versionGraph.data && load(versionGraph.data.graph)}>
              Discard
            </button>
          )}
          <label className="checkbox" title="Point the automation at the new version right away">
            <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} /> make active
          </label>
          <button className="btn btn-primary" disabled={!dirty || issues.length > 0 || saving} onClick={save}>
            {saving ? "Saving…" : "Save as new version"}
          </button>
        </div>
      </div>

      {(globalIssues.length > 0 || serverError) && (
        <div className="issues" style={{ marginBottom: 12 }}>
          {serverError ?? globalIssues.join(" · ")}
        </div>
      )}

      <div className="card editor">
        <div className="palette">
          <div className="small muted">Click to add after the selected block</div>
          {blockTypes.map((t) => (
            <div key={t} className="palette-item" onClick={() => addBlock(t)} role="button">
              <div style={{ fontWeight: 600 }}>{blockCatalog[t].label}</div>
              <div className="muted">{blockCatalog[t].kind === "trigger" ? "trigger (replaces)" : blockCatalog[t].kind}</div>
            </div>
          ))}
        </div>
        <div className="canvas">
          <DecorationsContext.Provider value={{ issues: issuesByNode }}>
            {versionGraph.data && (
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={(c) => {
                  onNodesChange(c);
                  if (c.some((x) => x.type === "position" || x.type === "remove")) touch();
                }}
                onEdgesChange={(c) => {
                  onEdgesChange(c);
                  if (c.some((x) => x.type === "remove")) touch();
                }}
                onConnect={onConnect}
                isValidConnection={(c) => c.source !== c.target && !edges.some((e) => e.target === c.target)}
                onNodeClick={(_, n) => setSelected(n.id)}
                onPaneClick={() => setSelected(null)}
                deleteKeyCode={["Backspace", "Delete"]}
                fitView
                fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
                proOptions={{ hideAttribution: true }}
              >
                <Background />
                <Controls />
              </ReactFlow>
            )}
          </DecorationsContext.Provider>
        </div>
        <div className="inspector">
          {selectedNode ? (
            <Inspector
              key={selectedNode.id}
              block={selectedNode.data.block}
              graph={graph}
              issues={issuesByNode.get(selectedNode.id) ?? []}
              onChange={(block) => {
                setNodes((ns) => ns.map((n) => (n.id === block.id ? { ...n, data: { block } } : n)));
                touch();
              }}
              onDelete={
                selectedNode.deletable === false
                  ? undefined
                  : () => {
                      setNodes((ns) => ns.filter((n) => n.id !== selectedNode.id));
                      setEdges((es) => es.filter((e) => e.source !== selectedNode.id && e.target !== selectedNode.id));
                      setSelected(null);
                      touch();
                    }
              }
            />
          ) : (
            <div className="muted">
              <p>Select a block to configure it.</p>
              <p className="small">
                Blocks run top to bottom. Each block has exactly one incoming connection; action inputs can reference outputs of blocks above
                them with <code>{"{{block.output}}"}</code>.
              </p>
              <p className="small">Saving creates a new immutable version. Runs in progress keep the version they started with.</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function EditorPage() {
  const id = useSearchParams().get("id");
  const automation = useApi<AutomationDetail>(id ? `/api/automations/${id}` : null);
  if (!id) return <div className="empty">No automation selected.</div>;
  if (automation.error) return <div className="empty error-text">{String(automation.error.message)}</div>;
  if (!automation.data) return <div className="empty">Loading…</div>;
  return (
    <ReactFlowProvider>
      <Editor automation={automation.data} reload={() => automation.mutate()} />
    </ReactFlowProvider>
  );
}

export default function Page() {
  return (
    <Suspense>
      <EditorPage />
    </Suspense>
  );
}
