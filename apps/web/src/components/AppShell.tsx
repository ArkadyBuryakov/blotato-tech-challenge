"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useApi } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import type { Me } from "@/lib/types";

// 16px stroke icons (lucide-style paths), inlined to avoid an icon dependency.
const icon = (d: string) => (
  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const icons = {
  automations: icon("M13 2 3 14h9l-1 8 10-12h-9l1-8z"),
  templates: icon("M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z"),
  runs: icon("M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"),
  simulator: icon("M5 3l14 9-14 9V3z"),
  logout: icon("M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"),
  collapse: icon("M15 18l-6-6 6-6"),
  expand: icon("M9 18l6-6-6-6"),
};

const nav = [
  { href: "/automations/", label: "Automations", icon: icons.automations },
  { href: "/templates/", label: "Templates", icon: icons.templates },
  { href: "/runs/", label: "Execution log", icon: icons.runs },
];

const COLLAPSED_KEY = "sidebar-collapsed";

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const me = useApi<Me>("/api/me", { shouldRetryOnError: false });
  const config = useApi<{ devTools: boolean; instagramMode: string }>("/api/config");
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSED_KEY) === "1");
    } catch {}
  }, []);

  useEffect(() => {
    if (me.error) router.replace("/");
  }, [me.error, router]);

  if (!me.data) return <div className="empty">Loading…</div>;

  const toggle = () => {
    setCollapsed(!collapsed);
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "0" : "1");
    } catch {}
  };

  const links = config.data?.devTools
    ? [...nav, { href: "/simulator/", label: "Simulator", icon: icons.simulator }]
    : nav;
  return (
    <div className={`shell ${collapsed ? "collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          <span className="nav-label">Automations</span>
          <button
            className="sidebar-toggle"
            onClick={toggle}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? icons.expand : icons.collapse}
          </button>
        </div>
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            title={collapsed ? l.label : undefined}
            className={`nav-link ${path?.startsWith(l.href.slice(0, -1)) ? "active" : ""}`}
          >
            {l.icon}
            <span className="nav-label">{l.label}</span>
          </Link>
        ))}
        <div className="sidebar-footer">
          <div className="nav-label sidebar-user">
            <span>@{me.data.username}</span>
            {config.data?.instagramMode === "mock" && <span className="badge">mock Instagram</span>}
          </div>
          <button
            className="nav-link"
            title={collapsed ? "Log out" : undefined}
            onClick={async () => {
              await authClient.signOut();
              router.replace("/");
            }}
          >
            {icons.logout}
            <span className="nav-label">Log out</span>
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
