"use client";

import { blockCatalog, isBlockType } from "@app/core";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, Suspense, useMemo, useState } from "react";
import useSWRInfinite from "swr/infinite";
import { CounterBadges, StatusBadge } from "@/components/Badges";
import { GraphView } from "@/components/flow";
import { api, useApi } from "@/lib/api";
import { fmtDate, fmtDuration } from "@/lib/format";
import type { AutomationListItem, RunDetail, RunListItem, RunStep } from "@/lib/types";

type Page = { items: RunListItem[]; nextCursor: string | null };

const blockLabel = (graph: RunDetail["graph"], nodeId: string) => {
  const type = graph.nodes.find((n) => n.id === nodeId)?.type ?? "";
  return isBlockType(type) ? blockCatalog[type].label : type;
};

const Json = ({ value }: { value: unknown }) =>
  value && Object.keys(value as object).length ? <pre className="json">{JSON.stringify(value, null, 2)}</pre> : <span className="muted">—</span>;

function StepDetail({ step }: { step: RunStep }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
      <div>
        <div className="small muted">Input</div>
        <Json value={step.input} />
      </div>
      <div>
        <div className="small muted">{step.error ? "Error" : "Output"}</div>
        {step.error ? <div className="issues">{step.error}</div> : <Json value={step.output} />}
      </div>
    </div>
  );
}

function RunDetailView({ runId }: { runId: string }) {
  const run = useApi<RunDetail>(`/api/runs/${runId}`, { refreshInterval: (d) => (d && (d.status === "running" || d.status === "waiting") ? 3000 : 0) });
  const [view, setView] = useState<"table" | "graph">("table");
  const [focus, setFocus] = useState<string | null>(null);
  const statuses = useMemo(() => new Map(run.data?.steps.map((s) => [s.node_id, s.status])), [run.data]);
  if (!run.data) return <div className="muted">Loading…</div>;
  const r = run.data;
  const focused = r.steps.find((s) => s.node_id === focus);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="row">
        <div className="tabs">
          <button className={view === "table" ? "on" : ""} onClick={() => setView("table")}>Table</button>
          <button className={view === "graph" ? "on" : ""} onClick={() => setView("graph")}>Graph</button>
        </div>
        <span className="small muted">
          Run <code>{r.id}</code> · contact <code>{r.contact_id}</code> · v{r.version}
        </span>
      </div>

      {view === "table" ? (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Block</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {r.steps.map((s) => (
                <Fragment key={s.node_id}>
                  <tr className="clickable" onClick={() => setFocus(focus === s.node_id ? null : s.node_id)}>
                    <td>
                      <strong>{blockLabel(r.graph, s.node_id)}</strong> <span className="mono muted">{s.node_id}</span>
                    </td>
                    <td><StatusBadge status={s.status} /></td>
                    <td>{s.attempts ?? "—"}</td>
                    <td className="muted">{fmtDate(s.started_at)}</td>
                    <td className="muted">
                      {s.status === "waiting" && s.expires_at ? `until ${fmtDate(s.expires_at)}` : s.started_at ? fmtDuration(s.started_at, s.ended_at ?? null) : "—"}
                    </td>
                    <td className="small">
                      {s.error ? <span className="error-text">{s.error}</span> : <span className="muted">{focus === s.node_id ? "hide" : "show"}</span>}
                    </td>
                  </tr>
                  {focus === s.node_id && (
                    <tr>
                      <td colSpan={6}>
                        <StepDetail step={s} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card">
          <GraphView graph={r.graph} statuses={statuses} onSelect={setFocus} height={380} />
          {focused && (
            <div className="card-pad" style={{ borderTop: "1px solid var(--border)" }}>
              <div className="row" style={{ marginBottom: 8 }}>
                <strong>{blockLabel(r.graph, focused.node_id)}</strong>
                <StatusBadge status={focused.status} />
              </div>
              <StepDetail step={focused} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RunsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const automationId = params.get("automationId") ?? "";
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const automations = useApi<AutomationListItem[]>("/api/automations");

  const runs = useSWRInfinite<Page>(
    (i, prev: Page | null) => {
      if (prev && !prev.nextCursor) return null;
      const q = new URLSearchParams();
      if (automationId) q.set("automationId", automationId);
      if (status) q.set("status", status);
      if (prev?.nextCursor) q.set("cursor", prev.nextCursor);
      return `/api/runs?${q}`;
    },
    (p: string) => api<Page>("GET", p),
    { refreshInterval: 5000 },
  );
  const items = runs.data?.flatMap((p) => p.items) ?? [];
  const hasMore = !!runs.data?.[runs.data.length - 1]?.nextCursor;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Execution log</h1>
          <div className="page-sub">Every run of every automation. Click a run to see its steps.</div>
        </div>
        <div className="row">
          <select
            value={automationId}
            style={{ width: "auto" }}
            onChange={(e) => router.replace(e.target.value ? `/runs/?automationId=${e.target.value}` : "/runs/")}
          >
            <option value="">All automations</option>
            {automations.data?.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}>
            <option value="">Any status</option>
            {["running", "waiting", "succeeded", "failed"].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="card table-wrap">
        {runs.data && items.length === 0 ? (
          <div className="empty">No runs yet. They appear here when someone triggers an active automation.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Automation</th>
                <th>Version</th>
                <th>Contact</th>
                <th>Status</th>
                <th>Start</th>
                <th>End</th>
                <th>Steps</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <Fragment key={r.id}>
                  <tr className="clickable" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <td><strong>{r.automation_name}</strong></td>
                    <td>v{r.version}</td>
                    <td className="muted">{r.contact_username ? `@${r.contact_username}` : <code>{r.contact_id}</code>}</td>
                    <td><StatusBadge status={r.status} /></td>
                    <td className="muted">{fmtDate(r.started_at)}</td>
                    <td className="muted">{fmtDate(r.ended_at)}</td>
                    <td><CounterBadges counters={r.counters} /></td>
                  </tr>
                  {open === r.id && (
                    <tr>
                      <td colSpan={7} style={{ background: "var(--bg)" }}>
                        <RunDetailView runId={r.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {hasMore && (
        <div className="row" style={{ justifyContent: "center", marginTop: 12 }}>
          <button className="btn" onClick={() => runs.setSize(runs.size + 1)}>Load more</button>
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <RunsPage />
    </Suspense>
  );
}
