// Bot launcher. Starts whichever adapters are configured and keeps them up.
//
//   TELEGRAM_BOT_TOKEN=...  -> Telegram
//   DISCORD_BOT_TOKEN=...   -> Discord
//   ENABLE_IMESSAGE=1       -> iMessage relay (macOS only)
//
// Run alongside the web server: `npm start` in one terminal, `npm run bots`
// in another. They share data/huddles.json, so a plan started in a group chat
// opens in the browser at the same URL.
import { telegramConfigured, startTelegram } from './telegram.mjs';
import { discordConfigured, startDiscord } from './discord.mjs';
import { imessageConfigured, startIMessage } from './imessage.mjs';
import { llmAvailable, MODEL } from '../llm.mjs';
import { PUBLIC_URL } from './bridge.mjs';

/** Keep a long-running adapter alive across transient failures. */
async function supervise(name, start) {
  let backoff = 2000;
  for (;;) {
    try {
      await start();
      // Adapters that return (Discord) manage their own connection from here.
      return;
    } catch (err) {
      console.error(`[${name}] crashed: ${err.message}`);
      console.error(`[${name}] restarting in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

const adapters = [
  ['telegram', telegramConfigured, startTelegram, 'set TELEGRAM_BOT_TOKEN'],
  ['discord', discordConfigured, startDiscord, 'set DISCORD_BOT_TOKEN'],
  [
    'imessage',
    imessageConfigured,
    startIMessage,
    process.platform === 'darwin' ? 'set ENABLE_IMESSAGE=1' : 'macOS only',
  ],
];

const active = adapters.filter(([, configured]) => configured());

console.log('\n  Huddle bots');
console.log(`  Planning engine: ${llmAvailable() ? MODEL : 'heuristic fallback'}`);
console.log(`  Share links point at: ${PUBLIC_URL}\n`);

if (!active.length) {
  console.log('  Nothing configured. Enable at least one:');
  for (const [name, , , hint] of adapters) console.log(`    ${name.padEnd(9)} ${hint}`);
  console.log('\n  See README -> "Adding it to a group chat".\n');
  process.exit(1);
}

for (const [name, , , hint] of adapters) {
  if (!active.some(([n]) => n === name)) console.log(`  [${name}] off (${hint})`);
}

await Promise.all(active.map(([name, , start]) => supervise(name, start)));

// Telegram and iMessage loop forever; Discord holds an open socket. If every
// adapter somehow returns, keep the process alive rather than exiting silently.
await new Promise(() => {});
