// Tier-1 booking links, the Tier-2 -> Tier-1 degrade, and the computed split.
//
// Configure Tier 2 up front: since the aggregator hold is stubbed (returns no
// ref), book() must DEGRADE to the Tier-1 deep link with status 'link' — the
// same fallback shape as the search-tool / structured-output fallbacks. If this
// ever "confirms" without a real ref, that's the honesty rule breaking.
process.env.HUDDLE_BOOKING_TIER = '2';
process.env.HUDDLE_BOOKING_PROVIDER = 'rwg';
process.env.HUDDLE_BOOKING_API_KEY = 'test-key';
process.env.HUDDLE_SPLIT_PROVIDER = 'venmo';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bookingDeepLink, book, billSplitFor } from '../src/booking.mjs';

const option = (booking) => ({
  id: 'opt_1',
  venue: { id: 'v1', name: 'Neighborhood Noodle House', booking },
  slot: { date: '2026-08-01', start: '18:30', end: '20:30' },
  estimatePerPerson: 18,
  estimateTotal: 90,
  links: [],
});

describe('tier-1 deep links (pre-filled party / date / time)', () => {
  test('OpenTable carries covers, dateTime and size', () => {
    const url = bookingDeepLink(option('opentable'), { partySize: 5, date: '2026-08-01', time: '18:30' });
    assert.match(url, /opentable\.com/);
    assert.match(url, /covers=5/);
    assert.match(url, /size=5/);
    assert.match(url, /dateTime=2026-08-01/);
  });
  test('Resy carries seats and date', () => {
    const url = bookingDeepLink(option('resy'), { partySize: 4, date: '2026-08-01' });
    assert.match(url, /resy\.com/);
    assert.match(url, /seats=4/);
    assert.match(url, /date=2026-08-01/);
  });
  test('Tock carries date, time and size', () => {
    const url = bookingDeepLink(option('tock'), { partySize: 3, date: '2026-08-01', time: '18:30' });
    assert.match(url, /exploretock\.com/);
    assert.match(url, /size=3/);
    assert.match(url, /time=18/);
  });
  test('unknown booking type falls back to an honest search url', () => {
    const url = bookingDeepLink(option('none'), { partySize: 2 });
    assert.match(url, /duckduckgo\.com/);
    // never a fabricated listing id
    assert.doesNotMatch(url, /\/r\/\d+|restaurant_id/);
  });
});

describe('book(): tier-2 stub degrades to the tier-1 link', () => {
  test('a stubbed hold never claims confirmed — it returns a link', async () => {
    const r = await book(option('opentable'), { partySize: 4, date: '2026-08-01', time: '18:30' });
    assert.equal(r.status, 'link', 'no real ref, so it must NOT say confirmed');
    assert.equal(r.tier, 1);
    assert.equal(r.ref, null);
    assert.match(r.url, /opentable\.com/);
    assert.equal(r.optionId, 'opt_1');
    assert.equal(r.venueName, 'Neighborhood Noodle House');
    assert.equal(r.stale, false);
  });
  test('book() never throws', async () => {
    await assert.doesNotReject(() => book(option('none'), {}));
  });
});

describe('billSplitFor(): computed arithmetic, request links only', () => {
  test('per-person and total come straight from the option estimate', () => {
    const s = billSplitFor(option('opentable'), 5);
    assert.equal(s.perPerson, 18);
    assert.equal(s.total, 90);
    assert.equal(s.count, 5);
    assert.equal(s.source, 'computed'); // renders green
  });
  test('a Venmo request link is pre-filled with the amount', () => {
    const s = billSplitFor(option('opentable'), 5);
    const venmo = s.requestLinks.find((l) => l.provider === 'venmo');
    assert.ok(venmo);
    assert.match(venmo.url, /amount=18/);
    assert.match(venmo.url, /txn=charge/);
  });
  test('no invented score field anywhere on the split', () => {
    const blob = JSON.stringify(billSplitFor(option('opentable'), 4)).toLowerCase();
    for (const banned of ['rating', 'stars', 'review', 'score']) {
      assert.ok(!blob.includes(banned), `split leaked a ${banned} field`);
    }
  });
});
