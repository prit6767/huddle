// The answer cleaner: strips the failure patterns seen live, leaves good
// answers untouched. These cases come from real Slack replies.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tidyAnswer } from '../src/tidy.mjs';

describe('trailing clarifying questions', () => {
  test('drops "Which were you asking about?" after a real answer', () => {
    const raw =
      'LA has about 3.9 million people in the city proper, or around 13 million in the greater metro area. Which were you asking about?';
    assert.equal(
      tidyAnswer(raw),
      'LA has about 3.9 million people in the city proper, or around 13 million in the greater metro area.'
    );
  });

  test('drops "What specifically do you mean?"', () => {
    assert.equal(
      tidyAnswer('The Urus starts around $270,000. What specifically do you mean by Lamborghini?'),
      'The Urus starts around $270,000.'
    );
  });

  test('drops a stacked pair of clarifiers', () => {
    const raw = 'Arsenal lead the league. Did you mean the Premier League? Which season are you asking about?';
    assert.equal(tidyAnswer(raw), 'Arsenal lead the league.');
  });

  test('keeps a rhetorical question that is not a clarification', () => {
    const raw = "Messi has more Ballon d'Ors — seven of them. Wild, right?";
    assert.equal(tidyAnswer(raw), raw);
  });
});

describe('leading preamble', () => {
  test('drops "I\'d need to search..."', () => {
    assert.equal(
      tidyAnswer("I'd need to search for current data. Arsenal are top of the table."),
      'Arsenal are top of the table.'
    );
  });

  test('drops "I don\'t have real-time data..."', () => {
    assert.equal(
      tidyAnswer("I don't have access to real-time data. Miami is UTC-04:00 right now."),
      'Miami is UTC-04:00 right now.'
    );
  });

  test('drops "Great question"', () => {
    assert.equal(tidyAnswer('Great question! The answer is 42.'), 'The answer is 42.');
  });
});

describe('leaves good answers alone', () => {
  test('a clean answer is unchanged', () => {
    const good = 'Ronaldo leads on career goals; Messi leads on assists.';
    assert.equal(tidyAnswer(good), good);
  });

  test('an answer that merely contains a "?" mid-text is untouched', () => {
    const good = 'The "who is better?" part is subjective, but Messi has more assists.';
    assert.equal(tidyAnswer(good), good);
  });

  test('does not gut a short answer that is only a clarifier', () => {
    // If stripping would leave a fragment, keep the original — imperfect beats empty.
    const raw = 'Which one?';
    assert.equal(tidyAnswer(raw), 'Which one?');
  });
});

describe('robustness', () => {
  test('handles empty / non-string input', () => {
    assert.equal(tidyAnswer(''), '');
    assert.equal(tidyAnswer(null), null);
    assert.equal(tidyAnswer(undefined), undefined);
  });
});
