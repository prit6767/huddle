// D1-backed store for the Workers runtime.
//
// The Node build opens a SQLite file at import time and exposes synchronous
// functions. Workers can't do that: D1 arrives as a per-request binding
// (env.DB), not a module a handler can import. So the store here is a factory —
// `store(db)` returns the same logical interface, async, bound to one request's
// D1 handle. The pure logic (consensus, recommend, extract) is untouched; only
// the persistence boundary changes.
import { randomBytes } from 'node:crypto';

export function id(prefix, bytes = 6) {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

/**
 * Bind the store to a D1 database handle.
 * `db` is a D1Database (env.DB) — or, in tests, anything with the same
 * prepare().bind().first()/all()/run() surface.
 */
export function store(db) {
  return {
    async createHuddle(fields) {
      const huddle = {
        id: id('h', 5),
        createdAt: new Date().toISOString(),
        participants: [],
        options: [],
        votes: {},
        lockedOptionId: null,
        ...fields,
      };
      await this.saveHuddle(huddle);
      return huddle;
    },

    async getHuddle(huddleId) {
      const row = await db
        .prepare('SELECT data FROM huddles WHERE id = ?')
        .bind(huddleId)
        .first();
      return row ? JSON.parse(row.data) : null;
    },

    async saveHuddle(huddle) {
      await db
        .prepare(
          `INSERT INTO huddles (id, created_at, data) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET data = excluded.data`
        )
        .bind(huddle.id, huddle.createdAt, JSON.stringify(huddle))
        .run();
      return huddle;
    },

    async listHuddles() {
      const { results } = await db
        .prepare('SELECT data FROM huddles ORDER BY created_at DESC')
        .all();
      return (results || []).map((r) => JSON.parse(r.data));
    },

    /**
     * The huddle bound to a group chat, if any. Kept identical to the Node
     * build: one active huddle per (platform, chatId), closed ones ignored,
     * chat ids compared as strings so a numeric Telegram id matches.
     */
    async findHuddleByChat(platform, chatId) {
      const all = await this.listHuddles();
      return (
        all.find(
          (h) =>
            h.binding &&
            h.binding.platform === platform &&
            String(h.binding.chatId) === String(chatId) &&
            !h.binding.closed
        ) || null
      );
    },
  };
}

/** Slack installs — separate table, never serialised to a browser. */
export function installs(db) {
  return {
    async save({ teamId, teamName, botToken, botUserId }) {
      await db
        .prepare(
          `INSERT INTO installs (team_id, team_name, bot_token, bot_user_id, installed_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(team_id) DO UPDATE SET
             team_name = excluded.team_name,
             bot_token = excluded.bot_token,
             bot_user_id = excluded.bot_user_id,
             installed_at = excluded.installed_at`
        )
        .bind(teamId, teamName || null, botToken, botUserId || null, new Date().toISOString())
        .run();
    },

    async get(teamId) {
      const row = await db.prepare('SELECT * FROM installs WHERE team_id = ?').bind(teamId).first();
      return row
        ? {
            teamId: row.team_id,
            teamName: row.team_name,
            botToken: row.bot_token,
            botUserId: row.bot_user_id,
            installedAt: row.installed_at,
          }
        : null;
    },
  };
}
