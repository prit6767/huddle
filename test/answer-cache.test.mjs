// The D1 answer cache: a fresh entry is served without calling the model; an
// expired one is not. This is the cost win — the in-memory cache is a no-op on
// Workers isolates, so repeated questions used to re-charge Claude every time.
process.env.HUDDLE_DISABLE_LLM = '1';

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { answerWithCache, normalizeQuestion } from '../workers/chat-state.mjs';

const SCHEMA = readFileSync(new URL('../workers/schema.sql', import.meta.url), 'utf8');

function d1Shim() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(SCHEMA);
  return {
    _sql: sql,
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

function seed(db, chatId, question, answer, expiresAt) {
  const key = `${chatId}::${normalizeQuestion(question)}`;
  db._sql
    .prepare('INSERT INTO answer_cache (cache_key, answer, expires_at) VALUES (?, ?, ?)')
    .run(key, JSON.stringify(answer), expiresAt);
}

let env;
beforeEach(() => {
  env = { DB: d1Shim(), HUDDLE_DISABLE_LLM: '1' };
});

describe('answer cache', () => {
  test('a fresh cached answer is served verbatim, flagged cached', async () => {
    const cached = { text: 'Arsenal lead, 3 points clear.', sources: [{ url: 'https://x', title: 'X' }] };
    seed(env.DB, 'slack:T:C', 'who leads the league?', cached, Date.now() + 60_000);

    const got = await answerWithCache(env, { question: 'Who leads the league?', context: '', platform: 'slack', chatId: 'slack:T:C' });
    assert.equal(got.text, cached.text);
    assert.equal(got.cached, true);
    assert.deepEqual(got.sources, cached.sources);
  });

  test('normalization: different case/spacing still hits the same entry', async () => {
    seed(env.DB, 'slack:T:C', 'what time is it in tokyo?', { text: 'A', sources: [{ url: 'u' }] }, Date.now() + 60_000);
    const got = await answerWithCache(env, { question: '  What  Time  is  it  in  Tokyo?  ', context: '', platform: 'slack', chatId: 'slack:T:C' });
    assert.equal(got.cached, true);
    assert.equal(got.text, 'A');
  });

  test('an expired entry is NOT served (falls through to a fresh answer)', async () => {
    seed(env.DB, 'slack:T:C', 'stale question', { text: 'OLD', sources: [{ url: 'u' }] }, Date.now() - 1000);
    const got = await answerWithCache(env, { question: 'stale question', context: '', platform: 'slack', chatId: 'slack:T:C' });
    // On the heuristic path there's no key, so ask() returns its no-key notice —
    // the point is it did NOT return the stale "OLD" cached value.
    assert.notEqual(got.text, 'OLD');
    assert.ok(!got.cached);
  });

  test('the cache is scoped per chat — one chat cannot read another\'s answer', async () => {
    seed(env.DB, 'slack:T:C1', 'shared question', { text: 'C1 answer', sources: [{ url: 'u' }] }, Date.now() + 60_000);
    const other = await answerWithCache(env, { question: 'shared question', context: '', platform: 'slack', chatId: 'slack:T:C2' });
    assert.notEqual(other.text, 'C1 answer');
  });
});
