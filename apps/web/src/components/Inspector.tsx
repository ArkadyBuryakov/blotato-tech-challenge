"use client";

import { ancestors, blockCatalog, isBlockType, type Graph, type Publications } from "@app/core";
import { useRef } from "react";
import { useApi } from "@/lib/api";
import type { Media } from "@/lib/types";
import type { BlockData } from "./flow";

type Block = BlockData["block"];

/** Text input for templated values with clickable chips for upstream output variables. */
function TemplatedField({
  label,
  value,
  multiline,
  variables,
  onChange,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  variables: { ref: string; label: string }[];
  onChange: (v: string) => void;
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const insert = (token: string) => {
    const el = ref.current;
    const at = el?.selectionStart ?? value.length;
    onChange(value.slice(0, at) + token + value.slice(el?.selectionEnd ?? at));
  };
  return (
    <label className="field">
      {label}
      {multiline ? (
        <textarea ref={ref} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input ref={ref} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
      {variables.length > 0 && (
        <span className="var-chips">
          {variables.map((v) => (
            <button type="button" key={v.ref} className="var-chip" title={v.ref} onClick={() => insert(v.ref)}>
              {v.label}
            </button>
          ))}
        </span>
      )}
    </label>
  );
}

export function PublicationsPicker({ value, onChange }: { value: Publications; onChange: (p: Publications) => void }) {
  const media = useApi<Media[]>(value.mode === "list" ? "/api/instagram/media" : null);
  const selected = new Set(value.mode === "list" ? value.items.map((i) => i.mediaId) : []);
  const toggle = (m: Media) => {
    const items = value.mode === "list" ? value.items : [];
    onChange({
      mode: "list",
      items: selected.has(m.id) ? items.filter((i) => i.mediaId !== m.id) : [...items, { mediaId: m.id, url: m.permalink }],
    });
  };
  return (
    <div className="field" style={{ display: "block", marginBottom: 12 }}>
      <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>Publications</div>
      <div className="row" style={{ marginBottom: 8 }}>
        <label className="checkbox">
          <input type="radio" checked={value.mode === "all"} onChange={() => onChange({ mode: "all" })} /> All publications
        </label>
        <label className="checkbox">
          <input type="radio" checked={value.mode === "list"} onChange={() => onChange({ mode: "list", items: [] } as unknown as Publications)} />{" "}
          Selected
        </label>
      </div>
      {value.mode === "list" && (
        <div className="media-pick">
          {media.isLoading && <span className="muted small">Loading your posts…</span>}
          {media.error && <span className="error-text small">Could not load posts</span>}
          {media.data?.map((m) => (
            <label key={m.id} title={m.permalink}>
              <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m)} />
              <span>{m.caption ? m.caption.slice(0, 60) : m.permalink}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function Inspector({
  block,
  graph,
  issues,
  onChange,
  onDelete,
}: {
  block: Block;
  graph: Graph;
  issues: string[];
  onChange: (b: Block) => void;
  onDelete?: () => void;
}) {
  if (!isBlockType(block.type)) return <div className="muted">Unknown block type {block.type}</div>;
  const def = blockCatalog[block.type];
  const setConfig = (patch: Record<string, unknown>) => onChange({ ...block, config: { ...block.config, ...patch } });
  const setInput = (key: string, v: string) => onChange({ ...block, inputs: { ...block.inputs, [key]: v } });

  const variables = ancestors(graph, block.id).flatMap((nodeId) => {
    const n = graph.nodes.find((x) => x.id === nodeId);
    if (!n || !isBlockType(n.type)) return [];
    return blockCatalog[n.type].outputs.map((o) => ({ ref: `{{${nodeId}.${o}}}`, label: `${nodeId}.${o}` }));
  });
  const cfg = block.config as Record<string, unknown>;

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>{def.label}</h2>
        {onDelete && (
          <button className="btn btn-sm btn-danger" onClick={onDelete}>
            Delete
          </button>
        )}
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        {def.description} <span className="mono">id: {block.id}</span>
      </p>
      {issues.length > 0 && (
        <div className="issues" style={{ marginBottom: 12 }}>
          <ul>
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      )}

      {block.type === "trigger.comment" && (
        <>
          <PublicationsPicker value={(cfg.publications as Publications) ?? { mode: "all" }} onChange={(publications) => setConfig({ publications })} />
          <label className="field">
            Keywords
            <input
              defaultValue={((cfg.keywords as string[]) ?? []).join(", ")}
              placeholder="pricing, price"
              onChange={(e) => setConfig({ keywords: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
            />
            <span className="hint">Comma separated, whole-word and case-insensitive. Empty = every comment.</span>
          </label>
        </>
      )}
      {block.type === "trigger.dm" && <p className="muted small">Runs on every incoming direct message that is not a reply to a waiting conversation.</p>}

      {def.inputFields.map((f) => (
        <TemplatedField
          key={f.key}
          label={f.label}
          multiline={f.multiline}
          value={block.inputs[f.key] ?? ""}
          variables={variables}
          onChange={(v) => setInput(f.key, v)}
        />
      ))}

      {block.type === "control.wait_for_reply" && (
        <>
          <label className="field">
            Expect
            <select value={(cfg.expect as string) ?? "any"} onChange={(e) => setConfig({ expect: e.target.value })}>
              <option value="any">Any reply</option>
              <option value="email">A valid email address</option>
            </select>
          </label>
          <label className="field">
            Timeout (hours)
            <input type="number" min={1} max={168} value={(cfg.timeoutHours as number) ?? 23} onChange={(e) => setConfig({ timeoutHours: Number(e.target.value) })} />
            <span className="hint">After the timeout the run continues through the “timeout” port.</span>
          </label>
          {cfg.expect === "email" && (
            <>
              <label className="field">
                Message when the reply is not an email
                <textarea value={(cfg.retryMessage as string) ?? ""} onChange={(e) => setConfig({ retryMessage: e.target.value })} />
              </label>
              <label className="field">
                Max re-asks
                <input type="number" min={0} max={5} value={(cfg.maxRetries as number) ?? 2} onChange={(e) => setConfig({ maxRetries: Number(e.target.value) })} />
              </label>
            </>
          )}
        </>
      )}

      <div className="small muted" style={{ marginTop: 16 }}>
        Outputs: {def.outputs.map((o) => <code key={o} style={{ marginRight: 6 }}>{o}</code>)}
      </div>
    </div>
  );
}
