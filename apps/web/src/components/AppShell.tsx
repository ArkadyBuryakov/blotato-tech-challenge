"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useApi } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import type { Me } from "@/lib/types";

const nav = [
  { href: "/automations/", label: "Automations" },
  { href: "/templates/", label: "Templates" },
  { href: "/runs/", label: "Execution log" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const me = useApi<Me>("/api/me", { shouldRetryOnError: false });
  const config = useApi<{ devTools: boolean; instagramMode: string }>("/api/config");

  useEffect(() => {
    if (me.error) router.replace("/");
  }, [me.error, router]);

  if (!me.data) return <div className="empty">Loading…</div>;

  const links = config.data?.devTools ? [...nav, { href: "/simulator/", label: "Simulator" }] : nav;
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" /> Automations
        </div>
        {links.map((l) => (
          <Link key={l.href} href={l.href} className={`nav-link ${path?.startsWith(l.href.slice(0, -1)) ? "active" : ""}`}>
            {l.label}
          </Link>
        ))}
        <div className="sidebar-footer">
          <span>@{me.data.username}</span>
          {config.data?.instagramMode === "mock" && <span className="badge">mock Instagram</span>}
          <button
            className="btn btn-sm"
            onClick={async () => {
              await authClient.signOut();
              router.replace("/");
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
