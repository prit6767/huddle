-- D1 schema for the Cloudflare Workers deployment.
--
-- Same document-store shape as the Node build's SQLite file: whole huddles as
-- JSON keyed by id, and Slack installs kept in their own table so credentials
-- never share a row with data that gets serialised to a browser.
--
-- Apply:  wrangler d1 execute huddle --file workers/schema.sql --remote

CREATE TABLE IF NOT EXISTS huddles (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  data       TEXT NOT NULL
);

-- findHuddleByChat scans bindings; an index on created_at keeps the ordered
-- scan cheap while the table is small, and the app caps its own growth.
CREATE INDEX IF NOT EXISTS idx_huddles_created ON huddles (created_at DESC);

CREATE TABLE IF NOT EXISTS installs (
  team_id      TEXT PRIMARY KEY,
  team_name    TEXT,
  bot_token    TEXT NOT NULL,
  bot_user_id  TEXT,
  installed_at TEXT NOT NULL
);

-- Rolling per-chat context for the bot's Q&A. In the Node build this lives in
-- memory; Workers isolates are ephemeral, so on Cloudflare it has to be durable.
-- One row per chat, the recent messages as a JSON array, trimmed on write.
-- These are other people's messages, so the row is bounded and disposable.
CREATE TABLE IF NOT EXISTS chatlog (
  chat_key   TEXT PRIMARY KEY,   -- "slack:<team>:<channel>"
  messages   TEXT NOT NULL,      -- JSON: [{name, text, at}]
  updated_at TEXT NOT NULL
);

-- One-time "what happened before I joined" note. When Huddle first lands in a
-- channel it reads the prior history and compresses ALL of it into a compact
-- background summary (the raw history is far too large to feed into every
-- answer). This note is then prepended to the context on every reply, so the
-- bot draws on the whole backstory, not just the last handful of messages.
CREATE TABLE IF NOT EXISTS channel_bg (
  chat_key   TEXT PRIMARY KEY,   -- "slack:<team>:<channel>"
  summary    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Per-chat daily question counter — the spend guardrail, durable across
-- isolates. (day, chat_key) so a new UTC day starts everyone fresh.
CREATE TABLE IF NOT EXISTS usage (
  day       TEXT NOT NULL,
  chat_key  TEXT NOT NULL,
  used      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, chat_key)
);

-- Distinct people who have actually talked to the bot — the "how many users"
-- metric. Privacy-preserving: we store a one-way HASH of platform+scope+userId,
-- never the raw id, never a name, never message content. It exists only to
-- count unique people and when they were last active.
CREATE TABLE IF NOT EXISTS seen_users (
  user_key   TEXT PRIMARY KEY,   -- sha256(platform:scope:userId), truncated
  platform   TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);

-- Durable spend ledger. The in-memory ledger in budget.mjs is per-isolate, so
-- on Workers it never accumulates. This persists the real token/search usage of
-- each (non-cached) answer, per day and chat, so the admin can show estimated $.
CREATE TABLE IF NOT EXISTS spend (
  day           TEXT NOT NULL,
  chat_key      TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  searches      INTEGER NOT NULL DEFAULT 0,
  calls         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, chat_key)
);

-- Slack retries an unacknowledged event; a retry that re-answers costs money.
-- A short-lived seen-events table dedupes them across isolates.
CREATE TABLE IF NOT EXISTS seen_events (
  event_id TEXT PRIMARY KEY,
  seen_at  TEXT NOT NULL
);

-- Answer cache. The in-memory cache in budget.mjs is per-isolate, so it's a
-- no-op on Workers — a re-asked question re-charged Claude every time. This
-- makes it durable: the same question in the same chat, within the TTL, is
-- served free. Keyed per chat so a context-shaped answer never leaks across
-- chats.
CREATE TABLE IF NOT EXISTS answer_cache (
  cache_key  TEXT PRIMARY KEY,   -- "<chatId>::<normalized question>"
  answer     TEXT NOT NULL,      -- JSON {text, sources}
  expires_at INTEGER NOT NULL    -- epoch ms
);
