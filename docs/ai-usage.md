# Where I used AI

> **Draft. Edit before submitting.** Only you can say exactly which parts you did yourself.
> The facts below come from how this repository was produced.

## Done by me
- Product requirements and scope: block set, versioning, templates, execution log
  (`challenge_input/requirements.md`, not committed).
- Stack and infrastructure decisions: BetterAuth + genericOAuth for Instagram, Fastify,
  Next.js static export on the same origin, pg-boss, a single Heroku app with web/worker/release,
  Cloudflare DNS (`challenge_input/architecture.md`).
- Research on the Instagram platform constraints that shaped the design: the 24h messaging
  window, single private reply per comment, webhook retry behaviour, access levels, and the
  token model (`research/`, not committed).
- Review of the generated design and code; <!-- list what you changed, rejected or rewrote -->

## Done with AI (Claude Code)
- Implementation of the code in this repository from the documents above: core domain package,
  engine, API, web UI, tests.
- The design write-up in `docs/` (architecture, data model, execution model, reliability),
  drafted from the requirements and research and then reviewed by me.
- Checking library APIs against the installed versions (BetterAuth 1.7, pg-boss 12, Next.js 16).

## How I verified it
- `pnpm test`: core unit tests and an end-to-end suite against real Postgres with a mock
  Instagram client. The suite covers OAuth login, the full "pricing" flow, dedupe, re-asking for
  an email, timeouts, versioning and permanent failures.
- <!-- live test with real Instagram accounts / demo video link -->
