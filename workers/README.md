# Huddle on Cloudflare Workers

The web app, the huddle API, and the link-preview cards, running at the edge on
**D1** (Cloudflare's SQLite) — no cold-start sleep, no ephemeral disk, real
persistence, free tier.

## What runs here vs. what doesn't

| Part | Where |
|---|---|
| Website, huddle API, `/h/:id` cards | **Workers** (this directory) |
| Storage | **D1** — plans survive restarts and redeploys |
| Slack (events webhook), Telegram (webhook) | Workers — *stage 3, see below* |
| Discord (gateway), iMessage relay | **Node build only** (`npm run bots`) — a request-scoped runtime can't hold a long-lived connection |

Everything except the persistent-connection bots is here. The Node build in the
repo root still runs the full set for anyone self-hosting on a box.

## Deploy

```bash
npm install -g wrangler        # or: npx wrangler ...
cd workers
wrangler login

# 1. create the database, paste its id into wrangler.jsonc -> d1_databases[0].database_id
wrangler d1 create huddle

# 2. create the tables
wrangler d1 execute huddle --file schema.sql --remote

# 3. secrets (never commit these)
wrangler secret put ANTHROPIC_API_KEY      # optional — omit for heuristic-only
wrangler secret put SLACK_CLIENT_ID        # optional — Slack distribution
wrangler secret put SLACK_CLIENT_SECRET
wrangler secret put SLACK_SIGNING_SECRET

# 4. ship it
wrangler deploy
```

The `routes` block in `wrangler.jsonc` binds `huddle-hq.com` — that works once
the domain's nameservers are on Cloudflare (Dashboard → add site → follow the
nameserver change at your registrar). Until then, drop the `routes` block and
use the `*.workers.dev` URL wrangler prints.

## The two things to check on first deploy

Both are verified locally against a real SQLite engine and a mock runtime (`npm
test` — the `worker` and `store-d1` suites), but two things can only be
confirmed on Cloudflare itself:

1. **The Claude path on `workerd`.** The app runs fully in heuristic mode with
   no key, so the site works regardless. With `ANTHROPIC_API_KEY` set, confirm a
   `/plan` chat still extracts constraints — if the Anthropic SDK misbehaves on
   the runtime, `llm.mjs` already degrades to the heuristic rather than
   erroring, so the worst case is heuristic-only, not an outage.
2. **The bundled catalog.** `index.mjs` imports `data/venues.json` (Workers
   bundles JSON imports); `setCatalog` injects it because there's no `readFileSync`
   at the edge. `/api/health` returning `huddles` and a `/plan` producing options
   confirms it loaded.

## Stage 3 — Slack + Telegram webhooks on Workers

The Node build's `src/slack-http.mjs` is already webhook-shaped (HMAC-verified
`/slack/events`, OAuth install), but it's written against Node's `req/res` and
the file-based install store. Porting it here means:

- swap `installs.mjs` for `installs(env.DB)` from `store-d1.mjs` (already written),
- return `Response` objects instead of calling `res.writeHead`,
- reuse `verifySlackSignature` unchanged — it's pure.

Telegram is a small `POST /telegram/webhook` that maps an update to the same
`handleEvent` the Node adapter uses. Both are additive; the web app above
doesn't depend on them.
