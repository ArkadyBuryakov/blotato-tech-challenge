"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { blockCatalog, isBlockType } from "@app/core";
import { StatusBadge } from "@/components/Badges";
import { Modal } from "@/components/Modal";
import { api, useApi } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import type { AutomationListItem, AutomationStatus } from "@/lib/types";

export default function AutomationsPage() {
  const router = useRouter();
  const [archived, setArchived] = useState(false);
  const list = useApi<AutomationListItem[]>(`/api/automations?archived=${archived}`);

  const setStatus = async (a: AutomationListItem, status: AutomationStatus) => {
    await api("PATCH", `/api/automations/${a.id}`, { status });
    await list.mutate();
  };

  const [newName, setNewName] = useState<string | null>(null);
  const createBlank = async (e: React.FormEvent) => {
    e.preventDefault();
    const a = await api<{ id: string }>("POST", "/api/automations", { name: newName });
    router.push(`/automations/edit/?id=${a.id}`);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Automations</h1>
          <div className="page-sub">Triggers on comments and DMs, running actions on your behalf.</div>
        </div>
        <div className="row">
          <div className="tabs">
            <button className={!archived ? "on" : ""} onClick={() => setArchived(false)}>Current</button>
            <button className={archived ? "on" : ""} onClick={() => setArchived(true)}>Archived</button>
          </div>
          <Link className="btn" href="/templates/">From template</Link>
          <button className="btn btn-primary" onClick={() => setNewName("New automation")}>New automation</button>
        </div>
      </div>

      <div className="card table-wrap">
        {list.data?.length === 0 ? (
          <div className="empty">
            {archived ? "No archived automations." : <>No automations yet. Start from a <Link href="/templates/">template</Link>.</>}
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Trigger</th>
                <th>Active version</th>
                <th>Runs</th>
                <th>Created</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data?.map((a) => (
                <tr key={a.id} className="clickable" onClick={() => router.push(`/automations/edit/?id=${a.id}`)}>
                  <td><strong>{a.name}</strong></td>
                  <td><StatusBadge status={a.status} /></td>
                  <td>{a.trigger_type && isBlockType(a.trigger_type) ? blockCatalog[a.trigger_type].label : "—"}</td>
                  <td>{a.active_version ? `v${a.active_version}` : "—"}</td>
                  <td>
                    <Link href={`/runs/?automationId=${a.id}`} onClick={(e) => e.stopPropagation()}>{a.run_count}</Link>
                  </td>
                  <td className="muted">{fmtDate(a.created_at)}</td>
                  <td className="muted">{fmtDate(a.updated_at)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                      {a.status === "active" && <button className="btn btn-sm" onClick={() => setStatus(a, "disabled")}>Disable</button>}
                      {a.status === "disabled" && <button className="btn btn-sm" onClick={() => setStatus(a, "active")}>Activate</button>}
                      {a.status !== "archived" ? (
                        <button className="btn btn-sm btn-ghost" onClick={() => setStatus(a, "archived")}>Archive</button>
                      ) : (
                        <button className="btn btn-sm" onClick={() => setStatus(a, "disabled")}>Restore</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {newName !== null && (
        <Modal title="New automation" onClose={() => setNewName(null)}>
          <form onSubmit={createBlank}>
            <label className="field">
              Name
              <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} required />
            </label>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={() => setNewName(null)}>Cancel</button>
              <button className="btn btn-primary">Create</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
