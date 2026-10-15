import type { Graph, StepStatus } from "@app/core";

export type Me = { id: string; name: string; image: string | null; igAccountId: string; username: string };

export type AutomationStatus = "disabled" | "active" | "archived";

export type AutomationListItem = {
  id: string;
  name: string;
  status: AutomationStatus;
  active_version_id: string | null;
  active_version: number | null;
  trigger_type: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
};

export type VersionSummary = { id: string; version: number; created_at: string };

export type AutomationDetail = Omit<AutomationListItem, "active_version" | "trigger_type" | "run_count"> & {
  versions: VersionSummary[];
  latest: VersionSummary & { graph: Graph };
  active: (VersionSummary & { graph: Graph }) | null;
};

export type RunStatus = "running" | "waiting" | "succeeded" | "failed";

export type RunListItem = {
  id: string;
  status: RunStatus;
  started_at: string;
  ended_at: string | null;
  contact_id: string;
  contact_username: string | null;
  automation_id: string;
  automation_name: string;
  version_id: string;
  version: number;
  counters: Partial<Record<StepStatus, number>>;
};

export type RunStep = {
  run_id: string;
  node_id: string;
  status: StepStatus;
  attempts?: number;
  input?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
  error?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  wait_expires_at?: string | null;
};

export type RunDetail = Omit<RunListItem, "counters" | "version_id" | "contact_username"> & {
  graph: Graph;
  trigger_event: unknown;
  steps: RunStep[];
};

export type Media = { id: string; permalink: string; caption: string; thumbnailUrl: string | null; timestamp: string };
