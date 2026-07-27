// Cost control.
//
// A group-chat bot has an awkward cost profile: anyone can ask anything, as
// often as they like, and nobody sees the bill. These are the guardrails that
// keep that bounded, so a regression here is a regression in someone's spend.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { claim, refund, cacheKey, cacheGet, cacheSet, recordUsage } from '../src/budget.mjs';

describe('per-chat caps', () => {
  test('a chat can spend up to its limit and no further', () => {
    const chat = `c_${Math.random()}`;
    let allowed = 0;
    for (let i = 0; i < 60; i++) if (claim('test', chat).allowed) allowed++;
    // Default is 50 per chat per day.
    assert.equal(allowed, 50);

    const denied = claim('test', chat);
    assert.equal(denied.allowed, false);
    assert.match(denied.reason, /limit/i, 'the chat is told why, not silently ignored');
  });

  test('chats have separate budgets — one group cannot starve another', () => {
    const a = `c_${Math.random()}`;
    const b = `c_${Math.random()}`;
    for (let i = 0; i < 50; i++) claim('test', a);
    assert.equal(claim('test', a).allowed, false);
    assert.equal(claim('test', b).allowed, true, 'a different chat still has its own allowance');
  });

  test('a refund returns the allowance when nothing was actually spent', () => {
    // Refunds exist because a refusal or an empty answer costs the user
    // nothing, so it must not count against them.
    const chat = `c_${Math.random()}`;
    for (let i = 0; i < 50; i++) claim('test', chat);
    assert.equal(claim('test', chat).allowed, false);
    refund('test', chat);
    assert.equal(claim('test', chat).allowed, true);
  });
});

describe('answer cache', () => {
  test('the same question in the same chat is served from cache', () => {
    const key = cacheKey('test', 'c1', 'who won the game?');
    assert.equal(cacheGet(key) ?? null, null, 'nothing cached yet');
    cacheSet(key, { text: 'They did.', sources: [] });
    assert.deepEqual(cacheGet(key), { text: 'They did.', sources: [] });
  });

  test('cache keys are scoped per chat — answers do not leak between groups', () => {
    const question = 'what did we decide?';
    const a = cacheKey('test', 'chat-a', question);
    const b = cacheKey('test', 'chat-b', question);
    assert.notEqual(a, b, 'two different groups must not share an answer');

    cacheSet(a, { text: 'A answer', sources: [] });
    assert.equal(cacheGet(b) ?? null, null, 'group B must not see group A answer');
  });

  test('trivial rewording still hits the cache', () => {
    // A double-tap or a re-ask with different spacing/case shouldn't cost money.
    const a = cacheKey('test', 'c1', 'Who Won The Game?');
    const b = cacheKey('test', 'c1', 'who won the game?  ');
    assert.equal(a, b);
  });
});

describe('usage ledger', () => {
  test('recording usage never throws on a partial or unknown response', () => {
    // recordUsage is called on every API path, including error paths where the
    // usage block may be missing. It must never be the thing that crashes a reply.
    assert.doesNotThrow(() => recordUsage({ model: 'claude-haiku-4-5', usage: undefined }));
    assert.doesNotThrow(() => recordUsage({ model: 'unknown-model', usage: {} }));
    assert.doesNotThrow(() =>
      recordUsage({ model: 'claude-haiku-4-5', usage: { input_tokens: 10, output_tokens: 5 } })
    );
  });
});
