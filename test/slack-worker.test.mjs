// Slack on the Worker: OAuth callback, signature gate, and the Q&A flow —
// driven through handleSlack with a mock env (D1 shim + stubbed fetch), on the
// heuristic path so no model or network is needed.
process.env.HUDDLE_DISABLE_LLM = '1';

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { handleSlack } from '../workers/slack.mjs';
import { installs } from '../workers/store-d1.mjs';

const SCHEMA = readFileSync(new URL('../workers/schema.sql', import.meta.url), 'utf8');
const SECRET = 'test_signing_secret';
const now = () => Math.floor(Date.now() / 1000);
const sign = (body, ts = now()) => `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;

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
          s.run(...p); // throws on PK conflict — which the dedup path relies on
          return {};
        },
      };
      return a;
    },
  };
}

// Capture Slack Web API calls made via global fetch.
function stubFetch(calls) {
  return async (u, opts) => {
    const url = String(u);
    let payload = null;
    if (opts?.body) {
      try {
        payload = JSON.parse(opts.body); // Web API calls are JSON
      } catch {
        payload = Object.fromEntries(new URLSearchParams(String(opts.body))); // OAuth is form-encoded
      }
    }
    calls.push({ url, payload });
    if (url.includes('/api/oauth.v2.access')) {
      return new Response(
        JSON.stringify({ ok: true, team: { id: 'T1', name: 'Acme' }, access_token: 'xoxb-live', bot_user_id: 'UBOT' })
      );
    }
    if (url.includes('/api/users.info')) {
      return new Response(JSON.stringify({ ok: true, user: { profile: { display_name: 'Ana' } } }));
    }
    if (url.includes('/api/chat.postMessage')) return new Response(JSON.stringify({ ok: true, ts: '1.1' }));
    return new Response(JSON.stringify({ ok: true }));
  };
}

let env, calls, realFetch;
beforeEach(() => {
  env = {
    DB: d1Shim(),
    SLACK_CLIENT_ID: 'cid',
    SLACK_CLIENT_SECRET: 'csec',
    SLACK_SIGNING_SECRET: SECRET,
    HUDDLE_DISABLE_LLM: '1',
  };
  calls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(calls);
});
const restore = () => (globalThis.fetch = realFetch);

const events = (raw, ts = now()) =>
  new Request('https://huddle-hq.com/slack/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sign(raw, ts) },
    body: raw,
  });

describe('slack worker: install', () => {
  test('the install route redirects to Slack consent with the right scopes', async () => {
    const res = await handleSlack(new Request('https://huddle-hq.com/slack/install'), env, null, 'https://huddle-hq.com');
    restore();
    assert.equal(res.status, 302);
    const loc = res.headers.get('location');
    assert.match(loc, /slack\.com\/oauth\/v2\/authorize/);
    assert.match(loc, /chat%3Awrite/);
    assert.match(loc, /redirect_uri=https%3A%2F%2Fhuddle-hq\.com%2Fslack%2Foauth%2Fcallback/);
  });

  test('the OAuth callback stores the workspace token in D1', async () => {
    const res = await handleSlack(
      new Request('https://huddle-hq.com/slack/oauth/callback?code=abc&state=x'),
      env,
      null,
      'https://huddle-hq.com'
    );
    restore();
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Huddle is in Acme/);
    const saved = await installs(env.DB).get('T1');
    assert.equal(saved.botToken, 'xoxb-live');
    assert.equal(saved.botUserId, 'UBOT');
  });
});

describe('slack worker: events security', () => {
  test('an unsigned events request is rejected 401', async () => {
    const raw = JSON.stringify({ type: 'url_verification', challenge: 'c' });
    const bad = new Request('https://huddle-hq.com/slack/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
    });
    const res = await handleSlack(bad, env, null, 'https://huddle-hq.com');
    restore();
    assert.equal(res.status, 401);
  });

  test('url_verification echoes the challenge when signed', async () => {
    const raw = JSON.stringify({ type: 'url_verification', challenge: 'echo-me' });
    const res = await handleSlack(events(raw), env, null, 'https://huddle-hq.com');
    restore();
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'echo-me');
  });
});

describe('slack worker: answering', () => {
  async function withInstall() {
    await installs(env.DB).save({ teamId: 'T1', teamName: 'Acme', botToken: 'xoxb-live', botUserId: 'UBOT' });
  }
  // ctx that captures the waitUntil work so the test can await it.
  let pending = [];
  const ctx = { waitUntil: (p) => (pending.push(p), p) };
  const settle = () => Promise.all(pending).then(() => (pending = []));

  test('an @mention gets a chat.postMessage reply', async () => {
    await withInstall();
    const raw = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'Ev1',
      event: { type: 'message', channel: 'C1', user: 'U9', text: '<@UBOT> hello', ts: '1.0' },
    });
    const res = await handleSlack(events(raw), env, ctx, 'https://huddle-hq.com');
    await settle();
    restore();
    assert.equal(res.status, 200);
    const posts = calls.filter((c) => c.url.includes('chat.postMessage'));
    assert.equal(posts.length, 1, 'exactly one reply');
    assert.equal(posts[0].payload.channel, 'C1');
    assert.ok(posts[0].payload.text, 'the reply has text');
  });

  test('a non-addressed message is recorded for context but not answered', async () => {
    await withInstall();
    const raw = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'Ev2',
      event: { type: 'message', channel: 'C1', user: 'U9', text: 'just chatting', ts: '2.0' },
    });
    await handleSlack(events(raw), env, ctx, 'https://huddle-hq.com');
    await settle();
    restore();
    const posts = calls.filter((c) => c.url.includes('chat.postMessage'));
    assert.equal(posts.length, 0, 'the bot stays silent unless addressed');
    // but it stored the message as context
    const row = await env.DB.prepare('SELECT messages FROM chatlog WHERE chat_key = ?').bind('slack:T1:C1').first();
    assert.match(row.messages, /just chatting/);
  });

  test('a duplicate event id is processed only once', async () => {
    await withInstall();
    const raw = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'EvDup',
      event: { type: 'message', channel: 'C1', user: 'U9', text: '<@UBOT> hi', ts: '3.0' },
    });
    await handleSlack(events(raw), env, ctx, 'https://huddle-hq.com');
    await settle();
    await handleSlack(events(raw), env, ctx, 'https://huddle-hq.com'); // Slack retry
    await settle();
    restore();
    const posts = calls.filter((c) => c.url.includes('chat.postMessage'));
    assert.equal(posts.length, 1, 'the retry must not answer again');
  });
});
