import { sql } from "kysely";
import type { DB } from "./client";

/**
 * Forward-only SQL migrations, applied in order by the Heroku `release` phase.
 * Rules (because web and worker may briefly run different releases during deploys):
 * additive changes only; drop/rename in a later release once no code reads the old shape.
 */
export const migrations: readonly { id: string; sql: string }[] = [
  {
    id: "001_better_auth",
    // Generated with better-auth's getMigrations().compileMigrations().
    sql: `
create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);
create table "session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);
create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);
create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);
create index "session_userId_idx" on "session" ("userId");
create index "account_userId_idx" on "account" ("userId");
create index "verification_identifier_idx" on "verification" ("identifier");
-- An Instagram account belongs to exactly one user: webhooks are routed by it.
create unique index "account_provider_account_idx" on "account" ("providerId", "accountId");
`,
  },
  {
    id: "002_automations",
    sql: `
create table automations (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references "user"(id) on delete cascade,
  ig_account_id text not null,
  name text not null,
  status text not null default 'disabled' check (status in ('disabled', 'active', 'archived')),
  active_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index automations_user_idx on automations (user_id, updated_at desc);
create index automations_routing_idx on automations (ig_account_id) where status = 'active';

-- Immutable snapshots. Runs pin a version, so editing never changes in-flight runs.
create table automation_versions (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references automations(id) on delete cascade,
  version int not null,
  graph jsonb not null,
  created_at timestamptz not null default now(),
  unique (automation_id, version),
  unique (automation_id, id)
);
-- Composite FK: the active version must belong to the same automation.
alter table automations add constraint automations_active_version_fk
  foreign key (id, active_version_id) references automation_versions (automation_id, id) deferrable initially deferred;
`,
  },
  {
    id: "003_execution",
    sql: `
-- Inbox: every inbound webhook event, deduplicated by Meta's ids (Meta retries for up to 36h).
create table inbox_events (
  id bigserial primary key,
  ig_account_id text not null,
  external_id text not null,
  kind text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (ig_account_id, external_id)
);
create index inbox_events_unprocessed_idx on inbox_events (received_at) where processed_at is null;
-- Catch-up lookup for replies that arrive before a wait step has started.
create index inbox_events_sender_idx on inbox_events (ig_account_id, (payload->>'senderId'), received_at) where kind = 'message';

-- People who interacted with an account.
create table contacts (
  ig_account_id text not null,
  igsid text not null,
  username text,
  full_name text,
  last_inbound_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (ig_account_id, igsid)
);

create table runs (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references automations(id) on delete cascade,
  version_id uuid not null references automation_versions(id),
  ig_account_id text not null,
  contact_id text not null,
  trigger_event_id bigint not null references inbox_events(id),
  status text not null check (status in ('running', 'waiting', 'succeeded', 'failed')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  -- A redelivered/replayed event never starts the same automation twice.
  unique (automation_id, trigger_event_id)
);
-- At most one in-flight run per automation and person: commenting "pricing" three times
-- does not send three DMs, and replies correlate to a single conversation.
create unique index runs_one_inflight_idx on runs (automation_id, contact_id) where status in ('running', 'waiting');
create index runs_waiting_contact_idx on runs (ig_account_id, contact_id) where status = 'waiting';
create index runs_automation_idx on runs (automation_id, started_at desc);
create index runs_account_started_idx on runs (ig_account_id, started_at desc);

-- One row per executed node; (run_id, node_id) is the idempotency key for step jobs.
create table run_steps (
  run_id uuid not null references runs(id) on delete cascade,
  node_id text not null,
  status text not null check (status in ('pending', 'running', 'waiting', 'succeeded', 'failed', 'timed_out', 'skipped')),
  attempts int not null default 0,
  input jsonb,
  output jsonb,
  error text,
  wait_expires_at timestamptz,
  wait_retries int not null default 0,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (run_id, node_id)
);

-- Instagram allows a single private reply per comment until the user answers.
create table private_replies (
  comment_id text primary key,
  run_id uuid not null references runs(id) on delete cascade,
  node_id text not null,
  created_at timestamptz not null default now()
);
`,
  },
  {
    id: "004_no_instagram_rule_state",
    // Messaging windows and the one-private-reply-per-comment limit are enforced by Instagram,
    // not imitated in-app, so their bookkeeping goes away.
    sql: `
alter table contacts drop column last_inbound_at;
drop table private_replies;
`,
  },
  {
    id: "005_generic_step_state",
    // Suspended steps are block-agnostic: a deadline plus block-private state. Backfilled from the
    // wait-for-reply columns (dropped in 006).
    sql: `
alter table run_steps add column expires_at timestamptz, add column state jsonb not null default '{}';
update run_steps set expires_at = wait_expires_at, state = jsonb_build_object('retries', wait_retries) where status = 'waiting';
`,
  },
  {
    id: "006_drop_wait_columns",
    // Replaced by expires_at / state in 005.
    sql: `
alter table run_steps drop column wait_expires_at, drop column wait_retries;
`,
  },
];

export const migrate = async (db: DB, log: (m: string) => void = console.log): Promise<void> => {
  await sql`create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())`.execute(db);
  // Serialize concurrent migrators (e.g. two release phases) with an advisory lock.
  await db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(727274)`.execute(trx);
    const applied = new Set(
      (await sql<{ id: string }>`select id from schema_migrations`.execute(trx)).rows.map((r) => r.id),
    );
    for (const m of migrations.filter((m) => !applied.has(m.id))) {
      log(`applying migration ${m.id}`);
      await sql.raw(m.sql).execute(trx);
      await sql`insert into schema_migrations (id) values (${m.id})`.execute(trx);
    }
  });
};
