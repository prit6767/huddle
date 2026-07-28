// Google Chat on the Worker: auth gate, the MESSAGE → reply flow, lifecycle,
// and retry-dedup — driven through handleGoogleChat with a mock env (D1 shim +
// stubbed token verification), on the heuristic path.
process.env.HUDDLE_DISABLE_LLM = '1';

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { handleGoogleChat } from '../workers/google-chat.mjs';

const SCHEMA = readFileSync(new URL('../workers/schema.sql', import.meta.url), 'utf8');

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

// Stub Google's tokeninfo endpoint: "good-token" verifies for project 42.
let realFetch;
function stubFetch() {
  return async (u) => {
    const url = String(u);
    if (url.includes('oauth2.googleapis.com/tokeninfo')) {
      const ok = url.includes('good-token');
      return new Response(
        JSON.stringify(ok ? { email: 'chat@system.gserviceaccount.com', email_verified: true, aud: '42' } : { error: 'invalid' }),
        { status: ok ? 200 : 400 }
      );
    }
    return new Response('{}');
  };
}

let env;
beforeEach(() => {
  env = { DB: d1Shim(), GOOGLE_PROJECT_NUMBER: '42', HUDDLE_DISABLE_LLM: '1' };
  realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch();
});
const restore = () => (globalThis.fetch = realFetch);

const req = (body, token = 'good-token') =>
  new Request('https://huddle-hq.com/google/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

describe('google chat: auth', () => {
  test('a request without a valid Google token is 401', async () => {
    const res = await handleGoogleChat(req({ type: 'MESSAGE' }, 'forged'), env);
    restore();
    assert.equal(res.status, 401);
  });

  test('a request with no token at all is 401', async () => {
    const bare = new Request('https://huddle-hq.com/google/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'MESSAGE' }),
    });
    const res = await handleGoogleChat(bare, env);
    restore();
    assert.equal(res.status, 401);
  });

  test('wrong audience (different project) is rejected', async () => {
    env.GOOGLE_PROJECT_NUMBER = '99'; // token is for project 42
    const res = await handleGoogleChat(req({ type: 'MESSAGE' }), env);
    restore();
    assert.equal(res.status, 401);
  });
});

describe('google chat: messages', () => {
  test('a MESSAGE gets a synchronous text reply', async () => {
    const res = await handleGoogleChat(
      req({
        type: 'MESSAGE',
        space: { name: 'spaces/AAA' },
        user: { displayName: 'Ana' },
        message: { name: 'spaces/AAA/messages/1', argumentText: 'who won?', text: '@Huddle who won?' },
      }),
      env
    );
    restore();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.text, 'reply carries text');
  });

  test('ADDED_TO_SPACE returns a friendly hello', async () => {
    const res = await handleGoogleChat(req({ type: 'ADDED_TO_SPACE', space: { name: 'spaces/AAA' } }), env);
    restore();
    const body = await res.json();
    assert.match(body.text, /Huddle/);
  });

  test('a retried message id is answered only once', async () => {
    const payload = {
      type: 'MESSAGE',
      space: { name: 'spaces/AAA' },
      user: { displayName: 'Ana' },
      message: { name: 'spaces/AAA/messages/dup', argumentText: 'hi', text: '@Huddle hi' },
    };
    const first = await handleGoogleChat(req(payload), env);
    const second = await handleGoogleChat(req(payload), env);
    restore();
    assert.ok((await first.json()).text, 'first answers');
    // The retry is a bare 200 with an empty body — no second answer posted.
    assert.equal(second.status, 200);
    assert.equal((await second.text()).trim(), '', 'the retry does not answer again');
  });

  test('the daily cap is enforced per space', async () => {
    const space = 'spaces/CAP';
    for (let i = 0; i < 50; i++) {
      await handleGoogleChat(
        req({
          type: 'MESSAGE',
          space: { name: space },
          user: { displayName: 'Ana' },
          message: { name: `${space}/messages/${i}`, argumentText: `q${i}` },
        }),
        env
      );
    }
    const over = await handleGoogleChat(
      req({
        type: 'MESSAGE',
        space: { name: space },
        user: { displayName: 'Ana' },
        message: { name: `${space}/messages/over`, argumentText: 'one more' },
      }),
      env
    );
    restore();
    const body = await over.json();
    assert.match(body.text, /daily limit/i);
  });
});
