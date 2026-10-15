# Instagram comment & DM automations

Take-home for Blotato: a backend (plus a UI) that lets customers automate conversations that begin
with a comment on their Instagram posts.

> Someone comments **"pricing"** → reply *"Sent you a DM!"* → DM asking for their email →
> **wait for the reply** → once a valid email arrives, DM them a link.

That flow ships as a template, but underneath it is a general **graph of trigger, action and control
blocks**. Versions are immutable, every run is logged, and all of it runs on Postgres + pg-boss.

**Docs**
- [Architecture, data model, execution model, reliability & concurrency](docs/architecture.md)
- [Deployment: Heroku and the AWS/Terraform alternative](docs/deployment.md)
- [Where AI was used](docs/ai-usage.md)

## Stack

TypeScript everywhere, written in a functional style: pure domain functions in `packages/core`,
dependencies passed explicitly as records of functions, and effects kept at the edges.

| | |
|---|---|
| Frontend | Next.js 16 static export, React Flow editor, SWR |
| Backend | Fastify 5, Kysely, Zod |
| Auth | BetterAuth with a `genericOAuth` Instagram Login provider (tokens encrypted at rest) |
| Jobs | pg-boss 12 (transactional enqueue, LISTEN/NOTIFY, crons) |
| DB | Postgres |
| Deploy | Heroku (web / worker / release), AWS plan in docs |

```
packages/core    pure domain: block catalog, graph validation, templating, webhook normalization,
                 trigger matching, DM addressing, templates (unit tested)
apps/server      Fastify API + webhooks, engine (router, executor, waits), pg-boss worker, migrations
apps/web         Next.js UI: automations, graph editor, templates, execution log, simulator
```

## Run locally

Needs Node ≥ 24, pnpm and Docker.

```bash
make up      # Postgres (docker), .env from .env.example, pnpm install, API+worker on :3001, web on :3000
make logs    # follow app logs
make down    # stop the app and Postgres (data is kept in the docker volume)
```

`make up` runs the app in the background. To run it in the foreground instead:
`docker compose up -d && pnpm dev`.

Open http://localhost:3000 and click **Continue with Instagram**. In mock mode this goes through
the real BetterAuth OAuth flow against a local stand-in for instagram.com. Then:

1. **Templates** → *Comment keyword → collect email → send link* → enter `pricing` and a link.
2. **Simulator** → post the comment "What's the pricing?", then send the DM "jane@example.com".
   Simulated events are real Meta webhook payloads and go through the same pipeline.
3. **Execution log** → open the run: the table view and graph view show every step's input/output.

Outbound Instagram calls are logged by the mock client (`mock instagram: send message …`).
The mock also plays Instagram's messaging rules (24h DM window, one private reply per comment),
which the app itself does not imitate. It learns about comments and DMs from the simulator and keeps
that in memory, so after a server restart, earlier simulated comments are unknown to it.

## Tests

```bash
make up      # also creates the automations_test database
pnpm test
```

- `packages/core`: graph validation, templating, webhook normalization, keyword matching,
  email-wait decisions, DM vs private-reply selection.
- `apps/server/test/e2e.test.ts`: real Postgres + pg-boss + Fastify with a recording mock
  Instagram client. Covers OAuth login and token encryption, template params, signature
  verification, the full pricing flow (private reply → re-ask → link DM), webhook redelivery dedupe,
  one in-flight run per person, wait timeout, versioning and rollback, and permanent API failures.

## Live Instagram

Set `INSTAGRAM_MODE=live` and the Instagram app credentials, and configure the Meta app as described
in [deployment](docs/deployment.md#heroku-demo). With Standard Access, only accounts that have a
role on the Meta app can connect. Comment webhooks need Advanced Access; until then,
`COMMENT_RECONCILER=true` polls recent comments through the same deduplicated inbox.
