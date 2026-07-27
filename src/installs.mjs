// Per-workspace Slack installations.
//
// A distributed app holds one bot token per workspace, so this is the table
// that turns "our Slack" into "any company's Slack". Kept deliberately separate
// from the huddle store: these are credentials, and mixing them into the
// document store that gets handed to publicView() is how one leaks.
//
// Nothing here is ever returned to a browser.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.HUDDLE_DATA_DIR || join(here, '..', 'data');
const SQLITE_PATH = join(DATA_DIR, 'installs.sqlite');
const JSON_PATH = join(DATA_DIR, 'installs.json');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

async function openSqlite() {
  const { DatabaseSync } = await import('node:sqlite');
  const sql = new DatabaseSync(SQLITE_PATH);
  sql.exec('PRAGMA journal_mode = WAL');
  sql.exec(`CREATE TABLE IF NOT EXISTS installs (
    team_id TEXT PRIMARY KEY,
    team_name TEXT,
    bot_token TEXT NOT NULL,
    bot_user_id TEXT,
    installed_at TEXT NOT NULL
  )`);
  const upsert = sql.prepare(
    `INSERT INTO installs (team_id, team_name, bot_token, bot_user_id, installed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(team_id) DO UPDATE SET
       team_name = excluded.team_name,
       bot_token = excluded.bot_token,
       bot_user_id = excluded.bot_user_id,
       installed_at = excluded.installed_at`
  );
  const one = sql.prepare('SELECT * FROM installs WHERE team_id = ?');
  const del = sql.prepare('DELETE FROM installs WHERE team_id = ?');
  return {
    name: 'sqlite',
    put: (r) => upsert.run(r.teamId, r.teamName, r.botToken, r.botUserId, r.installedAt),
    get(teamId) {
      const row = one.get(teamId);
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
    remove: (teamId) => del.run(teamId),
    count: () => sql.prepare('SELECT COUNT(*) AS n FROM installs').get().n,
  };
}

function openJsonFile() {
  let db = {};
  if (existsSync(JSON_PATH)) {
    try {
      db = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
    } catch {
      console.warn('[installs] installs.json unreadable, starting fresh');
    }
  }
  const persist = () => {
    const tmp = `${JSON_PATH}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
    renameSync(tmp, JSON_PATH);
  };
  return {
    name: 'json',
    put(r) {
      db[r.teamId] = r;
      persist();
    },
    get: (teamId) => db[teamId] || null,
    remove(teamId) {
      delete db[teamId];
      persist();
    },
    count: () => Object.keys(db).length,
  };
}

let backend;
try {
  backend = await openSqlite();
} catch (err) {
  console.warn(`[installs] node:sqlite unavailable (${err.message}) — using JSON file`);
  backend = openJsonFile();
}

export function saveInstall({ teamId, teamName, botToken, botUserId }) {
  backend.put({
    teamId,
    teamName: teamName || null,
    botToken,
    botUserId: botUserId || null,
    installedAt: new Date().toISOString(),
  });
}

export const getInstall = (teamId) => backend.get(teamId);
export const removeInstall = (teamId) => backend.remove(teamId);
export const installCount = () => backend.count();
