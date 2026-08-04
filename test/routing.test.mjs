// Model routing (cheap base vs stronger model for hard questions) and the
// cache-key normalization that lets trivially-different phrasings share a hit.
process.env.HUDDLE_MODEL = 'claude-haiku-4-5';
process.env.HUDDLE_HARD_MODEL = 'claude-sonnet-5';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { pickModel } from '../src/assistant.mjs';
import { normalizeQuestion } from '../workers/chat-state.mjs';

describe('pickModel', () => {
  test('simple/factual questions stay on the cheap base model', () => {
    for (const q of ['what is 84291+9429', 'capital of australia?', 'what time is it in Tokyo', 'score of the game']) {
      assert.equal(pickModel(q), 'claude-haiku-4-5', q);
    }
  });
  test('reasoning-heavy questions route to the stronger model', () => {
    for (const q of [
      'why is the sky blue',
      'compare messi vs ronaldo careers',
      'should we use postgres or mysql here',
      'explain how tariffs affect inflation',
      "what's the difference between TCP and UDP",
    ]) {
      assert.equal(pickModel(q), 'claude-sonnet-5', q);
    }
  });
  test('long, multi-clause asks route up too', () => {
    assert.equal(pickModel('a'.repeat(200)), 'claude-sonnet-5');
    assert.equal(pickModel('first thing. second thing. third thing. and more'), 'claude-sonnet-5');
  });
});

describe('normalizeQuestion (cache key)', () => {
  test('contractions and punctuation collapse to one key', () => {
    assert.equal(normalizeQuestion("what's the capital of australia?"), normalizeQuestion('what is the capital of australia'));
    assert.equal(normalizeQuestion('WHO is  the   CEO of Ford!!'), 'who is the ceo of ford');
  });
  test('genuinely different questions do NOT collide', () => {
    assert.notEqual(normalizeQuestion('capital of france'), normalizeQuestion('capital of spain'));
  });
});
