// Interactive cards + booking, through bridge.mjs — the platform-neutral brain.
//
// Isolated store: a throwaway data dir, heuristic path (no LLM). Covers the
// card lifecycle, the numbered-reply degrade (the iMessage / no-button path),
// and the headline requirement — the merge/invalidation interaction: a new
// constraint CLEARS the card (like options/votes) and FLAGS the reservation
// stale (a real commitment is warned, never silently deleted).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.HUDDLE_DATA_DIR = mkdtempSync(join(tmpdir(), 'huddle-cards-'));
process.env.HUDDLE_DISABLE_LLM = '1';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createHuddle, findHuddleByChat } from '../src/store.mjs';
import { handleEvent, handleCardResponse } from '../src/bots/bridge.mjs';

let seq = 0;
function freshHuddle() {
  const chatId = `c_${++seq}`;
  createHuddle({
    title: 'Dinner',
    city: 'Portland, OR',
    groupType: 'mixed',
    partySize: 3,
    window: { start: '2026-08-01', end: '2026-08-14' },
    organizerName: 'Ana',
    tradeoff: '',
    blocked: null,
    shortfall: null,
    binding: { platform: 'test', chatId, chatTitle: null, closed: false },
    options: [
      {
        id: 'opt_1',
        headline: 'The easy yes',
        why: 'works for everyone',
        venue: { id: 'v1', name: 'Noodle House', booking: 'opentable' },
        slot: { date: '2026-08-02', day: 'saturday', start: '18:00', end: '20:00', label: 'Sat, Aug 2', attending: [], missing: [] },
        estimatePerPerson: 18,
        estimateTotal: 54,
        accommodates: [],
        confirmNote: null,
        links: [{ label: 'Add to Calendar', kind: 'calendar', url: 'https://cal.example/x' }],
      },
    ],
  });
  return chatId;
}
const evt = (chatId, userId, text) => ({
  platform: 'test',
  chatId,
  userId,
  userName: userId === 'u1' ? 'Ana' : 'Bo',
  text,
});
const load = (chatId) => findHuddleByChat('test', chatId);

describe('card lifecycle', () => {
  test('/poll creates a poll card with routable choice buttons', async () => {
    const c = freshHuddle();
    const action = await handleEvent(evt(c, 'u1', '/poll Which day? | Friday | Saturday'));
    assert.ok(action.card, 'action carries the rich card');
    assert.equal(action.card.type, 'poll');
    assert.equal(action.card.choices.length, 2);
    assert.equal(action.buttons.length, 2);
    // button id round-trips: card:<huddleId>:<cardId>:<choiceId>
    const [kind, , cardId, choiceId] = action.buttons[0].id.split(':');
    assert.equal(kind, 'card');
    assert.equal(cardId, action.card.id);
    assert.ok(choiceId);
  });

  test('a response is recorded, and re-voting replaces the prior pick', async () => {
    const c = freshHuddle();
    const created = await handleEvent(evt(c, 'u1', '/poll Day? | Fri | Sat'));
    const card = created.card;
    // Ana picks Friday, then changes to Saturday.
    await handleCardResponse({ platform: 'test', chatId: c, userId: 'u1', userName: 'Ana', cardId: card.id, choiceId: 'c1' });
    const after = handleCardResponse({ platform: 'test', chatId: c, userId: 'u1', userName: 'Ana', cardId: card.id, choiceId: 'c2' });
    const live = load(c).card;
    assert.equal((live.responses.c1 || []).length, 0, 'the old pick is cleared');
    assert.equal(live.responses.c2.length, 1, 'the new pick is recorded');
    assert.ok(after.card, 're-renders the card');
  });

  test('responding to a closed/unknown card is handled, not thrown', async () => {
    const c = freshHuddle();
    const r = handleCardResponse({ platform: 'test', chatId: c, userId: 'u1', userName: 'Ana', cardId: 'card_gone', choiceId: 'c1' });
    assert.match(r.text, /no longer open/i);
  });
});

describe('degrade: numbered reply stands in for a button', () => {
  test('a bare "2" registers the second choice when a card is active', async () => {
    const c = freshHuddle();
    const created = await handleEvent(evt(c, 'u1', '/poll Day? | Fri | Sat'));
    // A plain "2" from someone else — the iMessage / no-button path.
    const action = await handleEvent(evt(c, 'u2', '2'));
    assert.ok(action.card, 'the numbered reply re-renders the card');
    const live = load(c).card;
    assert.equal(live.responses.c2.length, 1);
    assert.equal(created.card.id, live.card?.id ?? live.id);
  });
});

describe('booking loop (tier 1)', () => {
  test('/book writes a reservation with the deep link and an honest status', async () => {
    const c = freshHuddle();
    const action = await handleEvent(evt(c, 'u1', '/book 1'));
    const r = load(c).reservation;
    assert.ok(r, 'reservation written onto the huddle');
    assert.equal(r.status, 'link'); // not confirmed — we didn't hold anything
    assert.equal(r.optionId, 'opt_1');
    assert.match(r.url, /opentable\.com/);
    assert.match(action.text, /haven't confirmed/i, 'the text is honest about not confirming');
  });

  test('/split renders a computed per-person amount', async () => {
    const c = freshHuddle();
    const action = await handleEvent(evt(c, 'u1', '/split 1'));
    assert.match(action.text, /\$18\/person/);
    assert.match(action.text, /✓/); // computed = green tick convention
    assert.equal(load(c).billSplit.source, 'computed');
  });
});

describe('merge / invalidation interaction (the headline requirement)', () => {
  test('a new constraint CLEARS the card and options, and FLAGS the reservation stale', async () => {
    const c = freshHuddle();
    await handleEvent(evt(c, 'u1', '/poll Day? | Fri | Sat')); // card
    await handleEvent(evt(c, 'u1', '/book 1')); // reservation

    const before = load(c);
    assert.ok(before.card && before.reservation, 'card + reservation are set');
    assert.equal(before.reservation.stale, false);

    // A plain constraint message (not addressed, not a number) → extract →
    // learned → invalidation.
    const action = await handleEvent(evt(c, 'u2', "I'm only free Sunday now, and $20 max"));

    const after = load(c);
    assert.equal(after.card, null, 'the card is cleared — a poll on stale constraints no longer applies');
    assert.deepEqual(after.options, [], 'options cleared, as before');
    assert.equal(after.reservation.stale, true, 'the reservation is flagged, NOT deleted');
    assert.ok(after.reservation.url, 'the booking record survives (a real commitment)');
    assert.match(action.text, /Heads up/i, 'the group is warned about the now-stale booking');
  });
});
