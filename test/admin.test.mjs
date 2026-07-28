// Admin analytics: auth gate + correct aggregation from D1.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { handleAdmin, adminStats } from '../workers/admin.mjs';

const SCHEMA = readFileSync(new URL('../workers/schema.sql', import.meta.url), 'utf8');
const USER = 'admin';
const PASS = 'secret-pass';
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

function d1Shim() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(SCHEMA);
  return {
    _sql: sql,
    prepare(q) {
      const s = sql.prepare(q);
      let p = [];
      const a = {
        bind(...x) { p = x; return a; },
        first: async () => s.get(...p) ?? null,
        all: async () => ({ results: s.all(...p) }),
        run: async () => { s.run(...p); return {}; },
      };
      return a;
    },
  };
}

function seed(db) {
  const today = new Date().toISOString().slice(0, 10);
  const u = db._sql.prepare('INSERT INTO usage (day, chat_key, used) VALUES (?, ?, ?)');
  u.run(today, 'slack:T1:C1', 5);
  u.run(today, 'slack:T1:C2', 3);
  u.run(today, 'google:spaces/x', 2);
  u.run('2026-07-01', 'telegram:99', 4);
  db._sql.prepare('INSERT INTO installs (team_id, team_name, bot_token, installed_at) VALUES (?, ?, ?, ?)').run('T1', 'Acme', 'x', '2026-07-20T00:00:00Z');
  db._sql.prepare('INSERT INTO huddles (id, created_at, data) VALUES (?, ?, ?)').run('h1', '2026-07-01T00:00:00Z', '{}');
}

let env;
beforeEach(() => {
  env = { DB: d1Shim(), HUDDLE_ADMIN_USER: USER, HUDDLE_ADMIN_PASS: PASS };
  seed(env.DB);
});

const req = (auth) =>
  new Request('https://huddle-hq.com/api/admin/stats', auth ? { headers: { authorization: auth } } : {});

describe('admin auth', () => {
  test('no credentials is 401 with a Basic challenge', async () => {
    const res = await handleAdmin(req(), env);
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') || '', /Basic/);
  });
  test('wrong password is 401', async () => {
    assert.equal((await handleAdmin(req(basic(USER, 'wrong')), env)).status, 401);
  });
  test('wrong username is 401', async () => {
    assert.equal((await handleAdmin(req(basic('nope', PASS)), env)).status, 401);
  });
  test('correct username + password is 200', async () => {
    assert.equal((await handleAdmin(req(basic(USER, PASS)), env)).status, 200);
  });
  test('unset credentials -> 404 (dormant)', async () => {
    const res = await handleAdmin(req(basic(USER, PASS)), { DB: env.DB });
    assert.equal(res.status, 404);
  });
  test('a bare token in the header is rejected (Basic only)', async () => {
    assert.equal((await handleAdmin(req(`Bearer ${PASS}`), env)).status, 401);
  });
});

describe('admin aggregation', () => {
  test('totals are summed correctly', async () => {
    const s = await adminStats(env);
    assert.equal(s.totals.totalQuestions, 14); // 5+3+2+4
    assert.equal(s.totals.todayQuestions, 10); // 5+3+2 today
    assert.equal(s.totals.activeChats, 4); // distinct chat_keys
    assert.equal(s.totals.workspaces, 1);
    assert.equal(s.totals.huddles, 1);
  });

  test('per-platform breakdown splits on the chat_key prefix', async () => {
    const s = await adminStats(env);
    const byName = Object.fromEntries(s.byPlatform.map((p) => [p.platform, p]));
    assert.equal(byName.slack.questions, 8);
    assert.equal(byName.slack.chats, 2);
    assert.equal(byName.google.questions, 2);
    assert.equal(byName.telegram.questions, 4);
  });

  test('daily rollup groups by day', async () => {
    const s = await adminStats(env);
    const today = new Date().toISOString().slice(0, 10);
    const todayRow = s.daily.find((r) => r.day === today);
    assert.equal(todayRow.questions, 10);
    assert.ok(s.daily.some((r) => r.day === '2026-07-01'));
  });

  test('installs are listed', async () => {
    const s = await adminStats(env);
    assert.equal(s.installs[0].team_name, 'Acme');
  });
});
