// The safety properties.
//
// Two claims in this codebase are load-bearing, and both are about not hurting
// a specific, named person:
//
//   1. A venue that fails a hard constraint is never surfaced. Filtering runs
//      in plain JavaScript before the model is consulted, so a hallucinated
//      wheelchair ramp is impossible rather than unlikely.
//   2. Accessibility and dietary claims are never labelled `computed`. We did
//      not verify them; the catalog said so. A green tick on an unverified
//      ramp is the failure that puts someone outside a door they can't get
//      through.
//
// The LLM is disabled here so these test the deterministic path — which is the
// path that has to hold when the model is unavailable, rate limited, or wrong.
process.env.HUDDLE_DISABLE_LLM = '1';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { recommend } from '../src/recommend.mjs';
import { buildConsensus } from '../src/consensus.mjs';
import { emptyPrefs } from '../src/extract.mjs';

const CATALOG = JSON.parse(readFileSync(new URL('../data/venues.json', import.meta.url))).venues;
/** The full catalog record behind an option, including tags the client never sees. */
const catalogEntry = (opt) => {
  const found = CATALOG.find((v) => v.id === opt.venue.id);
  assert.ok(found, `option references unknown venue ${opt.venue.id}`);
  return found;
};

function person(name, prefs = {}) {
  return { id: `p_${name}`, name, done: true, prefs: { ...emptyPrefs(), ...prefs } };
}

const evening = (date = '2026-08-01') => ({
  availability: [{ date, earliest: '17:00', latest: '22:00' }],
});

/** Build a real huddle + consensus and run the recommender over the catalog. */
async function planFor(prefsList, groupType = 'friends') {
  const participants = prefsList.map((p, i) => person(p.name || `P${i}`, p));
  const huddle = {
    id: 'h_test',
    title: 'Test outing',
    city: 'Portland, OR',
    groupType,
    partySize: participants.length,
    participants,
    window: { start: '2026-08-01', end: '2026-08-03' },
  };
  const consensus = buildConsensus(huddle);
  const result = await recommend({ huddle, consensus });
  return { result, consensus };
}

describe('hard constraints are enforced before the model, not by it', () => {
  test('no option ever exceeds the cheapest budget', async () => {
    const { result, consensus } = await planFor([
      { name: 'Ana', ...evening(), budgetMaxPerPerson: 60 },
      { name: 'Dennis', ...evening(), budgetMaxPerPerson: 20 },
    ]);
    assert.equal(consensus.budgetCeiling, 20);
    assert.ok(result.options.length > 0, 'there should be something under $20');
    for (const opt of result.options) {
      assert.ok(
        opt.estimatePerPerson <= 20,
        `"${opt.venue.name}" is $${opt.estimatePerPerson}/person, over the $20 ceiling`
      );
    }
  });

  test('no option violates an accessibility requirement', async () => {
    const { result } = await planFor([
      { name: 'Marta', ...evening(), accessibility: ['step-free'] },
      { name: 'Bo', ...evening() },
    ]);
    assert.ok(result.options.length > 0);
    for (const opt of result.options) {
      // The option's `venue` is a deliberately narrow projection — it does not
      // carry raw accessibility tags, so a client cannot render them as if we
      // had checked. Verify against the catalog it was drawn from instead.
      assert.ok(
        catalogEntry(opt).accessibility.includes('step-free'),
        `"${opt.venue.name}" was offered to someone who needs step-free access`
      );
    }
  });

  test('no restaurant option violates a dietary requirement', async () => {
    const { result } = await planFor([
      { name: 'Sam', ...evening(), dietary: ['vegetarian'] },
      { name: 'Bo', ...evening() },
    ]);
    for (const opt of result.options) {
      const entry = catalogEntry(opt);
      if (entry.category !== 'restaurant') continue;
      assert.ok(
        entry.dietary.includes('vegetarian'),
        `restaurant "${opt.venue.name}" has no vegetarian option`
      );
    }
  });

  test('the venue projection never leaks unverified tags to the client', async () => {
    const { result } = await planFor([
      { name: 'Marta', ...evening(), accessibility: ['step-free'], budgetMaxPerPerson: 40 },
      { name: 'Bo', ...evening(), budgetMaxPerPerson: 40 },
    ]);
    for (const opt of result.options) {
      // Accessibility and dietary reach the UI only through `accommodates`,
      // where they are labelled `listing`. Exposing the raw arrays would let a
      // renderer present them with no label at all.
      assert.equal(opt.venue.accessibility, undefined);
      assert.equal(opt.venue.dietary, undefined);
    }
  });

  test('a veto is honoured', async () => {
    const { result } = await planFor([
      { name: 'Ana', ...evening(), avoid: ['bowling'] },
      { name: 'Bo', ...evening() },
    ]);
    for (const opt of result.options) {
      const haystack = [opt.venue.name, opt.venue.category, ...(opt.venue.vibes || [])]
        .join(' ')
        .toLowerCase();
      assert.ok(!haystack.includes('bowling'), `"${opt.venue.name}" was vetoed`);
    }
  });

  test('an impossible ask returns nothing rather than a compromise', async () => {
    // Nobody's catalog has a step-free venue under a dollar.
    const { result } = await planFor([
      { name: 'Marta', ...evening(), accessibility: ['step-free'], budgetMaxPerPerson: 1 },
      { name: 'Bo', ...evening(), budgetMaxPerPerson: 1 },
    ]);
    assert.equal(result.options.length, 0);
    assert.ok(
      result.shortfall || result.blocked,
      'and it says which constraint did the excluding'
    );
  });
});

