// Setup doctor for the iMessage relay.
//
// The iMessage path is the only way Huddle gets into a group chat people are
// already in — but it depends on permissions macOS grants silently and denies
// silently, so a broken setup looks identical to a working one until nothing
// happens. This checks each dependency and says exactly what to fix.
//
//   npm run doctor
import { existsSync, accessSync, constants } from 'node:fs';
import { homedir, platform, release } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const CHAT_DB = join(homedir(), 'Library', 'Messages', 'chat.db');

const ok = (m, d) => console.log(`  \x1b[32m✓\x1b[0m ${m}${d ? `\n      ${d}` : ''}`);
const bad = (m, fix) => console.log(`  \x1b[31m✗\x1b[0m ${m}\n      \x1b[33m→ ${fix}\x1b[0m`);
const warn = (m, d) => console.log(`  \x1b[33m!\x1b[0m ${m}${d ? `\n      ${d}` : ''}`);

let failures = 0;
const fail = (...a) => (failures++, bad(...a));

console.log('\n  Huddle — iMessage setup check\n');

// ---- 1. platform -----------------------------------------------------------
if (platform() !== 'darwin') {
  fail(
    `This is ${platform()}, not macOS.`,
    'Apple ships no bot API and no server-side way in. Use Telegram or Discord instead — ' +
      'both are real bots with no Mac required.'
  );
  console.log('\n  Stopping here; everything below is macOS-only.\n');
  process.exit(1);
}
ok(`macOS (darwin ${release()})`);

// ---- 2. node ---------------------------------------------------------------
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 5)) {
  ok(`Node ${process.versions.node}`, 'node:sqlite available — chat.db is readable natively.');
} else {
  fail(
    `Node ${process.versions.node} is too old.`,
    'The chat.db reader needs node:sqlite, added in 22.5. Upgrade to Node 22.5+ (24 recommended).'
  );
}

// ---- 3. Full Disk Access ---------------------------------------------------
// The single most common failure. macOS does not prompt for this — it just
// returns EPERM forever, so we have to actually try the read.
if (!existsSync(CHAT_DB)) {
  fail(
    'No ~/Library/Messages/chat.db.',
    'Open Messages and sign in at least once, then run this again.'
  );
} else {
  try {
    accessSync(CHAT_DB, constants.R_OK);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(`file:${CHAT_DB}?mode=ro`, { readOnly: true });
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM message').get();
    ok('Full Disk Access granted', `chat.db readable — ${n.toLocaleString()} messages on file.`);
    db.close();
  } catch (err) {
    fail(
      `chat.db exists but cannot be read (${err.code || err.message}).`,
      'System Settings → Privacy & Security → Full Disk Access → add the app that runs node ' +
        '(Terminal, iTerm, VS Code), then FULLY QUIT and reopen it. A restart is required — ' +
        'toggling the switch alone does not apply to an already-running process.'
    );
  }
}

// ---- 4. Messages running ---------------------------------------------------
try {
  const running = execFileSync(
    'osascript',
    ['-e', 'tell application "System Events" to (name of processes) contains "Messages"'],
    { encoding: 'utf8', timeout: 5000 }
  ).trim();
  if (running === 'true') ok('Messages is running');
  else
    warn(
      'Messages is not running.',
      'The relay can only send while Messages is open. Launch it and leave it open.'
    );
} catch {
  warn('Could not ask whether Messages is running.', 'Automation permission may not be granted yet.');
}

// ---- 5. which identity it will speak as ------------------------------------
// This is the thing people are surprised by: replies come from whatever account
// Messages is signed into. Sign in as a dedicated Apple ID and Huddle shows up
// as its own contact instead of as you.
try {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(`file:${CHAT_DB}?mode=ro`, { readOnly: true });
  const rows = db
    .prepare(
      "SELECT DISTINCT account_login FROM chat WHERE account_login IS NOT NULL AND account_login <> ''"
    )
    .all()
    .map((r) => String(r.account_login).replace(/^[EP]:/, ''));
  db.close();

  if (rows.length) {
    const list = rows.slice(0, 4).join(', ');
    warn(
      `Messages is signed in as: ${list}`,
      'Replies will send FROM this account — to the group it looks like you typing.\n' +
        '      For a bot with its own identity, sign this Mac into a separate Apple ID.\n' +
        '      An Apple ID works with just an email; no phone number is required.'
    );
  }
} catch {
  /* covered by the Full Disk Access check above */
}

// ---- 6. automation permission ----------------------------------------------
try {
  execFileSync('osascript', ['-e', 'tell application "Messages" to get name'], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ok('Automation permission granted', 'AppleScript can drive Messages.');
} catch (err) {
  const msg = String(err.stderr || err.message);
  if (/not allowed|1743|authoriz/i.test(msg)) {
    fail(
      'Not allowed to control Messages.',
      'System Settings → Privacy & Security → Automation → your terminal → enable Messages. ' +
        'If it never prompted, run the relay once and approve the dialog.'
    );
  } else {
    warn('Could not verify Automation permission.', msg.split('\n')[0]);
  }
}

// ---- 7. env ----------------------------------------------------------------
if (process.env.ENABLE_IMESSAGE === '1') ok('ENABLE_IMESSAGE=1');
else warn('ENABLE_IMESSAGE is not set.', 'The launcher skips the relay without it.');

const url = process.env.HUDDLE_PUBLIC_URL;
if (url && !/localhost|127\.0\.0\.1/.test(url)) ok(`Share links point at ${url}`);
else
  warn(
    `Share links point at ${url || 'http://localhost:3000'}.`,
    'Nobody else can open that. Set HUDDLE_PUBLIC_URL to a reachable host.'
  );

// ---- verdict ---------------------------------------------------------------
console.log();
if (failures) {
  console.log(`  ${failures} blocking issue${failures > 1 ? 's' : ''}. Fix the → lines above.\n`);
  process.exit(1);
}
console.log('  Ready. Start it with:  ENABLE_IMESSAGE=1 npm run bots\n');
