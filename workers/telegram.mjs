// Telegram on Cloudflare Workers — webhook-based Q&A.
//
// Telegram supports webhooks (unlike Discord's gateway), so it runs on the
// Worker cleanly. It's the lowest-friction platform to add: a user creates a
// bot with @BotFather in seconds — no admin approval, no console.
//
// One route: POST /telegram/webhook. Telegram POSTs an Update for each message;
// we ack fast and answer in ctx.waitUntil so a slow web search never trips
// Telegram's timeout into a retry.
//
// SETUP (all the operator does):
//   1. Message @BotFather -> /newbot -> copy the token
//   2. @BotFather -> /setprivacy -> your bot -> Disable   (so it can read group
//      chatter, not just @mentions — same trap as always; optional if you only
//      want @mention/command replies)
//   3. Set Worker secrets: TELEGRAM_BOT_TOKEN, and TELEGRAM_WEBHOOK_SECRET (any
//      random string you choose).
//   4. Register the webhook once (replace <TOKEN> and <SECRET>):
//      https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://huddle-hq.com/telegram/webhook&secret_token=<SECRET>
//   5. Add the bot to a group, or DM it. @mention it, reply to it, or start with
//      "huddle,".
import { formatAnswer } from '../src/assistant.mjs';
import { loadContext, recordMessage, transcriptOf, claimQuestion, firstTimeSeeing, answerWithCache, PER_CHAT_DAILY } from './chat-state.mjs';

const API = 'https://api.telegram.org';
const WAKE = 'huddle';

export function telegramConfigured(env) {
  return Boolean(env.TELEGRAM_BOT_TOKEN);
}

async function tg(token, method, payload) {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method}: ${data.description || res.status}`);
  return data.result;
}

// Cache the bot's own id + username (needed to detect @mentions and replies).
const identity = new Map();
async function botIdentity(token) {
  if (identity.has(token)) return identity.get(token);
  const me = await tg(token, 'getMe', {});
  const id = { id: me.id, username: (me.username || '').toLowerCase() };
  identity.set(token, id);
  return id;
}

/**
 * In a private chat every message is for the bot. In a group, only when it's
 * @mentioned, replied to, a /command, or prefixed with the wake word — the same
 * "speak only when spoken to" etiquette as every other adapter.
 */
function isAddressed(msg, text, bot) {
  if (msg.chat?.type === 'private') return true;
  const lower = text.toLowerCase();
  if (bot.username && lower.includes(`@${bot.username}`)) return true;
  if (lower.startsWith(`${WAKE},`) || lower.startsWith(`${WAKE} `)) return true;
  if (/^\/(ask|huddle)\b/i.test(text)) return true;
  if (msg.reply_to_message?.from?.id === bot.id) return true;
  return false;
}

/** Strip the @mention, wake word, and /command so the question reads cleanly. */
function cleanQuestion(text, bot) {
  let q = text;
  if (bot.username) q = q.replace(new RegExp(`@${bot.username}`, 'gi'), '');
  q = q.replace(/^\/(ask|huddle)(@\S+)?\s*/i, '');
  q = q.replace(new RegExp(`^${WAKE}[,:]?\\s*`, 'i'), '');
  return q.trim();
}

async function processUpdate(env, update) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;

  const bot = await botIdentity(token);
  const text = msg.text.trim();
  const chatId = msg.chat.id;
  const key = `telegram:${chatId}`;
  const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username || 'Someone';

  if (!isAddressed(msg, text, bot)) {
    // Not for us — keep it as context (if privacy mode is off we see these).
    await recordMessage(env.DB, key, name, text);
    return;
  }

  const question = cleanQuestion(text, bot);
  const context = transcriptOf(await loadContext(env.DB, key));
  await recordMessage(env.DB, key, name, question || text);

  if (!question) {
    await tg(token, 'sendMessage', { chat_id: chatId, text: "I'm here — ask me something." });
    return;
  }

  if (!(await claimQuestion(env.DB, key))) {
    await tg(token, 'sendMessage', {
      chat_id: chatId,
      text: `This chat has hit its daily limit of ${PER_CHAT_DAILY} questions. Resets at midnight UTC.`,
    });
    return;
  }

  await tg(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  const answer = await answerWithCache(env, { question, context, platform: 'telegram', chatId: key });
  await tg(token, 'sendMessage', {
    chat_id: chatId,
    text: formatAnswer(answer),
    reply_to_message_id: msg.message_id,
    disable_web_page_preview: true,
  });
}

export async function handleTelegram(request, env, ctx) {
  if (request.method !== 'POST') return new Response('Not found', { status: 404 });
  if (!telegramConfigured(env)) return new Response('Not configured', { status: 404 });

  // Telegram echoes the secret we set at registration; reject anything else.
  if (
    env.TELEGRAM_WEBHOOK_SECRET &&
    request.headers.get('x-telegram-bot-api-secret-token') !== env.TELEGRAM_WEBHOOK_SECRET
  ) {
    return new Response('unauthorized', { status: 401 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response('bad json', { status: 400 });
  }

  // Ack immediately, then do the slow work — Telegram retries on a slow reply.
  const run = (async () => {
    if (!(await firstTimeSeeing(env.DB, update.update_id))) return;
    try {
      await processUpdate(env, update);
    } catch (err) {
      console.error('[telegram] processing failed:', err.message);
    }
  })();
  ctx?.waitUntil ? ctx.waitUntil(run) : await run;

  return new Response('', { status: 200 });
}
