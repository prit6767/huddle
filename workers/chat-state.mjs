// Shared per-chat state for the Worker's messaging adapters (Slack, Google
// Chat, Telegram). Workers isolates are ephemeral, so the rolling context, the
// daily spend cap, and event-dedup all live in D1 rather than memory.
//
// Keyed by a caller-supplied chat key like "telegram:<chatId>" or
// "slack:<team>:<channel>" — the platform scopes itself so two platforms (or
// two workspaces) never share a buffer, a cap, or a dedup entry.
export const CONTEXT_MESSAGES = 20;
export const PER_CHAT_DAILY = 50;

const today = () => new Date().toISOString().slice(0, 10);

export async function loadContext(db, key) {
  const row = await db.prepare('SELECT messages FROM chatlog WHERE chat_key = ?').bind(key).first();
  if (!row) return [];
  try {
    return JSON.parse(row.messages);
  } catch {
    return [];
  }
}

export async function recordMessage(db, key, name, text) {
  const msgs = await loadContext(db, key);
  msgs.push({ name: (name || 'Someone').slice(0, 40), text: String(text).slice(0, 500), at: Date.now() });
  const trimmed = msgs.slice(-CONTEXT_MESSAGES);
  await db
    .prepare(
      `INSERT INTO chatlog (chat_key, messages, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(chat_key) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at`
    )
    .bind(key, JSON.stringify(trimmed), new Date().toISOString())
    .run();
}

export const transcriptOf = (msgs) => msgs.map((m) => `${m.name}: ${m.text}`).join('\n');

/** Claim one question against the durable daily cap. True if within the cap. */
export async function claimQuestion(db, key, limit = PER_CHAT_DAILY) {
  const day = today();
  await db
    .prepare(
      `INSERT INTO usage (day, chat_key, used) VALUES (?, ?, 1)
       ON CONFLICT(day, chat_key) DO UPDATE SET used = used + 1`
    )
    .bind(day, key)
    .run();
  const row = await db.prepare('SELECT used FROM usage WHERE day = ? AND chat_key = ?').bind(day, key).first();
  return (row?.used ?? 1) <= limit;
}

/** True the first time an id is seen; the platform retries otherwise. */
export async function firstTimeSeeing(db, id) {
  if (!id) return true;
  try {
    await db.prepare('INSERT INTO seen_events (event_id, seen_at) VALUES (?, ?)').bind(String(id), new Date().toISOString()).run();
    return true;
  } catch {
    return false; // primary-key clash = already processed
  }
}