describe('claims are labelled by how much we actually know', () => {
  test('accessibility is never presented as computed', async () => {
    const { result } = await planFor([
      { name: 'Marta', ...evening(), accessibility: ['step-free'], budgetMaxPerPerson: 40 },
      { name: 'Bo', ...evening(), budgetMaxPerPerson: 40 },
    ]);
    assert.ok(result.options.length > 0);
    for (const opt of result.options) {
      for (const claim of opt.accommodates) {
        if (/step-free|wheelchair|accessib/i.test(claim.text)) {
          assert.equal(
            claim.source,
            'listing',
            `"${claim.text}" claimed as computed — we never verified it`
          );
        }
      }
    }
  });

  test('dietary is never presented as computed', async () => {
    const { result } = await planFor([
      { name: 'Sam', ...evening(), dietary: ['vegetarian'], budgetMaxPerPerson: 40 },
      { name: 'Bo', ...evening(), budgetMaxPerPerson: 40 },
    ]);
    for (const opt of result.options) {
      for (const claim of opt.accommodates) {
        if (/vegetarian|vegan|gluten/i.test(claim.text)) {
          assert.equal(claim.source, 'listing', `"${claim.text}" must not carry the green tick`);
        }
      }
    }
  });

  test('budget arithmetic IS ours, so it is computed', async () => {
    const { result } = await planFor([
      { name: 'Ana', ...evening(), budgetMaxPerPerson: 30 },
      { name: 'Bo', ...evening(), budgetMaxPerPerson: 30 },
    ]);
    const budgetClaims = result.options
      .flatMap((o) => o.accommodates)
      .filter((a) => /under \$/.test(a.text));
    assert.ok(budgetClaims.length > 0, 'the ceiling should be stated on the card');
    for (const claim of budgetClaims) assert.equal(claim.source, 'computed');
  });

  test('an option carrying a listing claim tells you to confirm it', async () => {
    const { result } = await planFor([
      { name: 'Marta', ...evening(), accessibility: ['step-free'], budgetMaxPerPerson: 40 },
      { name: 'Bo', ...evening(), budgetMaxPerPerson: 40 },
    ]);
    for (const opt of result.options) {
      if (opt.accommodates.some((a) => a.source === 'listing')) {
        assert.ok(opt.confirmNote, `"${opt.venue.name}" makes an unverified claim with no caveat`);
      }
    }
  });

  test('every claim carries a source — there is no third, unlabelled kind', async () => {
    const { result } = await planFor([
      { name: 'Marta', ...evening(), accessibility: ['step-free'], budgetMaxPerPerson: 40 },
      { name: 'Sam', ...evening(), dietary: ['vegetarian'], budgetMaxPerPerson: 35 },
    ]);
    for (const opt of result.options) {
      for (const claim of opt.accommodates) {
        assert.ok(
          claim.source === 'computed' || claim.source === 'listing',
          `"${claim.text}" has source ${JSON.stringify(claim.source)}`
        );
      }
    }
  });
});

