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
