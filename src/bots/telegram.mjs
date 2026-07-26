// Telegram adapter. Long-polls getUpdates; no dependencies, no public URL,
// no webhook. Works from a laptop behind NAT.
//
// SETUP (the privacy-mode step is not optional):
//   1. Talk to @BotFather -> /newbot -> copy the token
//   2. @BotFather -> /setprivacy -> pick your bot -> Disable
//      Without this, Telegram only delivers messages that start with "/" and
//      the bot cannot read ordinary chatter — which is the whole product.
//   3. Add the bot to your group chat
//   4. TELEGRAM_BOT_TOKEN=... npm run bots
import { handleEvent, handleVote } from './bridge.mjs';

const API = 'https://api.telegram.org';

// Telegram only accepts reactions from a fixed set; ✅ is not in it.
const REACTION_MAP = { '✅': '👌' };

export function telegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

function makeClient(token) {
  return async function call(method, payload) {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      // Reactions fail on old clients/chats; never let that kill the loop.
      throw new Error(`${method}: ${data.description || res.status}`);
    }
    return data.result;
  };
}

/** Telegram caps messages at 4096 chars; split on blank lines. */
function chunk(text, limit = 3900) {
  if (text.length <= limit) return [text];
  const out = [];
  let buffer = '';
  for (const block of text.split('\n\n')) {
    if (buffer && buffer.length + block.length + 2 > limit) {
      out.push(buffer);
      buffer = block;
    } else {
      buffer = buffer ? `${buffer}\n\n${block}` : block;
    }
  }
  if (buffer) out.push(buffer);
  return out;
}

async function deliver(call, chatId, messageId, action) {
  if (!action || action.silent) return;

  if (action.react) {
    try {
      await call('setMessageReaction', {
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji: REACTION_MAP[action.react] || action.react }],
      });
    } catch (err) {
      console.warn('[telegram] reaction failed:', err.message);
    }
    return;
  }

  if (action.text) {
    const pieces = chunk(action.text);
    for (let i = 0; i < pieces.length; i++) {
      const last = i === pieces.length - 1;
      await call('sendMessage', {
        chat_id: chatId,
        text: pieces[i],
        link_preview_options: { is_disabled: true }, // answers and plans carry many links
        ...(last && action.buttons?.length
          ? {
              reply_markup: {
                inline_keyboard: action.buttons.map((b) => [{ text: b.label, callback_data: b.id }]),
              },
            }
          : {}),
      });
    }
  }
}

export async function startTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const call = makeClient(token);

  const me = await call('getMe', {});
  console.log(`  [telegram] connected as @${me.username}`);
  if (me.can_read_all_group_messages === false) {
    console.warn(
      '  [telegram] ⚠ privacy mode is ON — the bot can only see /commands.\n' +
        '             Fix: @BotFather -> /setprivacy -> select this bot -> Disable,\n' +
        '             then REMOVE and RE-ADD the bot to the group.'
    );
  }

  let offset = 0;
  let backoff = 1000;

  for (;;) {
    let updates;
    try {
      updates = await call('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message', 'callback_query'],
      });
      backoff = 1000;
    } catch (err) {
      console.warn(`[telegram] poll failed (${err.message}) — retrying in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      try {
        if (update.callback_query) {
          const q = update.callback_query;
          const [, , optionId] = q.data.split(':');
          const action = handleVote({
            platform: 'telegram',
            chatId: q.message.chat.id,
            userId: q.from.id,
            userName: q.from.first_name || q.from.username,
            optionId,
          });
          await call('answerCallbackQuery', { callback_query_id: q.id, text: 'Vote counted' });
          await deliver(call, q.message.chat.id, q.message.message_id, action);
          continue;
        }

        const msg = update.message;
        if (!msg?.text || msg.from?.is_bot) continue;

        // "Was the bot spoken to?" — an @mention of us, or a reply to one of
        // our messages. Private chats count as always addressed.
        const handle = `@${me.username}`.toLowerCase();
        const mentioned =
          msg.chat.type === 'private' ||
          (msg.entities || []).some((e) => {
            if (e.type === 'text_mention') return e.user?.id === me.id;
            if (e.type !== 'mention') return false;
            return msg.text.substr(e.offset, e.length).toLowerCase() === handle;
          });
        const repliedToBot = msg.reply_to_message?.from?.id === me.id;

        const action = await handleEvent({
          platform: 'telegram',
          chatId: msg.chat.id,
          chatTitle: msg.chat.title || null,
          userId: msg.from.id,
          userName: msg.from.first_name || msg.from.username,
          // Strip our handle so the question reads naturally to the model.
          text: msg.text.replace(new RegExp(handle, 'gi'), '').trim() || msg.text,
          mentioned,
          repliedToBot,
          typing: () => call('sendChatAction', { chat_id: msg.chat.id, action: 'typing' }),
        });
        await deliver(call, msg.chat.id, msg.message_id, action);
      } catch (err) {
        console.error('[telegram] update failed:', err.message);
      }
    }
  }
}
