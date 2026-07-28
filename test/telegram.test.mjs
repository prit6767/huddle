// Telegram on the Worker: webhook secret gate, addressing rules, and the
// answer flow — driven through handleTelegram with a mock env (D1 shim +
// stubbed Telegram API), on the heuristic path.
process.env.HUDDLE_DISABLE_LLM = '1';

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { handleTelegram } from '../workers/telegram.mjs';

const SCHEMA = readFileSync(new URL('../workers/schema.sql', import.meta.url), 'utf8');
const SECRET = 'hook-secret';

function d1Shim() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(SCHEMA);
  return {
    prepare(q) {
      const s = sql.prepare(q);
      let p = [];
      const a = {
        bind(...x) {
          p = x;
          return a;
        },
        first: async () => s.get(...p) ?? null,
        all: async () => ({ results: s.all(...p) }),
        run: async () => {
          s.run(...p);
          return {};
        },
      };
      return a;
    },
  };
}

// Stub the Telegram API; record sendMessage calls. getMe returns the bot id.
function stubFetch(calls) {
  return async (u, opts) => {
    const url = String(u);
    const method = url.split('/').pop();
    const payload = opts?.body ? JSON.parse(opts.body) : {};
    calls.push({ method, payload });
    if (method === 'getMe') return new Response(JSON.stringify({ ok: true, result: { id: 42, username: 'huddlebot' } }));
    return new Response(JSON.stringify({ ok: true, result: {} }));
  };
}

let env, calls, realFetch;
const ctx = { waitUntil: (p) => p };
let pending = [];
const wctx = { waitUntil: (p) => (pending.push(p), p) };
const settle = () => Promise.all(pending).then(() => (pending = []));

beforeEach(() => {
  env = { DB: d1Shim(), TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_WEBHOOK_SECRET: SECRET, HUDDLE_DISABLE_LLM: '1' };
  calls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(calls);
});
const restore = () => (globalThis.fetch = realFetch);

const hook = (update, secret = SECRET) =>
  new Request('https://huddle-hq.com/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify(update),
  });

const sends = () => calls.filter((c) => c.method === 'sendMessage');

describe('telegram: webhook security', () => {
  test('a request with the wrong secret is 401', async () => {
    const res = await handleTelegram(hook({ update_id: 1 }, 'wrong'), env, wctx);
    await settle();
    restore();
    assert.equal(res.status, 401);
  });

  test('the right secret is accepted (200)', async () => {
    const res = await handleTelegram(hook({ update_id: 2 }), env, wctx);
    await settle();
    restore();
    assert.equal(res.status, 200);
  });
});

describe('telegram: addressing', () => {
  test('a private-chat message is always answered', async () => {
    await handleTelegram(
      hook({
        update_id: 10,
        message: { message_id: 1, chat: { id: 5, type: 'private' }, from: { first_name: 'Ana' }, text: 'who won?' },
      }),
      env,
      wctx
    );
    await settle();
    restore();
    assert.equal(sends().length, 1, 'DMs are always addressed');
    assert.equal(sends()[0].payload.chat_id, 5);
  });

  test('a group message that does NOT address the bot is not answered', async () => {
    await handleTelegram(
      hook({
        update_id: 11,
        message: { message_id: 2, chat: { id: -100, type: 'group' }, from: { first_name: 'Ana' }, text: 'just chatting' },
      }),
      env,
      wctx
    );
    await settle();
    restore();
    assert.equal(sends().length, 0, 'the bot stays silent in a group unless addressed');
  });

  test('a group @mention is answered', async () => {
    await handleTelegram(
      hook({
        update_id: 12,
        message: { message_id: 3, chat: { id: -100, type: 'group' }, from: { first_name: 'Ana' }, text: '@huddlebot who won?' },
      }),
      env,
      wctx
    );
    await settle();
    restore();
    assert.equal(sends().length, 1, 'an @mention addresses the bot');
  });

  test('the wake word "huddle," is answered', async () => {
    await handleTelegram(
      hook({
        update_id: 13,
        message: { message_id: 4, chat: { id: -100, type: 'group' }, from: { first_name: 'Ana' }, text: 'huddle, what time is it in Tokyo?' },
      }),
      env,
      wctx
    );
    await settle();
    restore();
    assert.equal(sends().length, 1);
  });

  test('a reply to the bot is answered', async () => {
    await handleTelegram(
      hook({
        update_id: 14,
        message: {
          message_id: 5,
          chat: { id: -100, type: 'group' },
          from: { first_name: 'Ana' },
          text: 'and in London?',
          reply_to_message: { from: { id: 42, is_bot: true } },
        },
      }),
      env,
      wctx
    );
    await settle();
    restore();
    assert.equal(sends().length, 1, 'replying to the bot addresses it');
  });
});

describe('telegram: reliability', () => {
  test('a retried update_id is answered only once', async () => {
    const update = {
      update_id: 20,
      message: { message_id: 6, chat: { id: 5, type: 'private' }, from: { first_name: 'Ana' }, text: 'hi' },
    };
    await handleTelegram(hook(update), env, wctx);
    await settle();
    await handleTelegram(hook(update), env, wctx); // Telegram redelivery
    await settle();
    restore();
    assert.equal(sends().length, 1, 'the retry must not answer again');
  });
});
