# Functional requirements

- Registration/authorization pages for unauthenticated users
  - OAuth: Instagram professional/creator account
  - Required permissions:
    - instagram_business_basic
    - instagram_business_manage_comments
    - instagram_business_manage_messages
- Automations
  - Page with the automations list
  - Automation fields:
    - name: str, required, non-unique
    - created_at: datetime
    - updated_at: datetime
    - status: enum (disabled, active, archived)
    - active_version
  - Automations consist of trigger blocks and action blocks as nodes, with directional connections between them
  - Automations should be versioned
- Templates: prepared automations for a specific scenario with only a few fields missing. On create, prompt the user to fill in the missing field values and create a new automation.
- Execution log
  - Shows a list of runs with:
    - automation
    - automation version
    - start_time
    - end_time
    - block execution_status counters (a list of badges `{status: counter}` for every status in the run)
  - Grouped by run_id
  - Per-run extended view: on click, we should be able to open a detailed view in place with all tasks from the version and their statuses
    - table view
    - graph view

## Automation

We do not use any extra entities to store users' credentials for automations. We use their Instagram OAuth instead.

## Trigger blocks

Trigger blocks can have only static input_variables.

### DM

Receiving a DM

Input variables: None

Output variables:
- message_data
- user_data

message_data:
- user_id
- message_id
- message_type
- message_payload

user_data:
- user_id
- profile tag
- profile full name

### Comment

Receiving a comment under a publication

Input variables:
- publications (all, or a list of URLs)

Output variables:
- comment_data
- user_data

comment_data:
- publication_id
- comment_id
- comment_text

## Action blocks

Action blocks can take input_variables from other blocks' output variables.

### Send a DM

Input variables:
- user_id
- message_text

Output variables:
- ...input_variables
- execution status
- message_id

### Comment reply

Input variables:
- comment_id
- message_text

Output variables:
- ...input_variables
- execution status
- reply_id

# Non-functional requirements

- Auth: BetterAuth with a custom genericOAuth provider for Instagram
- Frontend: Next.js
- Backend: TypeScript, Fastify framework
- Worker: pg-boss
- Prod (demo) deployment: Heroku (plus a write-up on an alternative AWS deployment with Terraform)

## Architecture: resources

- **Domain**: `demo.example.com`, Cloudflare DNS (CNAME to Heroku, DNS only), Heroku ACM certificate
- **Heroku app `automations`** (one slug, three process types)
  - `web`: Fastify; serves the Next.js static export, `/api/*` (REST, BetterAuth, Instagram OAuth callback), `/api/webhooks/instagram`
  - `worker`: pg-boss jobs (router, steps, wait expiry, comment reconciler, token refresh cron)
  - `release`: DB migrations on deploy
- **Heroku Postgres**: single source of truth (users, connected accounts, automations, inbox, runs, pg-boss queue)
- **External (Meta)**
  - Instagram Login OAuth (`instagram_business_basic`, `_manage_comments`, `_manage_messages`)
  - Webhooks: `comments`, `messages`
  - Instagram Graph API: comment replies, private replies, DMs
- **Sizing**
  - Demo: web Basic ×1, worker Basic ×1, Postgres Essential-0 (~$19/mo)
  - Production: web Standard-1X ×2 (preboot), worker Standard-2X ×2, Postgres Standard-0 (~$200/mo)
