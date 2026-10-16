import type { ColumnType, Generated, JSONColumnType } from "kysely";
import type { Graph, InboundEvent, StepStatus } from "@app/core";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json<T extends object | null> = JSONColumnType<T, T, T>;

export type AutomationStatus = "disabled" | "active" | "archived";
export type RunStatus = "running" | "waiting" | "succeeded" | "failed";

/** BetterAuth-owned tables (only the columns we read). */
export interface UserTable {
  id: string;
  name: string;
  email: string;
  image: string | null;
  createdAt: Timestamp;
}

export interface AccountTable {
  id: string;
  userId: string;
  providerId: string;
  /** For the instagram provider: the Instagram professional account id (= webhook entry.id). */
  accountId: string;
  accessToken: string | null;
  accessTokenExpiresAt: Timestamp | null;
  scope: string | null;
  updatedAt: Timestamp;
}

export interface AutomationTable {
  id: Generated<string>;
  user_id: string;
  ig_account_id: string;
  name: string;
  status: ColumnType<AutomationStatus, AutomationStatus | undefined, AutomationStatus>;
  active_version_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AutomationVersionTable {
  id: Generated<string>;
  automation_id: string;
  version: number;
  graph: Json<Graph>;
  created_at: Generated<Date>;
}

export interface InboxEventTable {
  id: Generated<number>;
  ig_account_id: string;
  external_id: string;
  kind: InboundEvent["kind"];
  payload: Json<InboundEvent>;
  received_at: Generated<Date>;
  processed_at: Timestamp | null;
}

export interface ContactTable {
  ig_account_id: string;
  igsid: string;
  username: string | null;
  full_name: string | null;
  updated_at: Generated<Date>;
}

export interface RunTable {
  id: Generated<string>;
  automation_id: string;
  version_id: string;
  ig_account_id: string;
  contact_id: string;
  trigger_event_id: number;
  status: RunStatus;
  started_at: Generated<Date>;
  ended_at: Timestamp | null;
}

export interface RunStepTable {
  run_id: string;
  node_id: string;
  status: StepStatus;
  attempts: Generated<number>;
  input: Json<Record<string, unknown>> | null;
  output: Json<Record<string, unknown>> | null;
  error: string | null;
  /** Deadline of a suspended (`waiting`) step. */
  expires_at: Timestamp | null;
  /** Block-private state of a suspended step (e.g. retries used by "Wait for reply"). */
  state: JSONColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown>>;
  started_at: Timestamp | null;
  ended_at: Timestamp | null;
  created_at: Generated<Date>;
}

export interface Database {
  user: UserTable;
  account: AccountTable;
  automations: AutomationTable;
  automation_versions: AutomationVersionTable;
  inbox_events: InboxEventTable;
  contacts: ContactTable;
  runs: RunTable;
  run_steps: RunStepTable;
}
