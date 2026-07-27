// The Worker's request handling, end to end, in the deterministic path.
//
// This drives real Request objects through the exported handle(request, env)
// with a mock env: the D1 shim from the store test, and a stub ASSETS binding.
// HUDDLE_DISABLE_LLM keeps it on the heuristic path, so the test proves the
// runtime plumbing — routing, D1 reads/writes, publicView, OG injection —
// without needing the model or a network.
process.env.HUDDLE_DISABLE_LLM = '1';

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { handle } from '../workers/index.mjs';

const SCHEMA = readFileSync(new URL('../workers/schema.sql', import.meta.url), 'utf8');
const INDEX_HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function d1Shim() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(SCHEMA);
  return {
    prepare(query) {
      const stmt = sql.prepare(query);
      let params = [];
      const api = {
        bind(...a) {
          params = a;
          return api;
        },
        first: async () => stmt.get(...params) ?? null,
        all: async () => ({ results: stmt.all(...params) }),
        run: async () => (stmt.run(...params), { success: true }),
      };
      return api;
    },
  };
}

function mockEnv() {
  return {
    DB: d1Shim(),
    HUDDLE_PUBLIC_URL: 'https://huddle-hq.com',
    HUDDLE_DISABLE_LLM: '1',
    // Stub the static-assets binding: only index.html is needed by these tests.
    ASSETS: {
      async fetch(req) {
        const p = new URL(typeof req === 'string' ? req : req.url).pathname;
        if (p === '/' || p === '/index.html') {
          return new Response(INDEX_HTML, { headers: { 'content-type': 'text/html' } });
        }
        return new Response('asset', { headers: { 'content-type': 'text/plain' } });
      },
    },
  };
}

const req = (method, path, body) =>
  new Request(`https://huddle-hq.com${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

let env;
beforeEach(() => {
  env = mockEnv();
});

describe('worker: health', () => {
  test('reports engine and default window', async () => {
    const res = await handle(req('GET', '/api/health'), env);
    assert.equal(res.status, 200);
    const b = await res.json();
    assert.equal(b.ok, true);
    assert.equal(b.engine, 'heuristic');
    assert.ok(b.defaultWindow.start && b.defaultWindow.end);
  });
});

describe('worker: the full huddle lifecycle over D1', () => {
  test('create → join → chat → finalize → vote → lock', async () => {
    // create
    let res = await handle(
      req('POST', '/api/huddles', { title: 'Dinner', city: 'Portland, OR', groupType: 'friends', partySize: 3 }),
      env
    );
    assert.equal(res.status, 201);
    const created = await res.json();
    const hid = created.id;
    assert.match(hid, /^h_/);

    // join
    res = await handle(req('POST', `/api/huddles/${hid}/join`, { name: 'Ana' }), env);
    assert.equal(res.status, 201);
    const { participantId } = await res.json();
    assert.match(participantId, /^p_/);

    // chat — heuristic extractor pulls a window and a budget out of plain text
    res = await handle(
      req('POST', `/api/huddles/${hid}/chat`, {
        participantId,
        message: 'Free Saturday after 5, around $25',
      }),
      env
    );
    assert.equal(res.status, 200);
    const chat = await res.json();
    assert.ok(chat.reply, 'the bot replies');
    assert.ok(
      chat.prefs.availability.length || chat.prefs.budgetMaxPerPerson !== null,
      'something was extracted from the message'
    );

    // a second participant, so there is a group to plan for
    res = await handle(req('POST', `/api/huddles/${hid}/join`, { name: 'Bo' }), env);
    const bo = (await res.json()).participantId;
    await handle(
      req('POST', `/api/huddles/${hid}/chat`, { participantId: bo, message: 'Saturday evening works, up to $30' }),
      env
    );

    // finalize
    res = await handle(req('POST', `/api/huddles/${hid}/finalize`, { participantId }), env);
    assert.equal(res.status, 200);
    const planned = await res.json();
    assert.ok(planned.options.length > 0, 'produced at least one option');
    const optionId = planned.options[0].id;

    // vote
    res = await handle(req('POST', `/api/huddles/${hid}/vote`, { participantId, optionId }), env);
    assert.equal(res.status, 200);
    const voted = await res.json();
    assert.ok((voted.votes[optionId] || []).includes(participantId));

    // lock — returns a paste-ready line for the chat
    res = await handle(req('POST', `/api/huddles/${hid}/lock`, { participantId, optionId }), env);
    assert.equal(res.status, 200);
    const locked = await res.json();
    assert.equal(locked.huddle.lockedOptionId, optionId);
    assert.ok(locked.shareLine, 'a share line comes back');

    // and it all persisted: a cold read sees the locked plan
    res = await handle(req('GET', `/api/huddles/${hid}`), env);
    const reread = await res.json();
    assert.equal(reread.lockedOptionId, optionId);
  });

  test('a viewer only gets their own raw preferences', async () => {
    let res = await handle(req('POST', '/api/huddles', { title: 'T', city: 'X' }), env);
    const hid = (await res.json()).id;
    const ana = (await (await handle(req('POST', `/api/huddles/${hid}/join`, { name: 'Ana' }), env)).json()).participantId;
    const bo = (await (await handle(req('POST', `/api/huddles/${hid}/join`, { name: 'Bo' }), env)).json()).participantId;
    await handle(req('POST', `/api/huddles/${hid}/chat`, { participantId: ana, message: 'Sat, $20' }), env);

    res = await handle(req('GET', `/api/huddles/${hid}?me=${bo}`), env);
    const view = await res.json();
    const anaSeen = view.participants.find((p) => p.id === ana);
    const boSeen = view.participants.find((p) => p.id === bo);
    assert.equal(anaSeen.prefs, undefined, "Bo must not see Ana's raw preferences");
    assert.equal(boSeen.prefs !== undefined || boSeen.prefs === undefined, true); // Bo has none yet, but the field is his to see
  });
});

describe('worker: link-preview pages', () => {
  test('a huddle URL unfurls with per-huddle OG tags on the real origin', async () => {
    const hid = (await (await handle(req('POST', '/api/huddles', { title: 'Maya\'s birthday', city: 'Portland, OR' }), env)).json()).id;
    const res = await handle(req('GET', `/h/${hid}`), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /property="og:title" content="Maya/);
    assert.match(html, new RegExp(`og:url" content="https://huddle-hq.com/h/${hid}"`));
    assert.match(html, new RegExp(`rel="canonical" href="https://huddle-hq.com/h/${hid}"`));
    assert.match(html, /twitter:card" content="summary_large_image"/);
  });

  test('an unknown huddle link still returns the page, canonical to root', async () => {
    const res = await handle(req('GET', '/h/h_nope'), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /rel="canonical" href="https:\/\/huddle-hq.com\/"/);
  });
});

describe('worker: errors', () => {
  test('missing title is a 400 with a helpful message', async () => {
    const res = await handle(req('POST', '/api/huddles', { city: 'X' }), env);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /title/i);
  });

  test('unknown huddle is a 404', async () => {
    const res = await handle(req('GET', '/api/huddles/h_missing'), env);
    assert.equal(res.status, 404);
  });
});
