// Admin analytics: auth gate + correct aggregation from D1.
process.env.HUDDLE_ANSWER_MODEL = 'claude-haiku-4-5'; // deterministic pricing (in $1 / out $5 per M)
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

// Date-relative fixtures so windowed metrics (7d/30d) don't drift as the clock
// advances. OLD is safely inside 30d but outside 7d; ANCIENT is outside 30d.
const DAYS_AGO = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const OLD = DAYS_AGO(20);
const ANCIENT = DAYS_AGO(60);

function seed(db) {
  const today = new Date().toISOString().slice(0, 10);
  const u = db._sql.prepare('INSERT INTO usage (day, chat_key, used) VALUES (?, ?, ?)');
  u.run(today, 'slack:T1:C1', 5);
  u.run(today, 'slack:T1:C2', 3);
  u.run(today, 'google:spaces/x', 2);
  u.run(OLD, 'telegram:99', 4);
  db._sql.prepare('INSERT INTO installs (team_id, team_name, bot_token, installed_at) VALUES (?, ?, ?, ?)').run('T1', 'Acme', 'x', '2026-07-20T00:00:00Z');
  db._sql.prepare('INSERT INTO huddles (id, created_at, data) VALUES (?, ?, ?)').run('h1', '2026-07-01T00:00:00Z', '{}');
  const su = db._sql.prepare('INSERT INTO seen_users (user_key, platform, first_seen, last_seen) VALUES (?, ?, ?, ?)');
  su.run('slack:aaa', 'slack', today + 'T00:00:00', today + 'T10:00:00');       // active today
  su.run('slack:bbb', 'slack', today + 'T00:00:00', today + 'T10:00:00');       // active today
  su.run('telegram:ccc', 'telegram', today + 'T00:00:00', today + 'T10:00:00'); // active today
  su.run('google:ddd', 'google', ANCIENT + 'T00:00:00', ANCIENT + 'T00:00:00'); // outside 30d
  const sp = db._sql.prepare('INSERT INTO spend (day, chat_key, input_tokens, output_tokens, searches, calls) VALUES (?, ?, ?, ?, ?, ?)');
  sp.run(today, 'slack:T1:C1', 1_000_000, 200_000, 3, 5); // today's spend on slack: 5 fresh calls
  sp.run(OLD, 'telegram:99', 500_000, 100_000, 1, 2);     // 2 fresh calls
  db._sql.prepare('INSERT INTO stat_counters (name, n) VALUES (?, ?)').run('cache_hits', 6);
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
    assert.ok(s.daily.some((r) => r.day === OLD));
  });

  test('installs are listed', async () => {
    const s = await adminStats(env);
    assert.equal(s.installs[0].team_name, 'Acme');
  });

  test('retention windows count active + returning chats', async () => {
    // One more day for slack:T1:C1 so it becomes a "returning" chat (2 days).
    env.DB._sql.prepare('INSERT INTO usage (day, chat_key, used) VALUES (?, ?, ?)').run(OLD, 'slack:T1:C1', 2);
    const s = await adminStats(env);
    // 3 chats used today (within 7d); the lone telegram chat 20 days ago is older.
    assert.equal(s.retention.activeChats7d, 3);
    // All 4 fall inside 30d.
    assert.equal(s.retention.activeChats30d, 4);
    // Only slack:T1:C1 appears on 2 separate days.
    assert.equal(s.retention.returningChats, 1);
  });

  test('counts distinct users, overall and per platform', async () => {
    const s = await adminStats(env);
    assert.equal(s.totals.users, 4); // 2 slack + 1 telegram + 1 google
    const byName = Object.fromEntries(s.byPlatform.map((p) => [p.platform, p]));
    assert.equal(byName.slack.users, 2);
    assert.equal(byName.telegram.users, 1);
    // active-user windows: the google user is 2 months stale, so out of 30d
    assert.equal(s.retention.users30d, 3);
    assert.equal(s.retention.users7d, 3);
  });

  test('estimated spend is summed from tokens + searches at the model price', async () => {
    const s = await adminStats(env);
    // haiku: $1/M in, $5/M out, $0.01/search.
    // all-time: 1.5M in + 0.3M out + 4 searches = 1.5 + 1.5 + 0.04 = 3.04
    assert.equal(s.totals.spendUsd, 3.04);
    // today: only the slack row (1M in, 0.2M out, 3 searches) = 1 + 1 + 0.03 = 2.03
    assert.equal(s.totals.spendTodayUsd, 2.03);
    const byName = Object.fromEntries(s.byPlatform.map((p) => [p.platform, p]));
    assert.equal(byName.slack.usd, 2.03);
    assert.equal(byName.telegram.usd, 1.01);
  });

  test('cache hit rate = hits / (hits + fresh calls)', async () => {
    const s = await adminStats(env);
    // 6 cache hits, 7 fresh calls (5 + 2) → 6/13 = 46%
    assert.equal(s.totals.cacheHitRate, 46);
  });

  test('new users per day is merged into the daily rollup', async () => {
    const s = await adminStats(env);
    const today = new Date().toISOString().slice(0, 10);
    const todayRow = s.daily.find((r) => r.day === today);
    assert.equal(todayRow.newUsers, 3); // aaa, bbb, ccc first-seen today
  });

  test('busiest chats rank by volume and never leak the raw chat_key', async () => {
    const s = await adminStats(env);
    assert.equal(s.topChats[0].questions, 5); // slack:T1:C1
    assert.ok(s.topChats.every((c) => !('chat_key' in c)), 'raw chat_key is not exposed');
    assert.ok(s.topChats.every((c) => typeof c.platform === 'string'));
  });
});
