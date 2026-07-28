// Closing the booking loop, in tiers behind a capability check.
//
// Same degrade philosophy as the model fallbacks (search-tool version, then
// structured-output mode): a higher tier that isn't configured or fails falls
// back to the tier below, and the reservation record says exactly how far it
// got. Nothing here holds funds or invents a rating.
//
// Tier is env-configurable, like the llm.mjs capability table:
//   HUDDLE_BOOKING_TIER=1        deep links only (default)
//   HUDDLE_BOOKING_TIER=2 + HUDDLE_BOOKING_PROVIDER + HUDDLE_BOOKING_API_KEY
//                               attempt a real hold, fall back to the link
//   HUDDLE_SPLIT_PROVIDER=venmo|splitwise|stripe

const enc = encodeURIComponent;

export const BOOKING = {
  tier: Number(process.env.HUDDLE_BOOKING_TIER || 1),
  provider: process.env.HUDDLE_BOOKING_PROVIDER || null,
  apiKey: process.env.HUDDLE_BOOKING_API_KEY || null,
  split: (process.env.HUDDLE_SPLIT_PROVIDER || 'venmo').toLowerCase(),
};

/**
 * A reservation deep link with party size / date / time pre-filled. Honest by
 * construction: a SEARCH url scoped to the venue name, never a fabricated
 * listing id that could 404 or point at a business that has moved.
 */
export function bookingDeepLink(option, { partySize, date, time } = {}) {
  const name = option.venue.name;
  const size = partySize || 2;
  const d = date || option.slot.date;
  const t = time || option.slot.start;
  switch (option.venue.booking) {
    case 'opentable':
      return `https://www.opentable.com/s?term=${enc(name)}&covers=${size}&dateTime=${enc(`${d} ${t}`)}&size=${size}`;
    case 'resy':
      return `https://resy.com/cities?query=${enc(name)}&seats=${size}&date=${d}`;
    case 'tock':
      return `https://www.exploretock.com/search?query=${enc(name)}&date=${d}&time=${enc(t)}&size=${size}`;
    default:
      return `https://duckduckgo.com/?q=${enc(`${name} reservation ${d}`)}`;
  }
}

/**
 * Book an option. Returns a reservation record; never throws.
 *   Tier 1: the deep link, status 'link' — we did NOT confirm anything.
 *   Tier 2: attempt a real hold; on ANY failure, degrade to the tier-1 link.
 */
export async function book(option, { partySize, date, time } = {}) {
  const url = bookingDeepLink(option, { partySize, date, time });
  const base = {
    optionId: option.id,
    venueName: option.venue.name, // a label for later warnings; not a score
    tier: 1,
    status: 'link', // renders like `listing`: unconfirmed
    provider: option.venue.booking && option.venue.booking !== 'none' ? option.venue.booking : null,
    partySize: partySize || null,
    date: date || option.slot.date,
    time: time || option.slot.start,
    url,
    ref: null,
    stale: false,
    createdAt: new Date().toISOString(),
  };

  if (BOOKING.tier >= 2 && BOOKING.provider && BOOKING.apiKey) {
    try {
      const held = await attemptHold(option, base);
      if (held?.ref) {
        // A real hold came back — this one renders like `computed`.
        return { ...base, tier: 2, status: 'confirmed', provider: BOOKING.provider, ref: held.ref, url: held.url || url };
      }
    } catch (err) {
      console.warn('[booking] tier-2 hold failed — degrading to deep link:', err.message);
    }
  }
  return base;
}

// Tier-2 aggregator hold. STUB: no partner API is wired, so it reports "not
// held" and the caller degrades to the tier-1 deep link. The shape is real;
// swap the body for a Reserve-with-Google / OpenTable-partner call.
async function attemptHold(/* option, base */) {
  return { ref: null };
}

/**
 * Bill split — pure arithmetic derived from the option's already-computed
 * per-person estimate, so it renders in the green "we did the math" style. No
 * funds are held: request links only, with amount + note pre-filled where the
 * provider supports it.
 */
export function billSplitFor(option, count) {
  const n = Math.max(1, count || 1);
  const perPerson = option.estimatePerPerson;
  const total = option.estimateTotal ?? perPerson * n;
  const note = `${option.venue.name} (via Huddle)`;
  const links = [];
  if (perPerson > 0) {
    if (BOOKING.split === 'venmo') {
      links.push({
        provider: 'venmo',
        label: 'Request on Venmo',
        url: `https://venmo.com/?txn=charge&amount=${perPerson}&note=${enc(note)}`,
      });
    } else if (BOOKING.split === 'splitwise') {
      // Splitwise has no documented prefill deep link — link to the app; STUB.
      links.push({ provider: 'splitwise', label: 'Add to Splitwise', url: 'https://www.splitwise.com/' });
    } else if (BOOKING.split === 'stripe') {
      // A real Stripe Payment Link must be created server-side; STUB.
      links.push({ provider: 'stripe', label: 'Stripe payment link', url: 'https://dashboard.stripe.com/payment-links' });
    }
  }
  return { perPerson, total, count: n, currency: 'USD', source: 'computed', requestLinks: links };
}
