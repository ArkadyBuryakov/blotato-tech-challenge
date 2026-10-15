"use client";

import type { AutomationTemplate, Publications, TemplateParam } from "@app/core";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PublicationsPicker } from "@/components/Inspector";
import { Modal } from "@/components/Modal";
import { api, ApiError, useApi } from "@/lib/api";

function ParamField({ param, value, onChange }: { param: TemplateParam; value: unknown; onChange: (v: unknown) => void }) {
  switch (param.kind) {
    case "publications":
      return <PublicationsPicker value={(value as Publications) ?? { mode: "all" }} onChange={onChange} />;
    case "keywords":
      return (
        <label className="field">
          {param.label}
          <input
            placeholder={param.placeholder}
            defaultValue={((value as string[]) ?? []).join(", ")}
            onChange={(e) => onChange(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
          />
          <span className="hint">Comma separated. Leave empty to react to every comment.</span>
        </label>
      );
    case "multiline":
      return (
        <label className="field">
          {param.label}
          <textarea placeholder={param.placeholder} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />
        </label>
      );
    default:
      return (
        <label className="field">
          {param.label}
          <input type={param.kind === "url" ? "url" : "text"} placeholder={param.placeholder} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />
        </label>
      );
  }
}

function UseTemplate({ template, onClose }: { template: AutomationTemplate; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(template.name);
  const [params, setParams] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(template.params.filter((p) => p.defaultValue !== undefined).map((p) => [p.key, p.defaultValue])),
  );
  const [activate, setActivate] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const a = await api<{ id: string }>("POST", `/api/templates/${template.id}/instantiate`, { name, params, activate });
      router.push(`/automations/edit/?id=${a.id}`);
    } catch (err) {
      setErrors(err instanceof ApiError ? (err.details?.issues?.map((i) => i.message) ?? [err.message]) : [String(err)]);
      setBusy(false);
    }
  };

  return (
    <Modal title={template.name} onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>{template.description}</p>
      <form onSubmit={submit}>
        <label className="field">
          Automation name
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        {template.params.map((p) => (
          <ParamField key={p.key} param={p} value={params[p.key]} onChange={(v) => setParams((s) => ({ ...s, [p.key]: v }))} />
        ))}
        <label className="checkbox" style={{ marginBottom: 12 }}>
          <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} /> Activate right away
        </label>
        {errors.length > 0 && (
          <div className="issues" style={{ marginBottom: 12 }}>
            <ul>{errors.map((m) => <li key={m}>{m}</li>)}</ul>
          </div>
        )}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>Create automation</button>
        </div>
      </form>
    </Modal>
  );
}

export default function TemplatesPage() {
  const templates = useApi<AutomationTemplate[]>("/api/templates");
  const [open, setOpen] = useState<AutomationTemplate | null>(null);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Templates</h1>
          <div className="page-sub">Ready-made automations: fill in a few fields and you are live.</div>
        </div>
      </div>
      <div className="grid-cards">
        {templates.data?.map((t) => (
          <div key={t.id} className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <strong>{t.name}</strong>
            <span className="muted">{t.description}</span>
            <span className="small muted">
              {t.graph.nodes.length} blocks · asks for {t.params.filter((p) => p.defaultValue === undefined).map((p) => p.label.toLowerCase()).join(", ")}
            </span>
            <div className="spacer" />
            <div>
              <button className="btn btn-primary" onClick={() => setOpen(t)}>Use template</button>
            </div>
          </div>
        ))}
      </div>
      {open && <UseTemplate template={open} onClose={() => setOpen(null)} />}
    </>
  );
}
