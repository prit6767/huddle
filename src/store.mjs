// Persistence for huddles.
//
// Backend: SQLite via node:sqlite (Node 22.5+) — one file, atomic writes,
// survives restarts and redeploys, and needs no external service. On runtimes
// without node:sqlite it degrades to the original write-through JSON file, so
// the app still runs end to end everywhere Node 20 runs.
//
// The interface is deliberately identical either way: huddles are stored as
// whole JSON documents keyed by id. Nothing above this module knows or cares
// which backend is live.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.HUDDLE_DATA_DIR || join(here, '..', 'data');
const JSON_PATH = join(DATA_DIR, 'huddles.json');
const SQLITE_PATH = join(DATA_DIR, 'huddles.sqlite');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------- backends

/** SQLite backend. Throws on construction if node:sqlite is unavailable. */
async function openSqlite() {
  const { DatabaseSync } = await import('node:sqlite');
  const sql = new DatabaseSync(SQLITE_PATH);
  sql.exec('PRAGMA journal_mode = WAL');
  sql.exec(`CREATE TABLE IF NOT EXISTS huddles (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    data TEXT NOT NULL
  )`);

  const upsert = sql.prepare(
    'INSERT INTO huddles (id, created_at, data) VALUES (?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET data = excluded.data'
  );
  const selectOne = sql.prepare('SELECT data FROM huddles WHERE id = ?');
  const selectAll = sql.prepare('SELECT data FROM huddles ORDER BY created_at DESC');

  return {
    name: 'sqlite',
    get(id) {
      const row = selectOne.get(id);
      return row ? JSON.parse(row.data) : null;
    },
    put(huddle) {
      upsert.run(huddle.id, huddle.createdAt, JSON.stringify(huddle));
    },
    list() {
      return selectAll.all().map((r) => JSON.parse(r.data));
    },
    count() {
      return sql.prepare('SELECT COUNT(*) AS n FROM huddles').get().n;
    },
  };
}

/** Original JSON-file backend: single process, write-through on every mutation. */
function openJsonFile() {
  let db = { huddles: {} };
  if (existsSync(JSON_PATH)) {
    try {
      db = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
    } catch {
      console.warn('[store] huddles.json unreadable, starting fresh');
    }
  }
  if (!db.huddles) db.huddles = {};

  function persist() {
    // Write to a temp file then rename, so a crash mid-write can't truncate the db.
    const tmp = `${JSON_PATH}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(db, null, 2));
    renameSync(tmp, JSON_PATH);
  }

  return {
    name: 'json',
    get(id) {
      return db.huddles[id] || null;
    },
    put(huddle) {
      db.huddles[huddle.id] = huddle;
      persist();
    },
    list() {
      return Object.values(db.huddles).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    count() {
      return Object.keys(db.huddles).length;
    },
  };
}

let backend;
try {
  backend = await openSqlite();
  // One-time migration: if a legacy huddles.json exists and the sqlite db is
  // empty, carry the huddles over so nobody loses in-flight plans on upgrade.
  if (backend.count() === 0 && existsSync(JSON_PATH)) {
    try {
      const legacy = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
      const huddles = Object.values(legacy.huddles || {});
      for (const h of huddles) backend.put(h);
      if (huddles.length) console.log(`[store] migrated ${huddles.length} huddle(s) from huddles.json`);
    } catch {
      console.warn('[store] legacy huddles.json unreadable — skipping migration');
    }
  }
} catch (err) {
  console.warn(`[store] node:sqlite unavailable (${err.message}) — using JSON file store`);
  backend = openJsonFile();
}

export const STORE_BACKEND = backend.name;

// ---------------------------------------------------------------- interface

export function id(prefix, bytes = 6) {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

export function createHuddle(fields) {
  const huddle = {
    id: id('h', 5),
    createdAt: new Date().toISOString(),
    participants: [],
    options: [],
    votes: {},
    lockedOptionId: null,
    ...fields,
  };
  backend.put(huddle);
  return huddle;
}

export function getHuddle(huddleId) {
  return backend.get(huddleId);
}

export function saveHuddle(huddle) {
  backend.put(huddle);
  return huddle;
}

export function listHuddles() {
  return backend.list();
}

/**
 * The huddle currently bound to a group chat, if any. Chat bindings are how a
 * bot knows which conversation it is in — one active huddle per chat.
 */
export function findHuddleByChat(platform, chatId) {
  return (
    listHuddles().find(
      (h) =>
        h.binding &&
        h.binding.platform === platform &&
        String(h.binding.chatId) === String(chatId) &&
        !h.binding.closed
    ) || null
  );
}
