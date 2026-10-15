"use client";

import Link from "next/link";
import { useState } from "react";
import { api, ApiError, useApi } from "@/lib/api";
import type { Media } from "@/lib/types";

type Log = { at: string; text: string; ok: boolean };

/**
 * Dev/demo tool: produces real Meta-shaped webhook payloads for a fake follower, so the whole
 * pipeline (inbox → router → worker → Instagram client) can be exercised without Meta.
 */
export default function SimulatorPage() {
  const media = useApi<Media[]>("/api/instagram/media");
  const [fromId, setFromId] = useState("1784000000099");
  const [username, setUsername] = useState("curious.follower");
  const [mediaId, setMediaId] = useState("");
  const [comment, setComment] = useState("What's the pricing?");
  const [dm, setDm] = useState("my email is jane@example.com");
  const [log, setLog] = useState<Log[]>([]);

  const send = async (body: object, label: string) => {
    try {
      const r = await api<{ inserted: number; duplicates: number }>("POST", "/api/dev/simulate", body);
      setLog((l) => [{ at: new Date().toLocaleTimeString(), text: `${label} → ${r.inserted ? "ingested" : "ignored (own message or duplicate)"}`, ok: true }, ...l]);
    } catch (e) {
      setLog((l) => [{ at: new Date().toLocaleTimeString(), text: `${label} → ${e instanceof ApiError ? e.message : String(e)}`, ok: false }, ...l]);
    }
  };

  const selectedMedia = mediaId || media.data?.[0]?.id || "";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Simulator</h1>
          <div className="page-sub">
            Send comments and DMs as a fake follower. They go through the same webhook pipeline as real events; watch the result in the{" "}
            <Link href="/runs/">execution log</Link>.
          </div>
        </div>
      </div>

      <div className="grid-cards">
        <div className="card card-pad">
          <h2>Follower</h2>
          <label className="field">
            Instagram-scoped user id
            <input value={fromId} onChange={(e) => setFromId(e.target.value)} />
            <span className="hint">Change it to act as a different person.</span>
          </label>
          <label className="field">
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
        </div>

        <div className="card card-pad">
          <h2>Comment on a post</h2>
          <label className="field">
            Post
            <select value={selectedMedia} onChange={(e) => setMediaId(e.target.value)}>
              {media.data?.map((m) => (
                <option key={m.id} value={m.id}>{m.caption.slice(0, 50) || m.permalink}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Comment
            <input value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
          <button className="btn btn-primary" onClick={() => send({ kind: "comment", text: comment, mediaId: selectedMedia, fromId, username }, `comment “${comment}”`)}>
            Post comment
          </button>
        </div>

        <div className="card card-pad">
          <h2>Send a DM</h2>
          <label className="field">
            Message
            <textarea value={dm} onChange={(e) => setDm(e.target.value)} />
          </label>
          <button className="btn btn-primary" onClick={() => send({ kind: "message", text: dm, fromId }, `DM “${dm}”`)}>
            Send DM
          </button>
        </div>
      </div>

      {log.length > 0 && (
        <div className="card card-pad" style={{ marginTop: 14 }}>
          <h2>Events</h2>
          {log.map((l, i) => (
            <div key={i} className={`small ${l.ok ? "" : "error-text"}`}>
              <span className="muted mono">{l.at}</span> {l.text}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
