// Tiny JSON-file store. Single process, write-through on every mutation.
// Swap for Postgres/SQLite when you outgrow one box.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, '..', 'data');
const DB_PATH = join(DATA_DIR, 'huddles.json');

let db = { huddles: {} };

function load() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(DB_PATH)) {
    try {
      db = JSON.parse(readFileSync(DB_PATH, 'utf8'));
    } catch {
      console.warn('[store] huddles.json unreadable, starting fresh');
      db = { huddles: {} };
    }
  }
  if (!db.huddles) db.huddles = {};
}

function persist() {
  // Write to a temp file then rename, so a crash mid-write can't truncate the db.
  const tmp = `${DB_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, DB_PATH);
}

load();

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
  db.huddles[huddle.id] = huddle;
  persist();
  return huddle;
}

export function getHuddle(huddleId) {
  return db.huddles[huddleId] || null;
}

export function saveHuddle(huddle) {
  db.huddles[huddle.id] = huddle;
  persist();
  return huddle;
}

export function listHuddles() {
  return Object.values(db.huddles).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
