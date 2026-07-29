// The "catch me up" recap: command matching, and the summarize() contract on
// the heuristic (no-LLM) path — grounded only in the messages it's given, never
// a web search, and gracefully degraded when there's nothing to summarize.
process.env.HUDDLE_DISABLE_LLM = '1';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isSummarizeCommand, withBackground } from '../workers/chat-state.mjs';
import { summarize } from '../src/assistant.mjs';

describe('withBackground', () => {
  test('prepends the before-I-joined note as backstory', () => {
    const out = withBackground('the team is planning an offsite in Denver', 'Ana: what time?');
    assert.match(out, /BEFORE you joined/i);
    assert.match(out, /Denver/);
    assert.ok(out.indexOf('Denver') < out.indexOf('Ana:'), 'background comes before recent messages');
  });
  test('is a no-op when there is no background', () => {
    assert.equal(withBackground(null, 'Ana: hi'), 'Ana: hi');
  });
});

describe('isSummarizeCommand', () => {
  test('matches the recap commands and phrases', () => {
    for (const t of ['/summarize', '/summarise', '/tldr', '/recap', 'catch me up', 'tldr', 'TL;DR now']) {
      assert.ok(isSummarizeCommand(t), `should match: ${t}`);
    }
  });
  test('does not hijack a normal question', () => {
    for (const t of ['who won the game?', 'summarize this article: ...', 'what is the recap of the match']) {
      assert.equal(isSummarizeCommand(t), false, `should NOT match: ${t}`);
    }
  });
});

describe('summarize() without an API key', () => {
  test('a thin conversation degrades to an honest "nothing to catch up on"', async () => {
    const r = await summarize({ transcript: 'Ana: hi', platform: 'test', chatId: 'c1' });
    assert.match(r.text, /not much to catch up/i);
    assert.deepEqual(r.sources, []);
  });

  test('with real backlog but no key, it says it needs one — never fabricates a recap', async () => {
    const transcript = 'Ana: dinner friday?\nBo: I am free after 6\nCy: max $25 for me';
    const r = await summarize({ transcript, platform: 'test', chatId: 'c2' });
    assert.match(r.text, /API key/i);
    assert.deepEqual(r.sources, []);
  });
});
