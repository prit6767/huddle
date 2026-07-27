// The D1 store, proven against a real SQLite engine.
//
// D1 is SQLite with an async prepare().bind().first()/all()/run() surface. We
// can't run the actual D1 binding in a unit test, but the SQL it executes is
// standard SQLite — so we drive the exact store code through a thin shim over
// node:sqlite that mimics D1's API. If the SQL is wrong, this fails; if D1's
// dialect ever diverges, that's caught at deploy, but the logic is proven here.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { store, installs, id } from '../workers/store-d1.mjs';

const SCHEMA = readFileSync(new URL('../workers/schema.sql', import.meta.url), 'utf8');

/** A minimal D1Database shim over node:sqlite, so the store runs unmodified. */
function d1Shim() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(SCHEMA);
  return {
    prepare(query) {
      const stmt = sql.prepare(query);
      let params = [];
      const api = {
        bind(...args) {
          params = args;
          return api;
        },
        async first() {
          return stmt.get(...params) ?? null;
        },
        async all() {
          return { results: stmt.all(...params) };
        },
        async run() {
          stmt.run(...params);
          return { success: true };
        },
      };
      return api;
    },
  };
}

let db, S, I;
beforeEach(() => {
  db = d1Shim();
  S = store(db);
  I = installs(db);
});

describe('D1 huddle store', () => {
  test('create then read round-trips the whole document', async () => {
    const h = await S.createHuddle({ title: 'Dinner', city: 'Austin, TX', groupType: 'friends' });
    assert.match(h.id, /^h_/);
    const back = await S.getHuddle(h.id);
    assert.equal(back.title, 'Dinner');
    assert.equal(back.city, 'Austin, TX');
    // Defaults from createHuddle survive the round trip.
    assert.deepEqual(back.participants, []);
    assert.deepEqual(back.votes, {});
    assert.equal(back.lockedOptionId, null);
  });

  test('saveHuddle upserts rather than duplicating', async () => {
    const h = await S.createHuddle({ title: 'Lunch', city: 'X' });
    h.participants.push({ id: 'p1', name: 'Ana' });
    await S.saveHuddle(h);
    h.participants.push({ id: 'p2', name: 'Bo' });
    await S.saveHuddle(h);

    const all = await S.listHuddles();
    assert.equal(all.length, 1, 'one row, not three');
    assert.equal((await S.getHuddle(h.id)).participants.length, 2);
  });

  test('unknown id is null, not a throw', async () => {
    assert.equal(await S.getHuddle('h_nope'), null);
  });

  test('listHuddles returns newest first', async () => {
    const a = await S.createHuddle({ title: 'First', city: 'X', createdAt: '2026-07-01T00:00:00.000Z' });
    const b = await S.createHuddle({ title: 'Second', city: 'X', createdAt: '2026-07-09T00:00:00.000Z' });
    const titles = (await S.listHuddles()).map((h) => h.title);
    assert.deepEqual(titles, ['Second', 'First']);
    assert.ok(a.id && b.id);
  });

  test('findHuddleByChat matches binding and ignores closed', async () => {
    await S.createHuddle({ title: 'Old', city: 'X', binding: { platform: 'slack', chatId: 'C1', closed: true } });
    await S.createHuddle({ title: 'Live', city: 'X', binding: { platform: 'slack', chatId: 'C1' } });
    const found = await S.findHuddleByChat('slack', 'C1');
    assert.equal(found.title, 'Live');
  });

  test('chat ids match across string and number forms', async () => {
    await S.createHuddle({ title: 'Numeric', city: 'X', binding: { platform: 'telegram', chatId: -100123 } });
    const found = await S.findHuddleByChat('telegram', '-100123');
    assert.equal(found?.title, 'Numeric');
  });
});

describe('D1 installs store', () => {
  test('save then get round-trips a workspace token', async () => {
    await I.save({ teamId: 'T1', teamName: 'Acme', botToken: 'xoxb-abc', botUserId: 'U9' });
    const got = await I.get('T1');
    assert.equal(got.teamName, 'Acme');
    assert.equal(got.botToken, 'xoxb-abc');
    assert.equal(got.botUserId, 'U9');
  });

  test('re-install updates the token in place', async () => {
    await I.save({ teamId: 'T1', teamName: 'Acme', botToken: 'xoxb-old' });
    await I.save({ teamId: 'T1', teamName: 'Acme Corp', botToken: 'xoxb-new' });
    const got = await I.get('T1');
    assert.equal(got.botToken, 'xoxb-new');
    assert.equal(got.teamName, 'Acme Corp');
  });

  test('unknown team is null', async () => {
    assert.equal(await I.get('T_nope'), null);
  });
});

describe('id generation', () => {
  test('prefixed, unique, and long enough not to guess', () => {
    const a = id('h');
    const b = id('h');
    assert.match(a, /^h_/);
    assert.notEqual(a, b);
    assert.ok(a.length > 8);
  });
});
