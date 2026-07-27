// The arithmetic the group chat gets wrong.
//
// These are the rules the product claims to get right, written as assertions:
// budget takes the MINIMUM, hard requirements UNION, time takes the overlap.
// Getting one of these subtly wrong produces a plan that looks fine and
// quietly excludes someone, which is the failure mode worth testing for.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildConsensus } from '../src/consensus.mjs';
import { emptyPrefs } from '../src/extract.mjs';

/** A participant with only the preferences a test cares about. */
function person(name, prefs = {}) {
  return {
    id: `p_${name}`,
    name,
    done: true,
    prefs: { ...emptyPrefs(), ...prefs },
  };
}

function huddleOf(participants, window = { start: '2026-08-01', end: '2026-08-03' }) {
  return { id: 'h_test', partySize: participants.length, participants, window };
}

const free = (date, earliest, latest) => ({ availability: [{ date, earliest, latest }] });

describe('budget', () => {
  test('the ceiling is the cheapest person, not the average', () => {
    const c = buildConsensus(
      huddleOf([
        person('Ana', { ...free('2026-08-01', '17:00', '22:00'), budgetMaxPerPerson: 60 }),
        person('Dennis', { ...free('2026-08-01', '17:00', '22:00'), budgetMaxPerPerson: 15 }),
        person('Priya', { ...free('2026-08-01', '17:00', '22:00'), budgetMaxPerPerson: 40 }),
      ])
    );
    // The whole point: Dennis never has to say $15 twice.
    assert.equal(c.budgetCeiling, 15);
    assert.deepEqual(c.budgetSpread, { low: 15, high: 60 });
  });

  test('no stated budget means no ceiling, not a ceiling of zero', () => {
    const c = buildConsensus(
      huddleOf([person('Ana', free('2026-08-01', '17:00', '22:00'))])
    );
    assert.equal(c.budgetCeiling, null);
  });

  test('a wide spread on a low floor is surfaced as friction', () => {
    const c = buildConsensus(
      huddleOf([
        person('Ana', { ...free('2026-08-01', '17:00', '22:00'), budgetMaxPerPerson: 90 }),
        person('Dennis', { ...free('2026-08-01', '17:00', '22:00'), budgetMaxPerPerson: 15 }),
      ])
    );
    assert.ok(
      c.frictions.some((f) => f.includes('$15') && f.includes('$90')),
      'the group should be told the range was capped, and to what'
    );
  });
});

describe('hard requirements', () => {
  test('one persons allergy binds the group', () => {
    const c = buildConsensus(
      huddleOf([
        person('Ana', { ...free('2026-08-01', '17:00', '22:00'), dietary: ['gluten-free'] }),
        person('Bo', { ...free('2026-08-01', '17:00', '22:00'), dietary: ['vegetarian'] }),
        person('Cy', free('2026-08-01', '17:00', '22:00')),
      ])
    );
    assert.deepEqual(c.dietary.sort(), ['gluten-free', 'vegetarian']);
  });

  test('accessibility needs union and stay attributed to the person', () => {
    const c = buildConsensus(
      huddleOf([
        person('Marta', { ...free('2026-08-01', '17:00', '22:00'), accessibility: ['step-free'] }),
        person('Bo', free('2026-08-01', '17:00', '22:00')),
      ])
    );
    assert.deepEqual(c.accessibility, ['step-free']);
    // Attribution is what turns "step-free" into "step-free (for Marta)" —
    // a note somebody actually reads.
    assert.deepEqual(c.attribution['step-free'], ['Marta']);
  });

  test('vetoes union — "no bowling" means no bowling', () => {
    const c = buildConsensus(
      huddleOf([
        person('Ana', { ...free('2026-08-01', '17:00', '22:00'), avoid: ['bowling'] }),
        person('Bo', { ...free('2026-08-01', '17:00', '22:00'), avoid: ['karaoke'] }),
      ])
    );
    assert.deepEqual(c.avoid.sort(), ['bowling', 'karaoke']);
  });
});

describe('time', () => {
  test('the slot is the overlap, not the union', () => {
    const c = buildConsensus(
      huddleOf([
        person('Ana', free('2026-08-01', '17:00', '20:00')),
        person('Bo', free('2026-08-01', '18:00', '22:00')),
      ])
    );
    const slot = c.slots.find((s) => s.date === '2026-08-01');
    assert.ok(slot, 'a shared window exists');
    assert.equal(slot.earliest, '18:00');
    assert.equal(slot.latest, '20:00');
    assert.deepEqual(slot.attending.sort(), ['Ana', 'Bo']);
  });

  test('one outlier does not zero out the day', () => {
    // Three people free all evening, one free only at breakfast. The best
    // window should still be the evening the three share.
    const c = buildConsensus(
      huddleOf([
        person('Ana', free('2026-08-01', '17:00', '22:00')),
        person('Bo', free('2026-08-01', '17:00', '22:00')),
        person('Cy', free('2026-08-01', '17:00', '22:00')),
        person('Dee', free('2026-08-01', '07:00', '08:30')),
      ])
    );
    const slot = c.slots.find((s) => s.date === '2026-08-01');
    assert.ok(slot);
    assert.equal(slot.attending.length, 3, 'the majority window wins');
    assert.ok(!slot.attending.includes('Dee'));
    assert.ok(
      c.frictions.some((f) => f.startsWith('Dee')),
      "and Dee's exclusion is stated rather than hidden"
    );
  });

  test('overlaps shorter than an hour are not offered', () => {
    const c = buildConsensus(
      huddleOf([
        person('Ana', free('2026-08-01', '17:00', '18:00')),
        person('Bo', free('2026-08-01', '17:30', '20:00')),
      ])
    );
    // The shared stretch is 30 minutes — not a plan, so it isn't presented as one.
    assert.equal(c.slots.length, 0);
  });

  test('slots rank by how many people can actually come', () => {
    const c = buildConsensus(
      huddleOf(
        [
          person('Ana', {
            availability: [
              { date: '2026-08-01', earliest: '17:00', latest: '22:00' },
              { date: '2026-08-02', earliest: '17:00', latest: '22:00' },
            ],
          }),
          person('Bo', { availability: [{ date: '2026-08-02', earliest: '17:00', latest: '22:00' }] }),
        ],
        { start: '2026-08-01', end: '2026-08-02' }
      )
    );
    // A plan two people can attend beats a nicer plan one person can.
    assert.equal(c.slots[0].date, '2026-08-02');
    assert.equal(c.slots[0].attending.length, 2);
  });
});

describe('who has answered', () => {
  test('silent participants are counted as pending, not as agreement', () => {
    const c = buildConsensus(
      huddleOf([
        person('Ana', free('2026-08-01', '17:00', '22:00')),
        { id: 'p_quiet', name: 'Quinn', done: false, prefs: emptyPrefs() },
      ])
    );
    assert.equal(c.respondedCount, 1);
    assert.equal(c.totalCount, 2);
    assert.ok(c.frictions.some((f) => f.includes('Quinn') && f.includes("hasn't answered")));
  });
});