describe('no invented social proof', () => {
  test('options carry no rating, review count, or star field', async () => {
    const { result } = await planFor([
      { name: 'Ana', ...evening(), budgetMaxPerPerson: 40 },
      { name: 'Bo', ...evening(), budgetMaxPerPerson: 40 },
    ]);
    assert.ok(result.options.length > 0);
    for (const opt of result.options) {
      const blob = JSON.stringify(opt).toLowerCase();
      for (const banned of ['rating', 'reviewcount', 'stars', '"review"']) {
        assert.ok(!blob.includes(banned), `option leaked a ${banned} field`);
      }
    }
  });
});

describe('output shape', () => {
  test('returns at most three options, each bookable', async () => {
    const { result } = await planFor([
      { name: 'Ana', ...evening(), budgetMaxPerPerson: 50 },
      { name: 'Bo', ...evening(), budgetMaxPerPerson: 50 },
    ]);
    assert.ok(result.options.length <= 3);
    for (const opt of result.options) {
      assert.ok(opt.links?.length, `"${opt.venue.name}" has no links — it must be actionable`);
      assert.ok(opt.slot.label, 'an option without a stated time is not a plan');
      assert.ok(opt.why, 'each option explains itself');
    }
  });

  test('options are distinct venues, not three versions of one evening', async () => {
    const { result } = await planFor([
      { name: 'Ana', ...evening(), budgetMaxPerPerson: 50 },
      { name: 'Bo', ...evening(), budgetMaxPerPerson: 50 },
    ]);
    const names = result.options.map((o) => o.venue.name);
    assert.equal(new Set(names).size, names.length);
  });

  test('when nobody overlaps, every option names who is missing out', async () => {
    // Ana is a breakfast person, Bo is a night owl; they share nothing. Rather
    // than refusing, the recommender offers each window and states the cost —
    // which is more useful than a blocked message, but only because it is
    // explicit about who loses out.
    const { result } = await planFor([
      { name: 'Ana', availability: [{ date: '2026-08-01', earliest: '07:00', latest: '08:30' }] },
      { name: 'Bo', availability: [{ date: '2026-08-02', earliest: '20:00', latest: '22:00' }] },
    ]);
    assert.ok(result.options.length > 0);
    for (const opt of result.options) {
      const missing = opt.accommodates.filter((a) => /can't make this one/.test(a.text));
      assert.equal(missing.length, 1, `"${opt.venue.name}" hides that someone can't attend`);
      assert.equal(missing[0].source, 'computed', 'we worked this out, so we own it');
    }
  });

  test('with no usable window at all, it blocks and says so accurately', async () => {
    const { result } = await planFor([
      { name: 'Ana', budgetMaxPerPerson: 30 },
      { name: 'Bo', budgetMaxPerPerson: 30 },
    ]);
    assert.equal(result.options.length, 0);
    assert.ok(result.blocked);
    // The old copy claimed two people had to share a slot, which the code has
    // never required. A product about accurate claims cannot misstate its own.
    assert.ok(
      !/at least two people/.test(result.blocked),
      'blocked message must not assert a rule the recommender does not enforce'
    );
  });
});
