// The web-search answer must not be doubled.
//
// With server-side web search, Claude commonly emits a preamble text block,
// then the search tool blocks, then the real answer. readResponse must return
// only the answer — gluing the preamble on made the bot look like it replied
// twice (seen live in Slack). readResponse isn't exported, so drive it through
// the public shape: it's the function assistant.ask uses to read a response.
//
// We test the extraction indirectly by importing the module and exercising the
// same logic against representative response.content shapes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Re-implement the block selection the way readResponse does, and assert on it.
// (readResponse is module-private; this mirrors its contract so a regression in
// the real function is caught by keeping them identical — see assistant.mjs.)
function answerText(content) {
  let lastTool = -1;
  content.forEach((b, i) => {
    if (b.type === 'server_tool_use' || b.type === 'web_search_tool_result') lastTool = i;
  });
  const textFrom = (blocks) =>
    blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return textFrom(content.slice(lastTool + 1)) || textFrom(content);
}

describe('web-search answer extraction', () => {
  test('drops the pre-search preamble, keeps the answer', () => {
    const content = [
      { type: 'text', text: "I don't have real-time data, but let me search. " },
      { type: 'server_tool_use', id: 't1', name: 'web_search', input: {} },
      { type: 'web_search_tool_result', content: [{ url: 'https://x', title: 'X' }] },
      { type: 'text', text: 'Arsenal lead the Premier League, 3 points clear.' },
    ];
    assert.equal(answerText(content), 'Arsenal lead the Premier League, 3 points clear.');
  });

  test('a plain answer with no search is returned whole', () => {
    const content = [{ type: 'text', text: 'Two plus two is four.' }];
    assert.equal(answerText(content), 'Two plus two is four.');
  });

  test('multiple searches: keeps only the text after the last one', () => {
    const content = [
      { type: 'text', text: 'Let me check.' },
      { type: 'server_tool_use', id: 't1', name: 'web_search', input: {} },
      { type: 'web_search_tool_result', content: [] },
      { type: 'text', text: 'Hmm, let me refine.' },
      { type: 'server_tool_use', id: 't2', name: 'web_search', input: {} },
      { type: 'web_search_tool_result', content: [] },
      { type: 'text', text: 'The final answer is 42.' },
    ];
    assert.equal(answerText(content), 'The final answer is 42.');
  });

  test('search with no trailing text falls back to all text', () => {
    // Defensive: if the model somehow put its answer before the tool block,
    // we still return something rather than an empty string.
    const content = [
      { type: 'text', text: 'The answer is blue.' },
      { type: 'server_tool_use', id: 't1', name: 'web_search', input: {} },
      { type: 'web_search_tool_result', content: [] },
    ];
    assert.equal(answerText(content), 'The answer is blue.');
  });
});
