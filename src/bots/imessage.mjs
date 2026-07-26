// iMessage adapter — a local relay on your own Mac.
//
// Apple ships no bot API for iMessage, and there is no server-side way to join
// a conversation. What DOES work, and is how every "iMessage bot" is actually
// built, is automating the Messages app on a Mac you control:
//   - read:  ~/Library/Messages/chat.db (the local SQLite store)
//   - send:  AppleScript against the Messages app
//
// Consequences you should know before relying on this:
//   * It only runs while that Mac is awake, logged in, and Messages is running.
//   * The terminal running this needs Full Disk Access:
//       System Settings -> Privacy & Security -> Full Disk Access -> add Terminal
//       (or iTerm / VS Code — whichever app launches node), then restart it.
//   * First run also triggers an Automation prompt to control Messages. Allow it.
//   * chat.db is an internal Apple format. It changes between macOS releases;
//     this reader is defensive but is not a supported interface.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { handleEvent, handleVote } from './bridge.mjs';

const CHAT_DB = join(homedir(), 'Library', 'Messages', 'chat.db');
const POLL_MS = Number(process.env.IMESSAGE_POLL_MS || 2000);

export function imessageConfigured() {
  return process.platform === 'darwin' && process.env.ENABLE_IMESSAGE === '1';
}

// ---------------------------------------------------------------- reading

/**
 * Recent macOS often leaves `message.text` NULL and stores the body in
 * `attributedBody`, an NSArchiver typedstream blob. Pull the string out of it.
 */
function decodeAttributedBody(blob) {
  if (!blob) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);

  const marker = buf.indexOf('NSString');
  if (marker !== -1) {
    // After "NSString" there are a few class/version bytes, then 0x2B ('+')
    // introduces a length-prefixed UTF-8 run. The gap varies by macOS version,
    // so scan a small window instead of assuming a fixed offset.
    for (let p = marker + 8; p < Math.min(marker + 24, buf.length - 2); p++) {
      if (buf[p] !== 0x2b) continue;
      let q = p + 1;
      let len = buf[q++];
      if (len === 0x81) {
        len = buf.readUInt16LE(q);
        q += 2;
      } else if (len === 0x82) {
        len = buf.readUInt32LE(q);
        q += 4;
      }
      if (len > 0 && q + len <= buf.length) {
        const text = buf.subarray(q, q + len).toString('utf8');
        if (text.trim()) return text;
      }
    }
  }

  // Fallback: longest printable run in the blob. Crude, but better than
  // dropping a message because Apple changed a byte offset.
  const runs = buf.toString('utf8').match(/[\x20-\x7E -￿]{4,}/g);
  if (!runs?.length) return null;
  const best = runs.sort((a, b) => b.length - a.length)[0].trim();
  return best.startsWith('streamtyped') ? null : best;
}

function openDb() {
  try {
    return new DatabaseSync(CHAT_DB, { readOnly: true });
  } catch (err) {
    throw new Error(
      `cannot open ${CHAT_DB} (${err.message}).\n` +
        '  Grant Full Disk Access to the app running node:\n' +
        '  System Settings -> Privacy & Security -> Full Disk Access -> + your terminal,\n' +
        '  then fully quit and reopen that terminal.'
    );
  }
}

const RECENT_SQL = `
  SELECT m.ROWID          AS rowid,
         m.text           AS text,
         m.attributedBody AS attributed_body,
         c.guid           AS chat_guid,
         c.display_name   AS chat_name,
         c.chat_identifier AS chat_identifier,
         h.id             AS handle
    FROM message m
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    JOIN chat c                ON c.ROWID = cmj.chat_id
    LEFT JOIN handle h         ON h.ROWID = m.handle_id
   WHERE m.ROWID > ? AND m.is_from_me = 0
   ORDER BY m.ROWID ASC
   LIMIT 50`;

// ---------------------------------------------------------------- sending

/** Arguments go through argv, so message text never touches AppleScript syntax. */
const SEND_SCRIPT = `
on run argv
  set chatGuid to item 1 of argv
  set msg to item 2 of argv
  tell application "Messages"
    send msg to chat id chatGuid
  end tell
end run`;

function sendMessage(chatGuid, text) {
  return new Promise((resolve, reject) => {
    const proc = spawn('osascript', ['-', chatGuid, text], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(stderr.trim() || `osascript exited ${code}`))
    );
    proc.stdin.end(SEND_SCRIPT);
  });
}

// ---------------------------------------------------------------- loop

export async function startIMessage() {
  const db = openDb();

  // Start from "now" so a first run doesn't replay months of history.
  let lastRowId = db.prepare('SELECT COALESCE(MAX(ROWID), 0) AS max FROM message').get().max;
  console.log(`  [imessage] watching chat.db from message #${lastRowId}`);

  for (;;) {
    let rows = [];
    try {
      rows = db.prepare(RECENT_SQL).all(lastRowId);
    } catch (err) {
      console.error('[imessage] read failed:', err.message);
      await new Promise((r) => setTimeout(r, POLL_MS * 5));
      continue;
    }

    for (const row of rows) {
      lastRowId = Math.max(lastRowId, row.rowid);
      const text = row.text || decodeAttributedBody(row.attributed_body);
      if (!text?.trim()) continue;

      try {
        const action = await handleEvent({
          platform: 'imessage',
          chatId: row.chat_guid,
          chatTitle: row.chat_name || row.chat_identifier || null,
          userId: row.handle || row.chat_identifier || 'unknown',
          userName: row.handle || 'Someone',
          text: text.trim(),
        });

        // No tapback API worth relying on, so a silent ack really is silent.
        // Only actual replies get sent — which is the right etiquette anyway.
        if (action?.text) await sendMessage(row.chat_guid, action.text);
      } catch (err) {
        console.error('[imessage] handling failed:', err.message);
      }
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
