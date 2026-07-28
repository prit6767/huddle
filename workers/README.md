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

## Slack on Workers (live)

The bot's install flow and Q&A now run on the Worker itself — no separate
process. `GET /slack/install` → consent, `GET /slack/oauth/callback` → stores
the workspace token in D1, `POST /slack/events` → verified events; it reads the
channel for context and answers @mentions with web-searched, sourced replies.

Context, the daily cap, event-dedup and install tokens all live in D1 (Workers
isolates are ephemeral, so the Node build's in-memory state won't do). Slack is
acknowledged inside its 3-second window and the web search runs in
`ctx.waitUntil` after, so a retry never double-charges.

**Turn it on:**

1. Apply the new tables (idempotent — safe to re-run):
   ```bash
   cd workers && wrangler d1 execute huddle --file schema.sql --remote
   ```
2. Create the Slack app at [api.slack.com/apps](https://api.slack.com/apps):
   - **OAuth & Permissions** → Redirect URL: `https://huddle-hq.com/slack/oauth/callback`
   - Bot Token Scopes: `app_mentions:read`, `channels:history`, `groups:history`,
     `im:history`, `chat:write`, `reactions:write`, `channels:read`, `groups:read`, `users:read`
   - **Event Subscriptions** → Request URL: `https://huddle-hq.com/slack/events`
     → subscribe to bot events: `app_mention`, `message.channels`, `message.groups`, `message.im`
   - **Basic Information** → copy the Signing Secret; **Install App** → note the Client ID/Secret
3. Set the secrets and redeploy:
   ```bash
   wrangler secret put SLACK_CLIENT_ID
   wrangler secret put SLACK_CLIENT_SECRET
   wrangler secret put SLACK_SIGNING_SECRET
   wrangler deploy
   ```

The landing page then shows an **Add to Slack** button, and any workspace can
install with one click — no tokens to copy. Verified by unit tests
(`slack-worker`, `slack-http` suites); the live round-trip needs the app above.

## Next platforms for companies

- **Microsoft Teams** — Bot Framework, HTTPS messaging endpoint. Biggest
  enterprise install base; the heaviest adapter (auth + Activity protocol).
- **Google Chat** — Workspace apps, webhook-based and lighter than Teams.

Both are additive and map onto the same `ask()` + D1-context path Slack uses.

## Stage — Telegram webhook + planning over Slack

The Node build's `src/slack-http.mjs` is already webhook-shaped (HMAC-verified
`/slack/events`, OAuth install), but it's written against Node's `req/res` and
the file-based install store. Porting it here means:

- swap `installs.mjs` for `installs(env.DB)` from `store-d1.mjs` (already written),
- return `Response` objects instead of calling `res.writeHead`,
- reuse `verifySlackSignature` unchanged — it's pure.

Telegram is a small `POST /telegram/webhook` that maps an update to the same
`handleEvent` the Node adapter uses. Both are additive; the web app above
doesn't depend on them.
