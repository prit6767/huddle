// Consensus + venue catalog -> exactly three finalized, bookable options.
//
// Hard constraints filter. Soft preferences score. Claude writes the rationale
// but never overrides the filter — a venue that fails accessibility or budget
// cannot be surfaced no matter what the model prefers.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { structured, llmAvailable } from './llm.mjs';
import { ACCESSIBILITY_PROXY, GROUP_AGE_FIT, TIME_BUCKETS } from './vocab.mjs';
import { toMinutes, fromMinutes, formatDate, formatTime } from './timeutil.mjs';
import { buildLinks } from './links.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CATALOG = JSON.parse(readFileSync(join(here, '..', 'data', 'venues.json'), 'utf8')).venues;

const MAX_SLOTS_CONSIDERED = 3;
const CANDIDATE_POOL = 8;

function bucketsFor(hhmm) {
  const m = toMinutes(hhmm);
  return TIME_BUCKETS.filter((b) => m >= toMinutes(b.start) && m <= toMinutes(b.end)).map(
    (b) => b.name
  );
}

/** Does the venue satisfy an accessibility need, directly or via a proxy tag? */
function meetsAccessNeed(venue, need) {
  if (venue.accessibility.includes(need)) return true;
  const proxies = ACCESSIBILITY_PROXY[need] || [];
  return proxies.length > 0 && proxies.every((p) => venue.accessibility.includes(p));
}

function vetoed(venue, avoidList) {
  const haystack = [venue.name, venue.category, venue.cuisine, ...(venue.vibes || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return avoidList.some((term) => term.length > 2 && haystack.includes(term));
}

/**
 * Every (venue, slot) pairing that survives the hard constraints, plus a tally
 * of what each filter rejected — so a thin result set can explain itself.
 */
function candidates(consensus, groupType) {
  const slots = consensus.slots.slice(0, MAX_SLOTS_CONSIDERED);
  const acceptableAges = GROUP_AGE_FIT[groupType] || GROUP_AGE_FIT.mixed;
  const out = [];
  const excluded = { budget: 0, dietary: 0, accessibility: 0, veto: 0, groupSize: 0, ageFit: 0 };

  for (const venue of CATALOG) {
    // --- hard filters, venue-level ---
    if (consensus.budgetCeiling !== null && venue.perPerson > consensus.budgetCeiling) {
      excluded.budget++;
      continue;
    }
    if (
      !consensus.dietary.every((d) => venue.dietary.includes(d) || venue.category !== 'restaurant')
    ) {
      excluded.dietary++;
      continue;
    }
    if (!consensus.accessibility.every((a) => meetsAccessNeed(venue, a))) {
      excluded.accessibility++;
      continue;
    }
    if (vetoed(venue, consensus.avoid)) {
      excluded.veto++;
      continue;
    }
    if (consensus.partySize < venue.groupMin || consensus.partySize > venue.groupMax) {
      excluded.groupSize++;
      continue;
    }
    if (!venue.ageFit.some((a) => acceptableAges.includes(a))) {
      excluded.ageFit++;
      continue;
    }

    for (const slot of slots) {
      // --- hard filters, timing ---
      const windowMins = toMinutes(slot.latest) - toMinutes(slot.earliest);
      if (windowMins < 60) continue;

      const start = slot.earliest;
      const durationMins = Math.min(venue.durationMins, windowMins);
      if (durationMins < Math.min(60, venue.durationMins * 0.6)) continue;
      const end = fromMinutes(toMinutes(start) + durationMins);

      const buckets = bucketsFor(start);
      const timeFits = venue.goodFor.some((g) => buckets.includes(g));

      out.push({
        venue,
        slot: { ...slot, start, end, durationMins },
        timeFits,
        trimmed: durationMins < venue.durationMins,
        score: 0,
        reasons: [],
      });
    }
  }
  return { pairs: out, excluded };
}

/** Explain a thin result set by naming the filter that rejected the most venues. */
function explainShortfall(count, excluded, consensus) {
  const labels = {
    budget:
      consensus.budgetCeiling !== null
        ? `the $${consensus.budgetCeiling}/person ceiling`
        : 'the budget ceiling',
    dietary: `the ${consensus.dietary.join(' + ')} requirement`,
    accessibility: `the ${consensus.accessibility.join(' + ')} requirement`,
    veto: `the "${consensus.avoid.join('", "')}" veto`,
    groupSize: `the group size of ${consensus.partySize}`,
    ageFit: 'who is coming',
  };

  const [key, n] = Object.entries(excluded).sort((a, b) => b[1] - a[1])[0] || [];
  const lead =
    count === 0
      ? 'Nothing in the catalog clears'
      : count === 1
        ? 'Only one option clears'
        : `Only ${count} options clear`;

  if (!key || !n) return `${lead} every constraint.`;
  return `${lead} every constraint — ${labels[key]} rules out ${n} of ${CATALOG.length} venues. Loosen it and re-run for more choice.`;
}

function score(candidate, consensus) {
  const { venue, slot } = candidate;
  let total = 0;
  const reasons = [];

  // Attendance is the single most important thing about a plan.
  total += slot.attending.length * 4;
  if (slot.missing.length === 0 && consensus.respondedCount > 1) {
    reasons.push('everyone who answered is free');
  }

  for (const { vibe, count } of consensus.vibes) {
    if (venue.vibes.includes(vibe)) {
      total += count * 3;
      reasons.push(`matches "${vibe}"`);
    }
  }

  if (candidate.timeFits) total += 5;
  else total -= 6;

  if (candidate.trimmed) total -= 3;

  if (consensus.budgetCeiling !== null && consensus.budgetCeiling > 0) {
    const headroom = (consensus.budgetCeiling - venue.perPerson) / consensus.budgetCeiling;
    total += Math.round(headroom * 4);
    if (headroom > 0.35) reasons.push('comfortably under the tightest budget');
  }

  // Reward accessibility beyond the stated minimum — it costs the group nothing.
  const extraAccess = venue.accessibility.filter((a) => !consensus.accessibility.includes(a)).length;
  total += Math.min(extraAccess, 3);

  if (consensus.dietary.length && venue.category === 'restaurant') {
    const covered = consensus.dietary.filter((d) => venue.dietary.includes(d));
    if (covered.length === consensus.dietary.length) {
      reasons.push(`covers ${covered.join(' + ')}`);
    }
  }

  candidate.score = total;
  candidate.reasons = reasons;
  return candidate;
}

/** Best-scoring, one venue each, preferring different categories. */
function diversify(ranked, n = 3) {
  const picked = [];
  const seenVenues = new Set();
  const seenCategories = new Set();

  for (const pass of [1, 2]) {
    for (const c of ranked) {
      if (picked.length >= n) break;
      if (seenVenues.has(c.venue.id)) continue;
      if (pass === 1 && seenCategories.has(c.venue.category)) continue;
      picked.push(c);
      seenVenues.add(c.venue.id);
      seenCategories.add(c.venue.category);
    }
  }
  return picked;
}

/**
 * What this option does for the group — split by how much we actually know.
 *
 *   source: 'computed' — we derived it ourselves from what people said.
 *           Budget arithmetic and who can attend are genuinely verified.
 *   source: 'listing'  — it came from the venue catalog. We have NOT confirmed
 *           it. Accessibility and dietary claims live here, and they are the
 *           two where being wrong actually hurts someone: a wheelchair user
 *           who can't get in the door, a coeliac who gets sick. The UI must
 *           never present these with the same confidence as the arithmetic.
 */
function accommodationsFor(candidate, consensus) {
  const out = [];
  const { venue } = candidate;
  const named = (item, label) => {
    const who = consensus.attribution[item];
    return who?.length ? `${label} (for ${who.join(', ')})` : label;
  };

  for (const need of consensus.accessibility) {
    out.push({ text: named(need, need), source: 'listing' });
  }
  for (const diet of consensus.dietary) {
    if (venue.dietary.includes(diet)) {
      out.push({ text: named(diet, `${diet} options`), source: 'listing' });
    }
  }
  if (consensus.budgetCeiling !== null) {
    out.push({
      text: named(`budget:${consensus.budgetCeiling}`, `under $${consensus.budgetCeiling}/person`),
      source: 'computed',
    });
  }
  if (candidate.slot.missing.length) {
    out.push({ text: `${candidate.slot.missing.join(', ')} can't make this one`, source: 'computed' });
  }

  // Computed first, listed after. What we actually know leads; what the
  // catalog merely claims follows. The order is part of the honesty system,
  // so it is settled here rather than left to each renderer.
  return out
    .sort((a, b) => (a.source === b.source ? 0 : a.source === 'computed' ? -1 : 1))
    .slice(0, 6);
}

/**
 * The fallback rationale when Claude isn't available. Leads with what makes
 * this option different from the other two, so three cards don't read alike.
 */
function deterministicWhy(candidate, consensus) {
  const { venue, slot } = candidate;

  const distinctive =
    venue.setting === 'outdoor'
      ? 'Outdoors'
      : venue.noise === 'low'
        ? 'Quiet enough to actually talk'
        : venue.noise === 'high'
          ? 'Loud and social'
          : `A ${venue.category === 'restaurant' ? venue.cuisine || 'sit-down' : venue.category} pick`;

  const parts = [
    `${distinctive}, and ${slot.attending.length} of ${consensus.respondedCount} are free ${formatDate(
      slot.date
    )} at ${formatTime(slot.start)}`,
  ];

  // "everyone is free" duplicates the clause above — drop it here.
  const extras = [...new Set(candidate.reasons)].filter(
    (r) => r !== 'everyone who answered is free' && r !== 'comfortably under the tightest budget'
  );
  if (extras.length) parts.push(extras.slice(0, 2).join(' and '));

  parts.push(venue.perPerson === 0 ? 'and it costs nothing' : `about $${venue.perPerson} a head`);
  return `${parts.join('; ')}.`;
}

const NARRATIVE_SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          candidateId: { type: 'string', description: 'The id from the candidate list' },
          headline: { type: 'string', description: 'Under 6 words, e.g. "The safe bet"' },
          why: {
            type: 'string',
            description:
              'One sentence naming the specific constraints this satisfies and who they belong to.',
          },
        },
        required: ['candidateId', 'headline', 'why'],
        additionalProperties: false,
      },
    },
    tradeoff: {
      type: 'string',
      description:
        'One sentence on what the group is giving up across all three, or empty if nothing.',
    },
  },
  required: ['picks', 'tradeoff'],
  additionalProperties: false,
};

async function narrate({ huddle, consensus, shortlist }) {
  if (!llmAvailable()) return null;

  const brief = {
    occasion: huddle.title,
    city: huddle.city,
    groupType: huddle.groupType,
    partySize: consensus.partySize,
    budgetCeilingPerPerson: consensus.budgetCeiling,
    hardDietary: consensus.dietary,
    hardAccessibility: consensus.accessibility,
    vetoes: consensus.avoid,
    preferredVibes: consensus.vibes,
    whoAskedForWhat: consensus.attribution,
    freeTextNotes: consensus.notes,
    candidates: shortlist.map((c, i) => ({
      candidateId: `c${i}`,
      venue: c.venue.name,
      category: c.venue.category,
      cuisine: c.venue.cuisine,
      perPerson: c.venue.perPerson,
      vibes: c.venue.vibes,
      accessibility: c.venue.accessibility,
      dietary: c.venue.dietary,
      when: `${c.slot.date} ${c.slot.start}-${c.slot.end}`,
      whoCanCome: c.slot.attending,
      whoCannot: c.slot.missing,
    })),
  };

  const result = await structured({
    system: `You are finalizing a group plan. You will get a group's merged constraints and a pre-filtered candidate list — every candidate already satisfies every hard constraint, so you are choosing on fit, not on safety.

Pick exactly three candidates that give the group genuinely different choices (not three variations of the same evening). For each, write a headline of under six words and one sentence explaining why it works, naming the specific person whose constraint it satisfies where you know it. Be concrete: "step-free and quiet enough for Marta's hearing aid" beats "accessible and comfortable".

Do not invent facts about a venue beyond what is in the candidate data. Do not recommend anything outside the candidate list.`,
    messages: [{ role: 'user', content: JSON.stringify(brief, null, 2) }],
    schema: NARRATIVE_SCHEMA,
    effort: 'medium',
    maxTokens: 3000,
  });

  return result;
}

export async function recommend({ huddle, consensus }) {
  if (!consensus.slots.length) {
    return {
      options: [],
      tradeoff: '',
      // Say what is actually true. Slots exist as soon as one person names a
      // window of an hour or more — the recommender does not require an
      // overlap, it just states who can't make each option. So the only way to
      // land here is that nobody has given a usable window yet.
      blocked:
        'Nobody has said when they\'re free yet — or the windows given are under an hour. Say a day and a rough time and I\'ll take it from there.',
      shortfall: null,
    };
  }

  const { pairs, excluded } = candidates(consensus, huddle.groupType);
  const scored = pairs.map((c) => score(c, consensus)).sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return {
      options: [],
      tradeoff: '',
      blocked: explainShortfall(0, excluded, consensus),
      shortfall: null,
    };
  }

  const shortlist = diversify(scored, CANDIDATE_POOL);
  const narrative = await narrate({ huddle, consensus, shortlist });

  let chosen;
  if (narrative?.picks?.length) {
    const byId = new Map(shortlist.map((c, i) => [`c${i}`, c]));
    chosen = narrative.picks
      .map((pick) => {
        const candidate = byId.get(pick.candidateId);
        return candidate ? { ...candidate, headline: pick.headline, why: pick.why } : null;
      })
      .filter(Boolean);
  }

  // Whether the model was unavailable, picked poorly, or returned too few,
  // top up from the deterministic ranking so the group always gets three.
  if (!chosen || chosen.length < 3) {
    chosen ||= [];
    const have = new Set(chosen.map((c) => c.venue.id));
    for (const c of diversify(shortlist, 3 + chosen.length)) {
      if (chosen.length >= 3) break;
      if (have.has(c.venue.id)) continue;
      chosen.push({ ...c, headline: null, why: deterministicWhy(c, consensus) });
      have.add(c.venue.id);
    }
  }

  const options = chosen.slice(0, 3).map((c, index) => ({
    id: `opt_${index + 1}`,
    headline: c.headline || ['The easy yes', 'The change of pace', 'The budget pick'][index] || 'Option',
    why: c.why,
    venue: {
      id: c.venue.id,
      name: c.venue.name,
      category: c.venue.category,
      cuisine: c.venue.cuisine,
      vibes: c.venue.vibes,
      noise: c.venue.noise,
      setting: c.venue.setting,
    },
    slot: {
      date: c.slot.date,
      day: c.slot.day,
      start: c.slot.start,
      end: c.slot.end,
      label: `${formatDate(c.slot.date)}, ${formatTime(c.slot.start)}–${formatTime(c.slot.end)}`,
      attending: c.slot.attending,
      missing: c.slot.missing,
    },
    estimatePerPerson: c.venue.perPerson,
    estimateTotal: c.venue.perPerson * consensus.partySize,
    accommodates: accommodationsFor(c, consensus),
    // Set when this option is carrying a claim we haven't confirmed and
    // someone is relying on it. Surfaced verbatim in every UI.
    confirmNote:
      consensus.accessibility.length || consensus.dietary.length
        ? 'Accessibility and dietary details come from the listing, not a check we ran — confirm with the venue before you commit.'
        : null,
    links: buildLinks({
      venue: c.venue,
      city: huddle.city,
      slot: c.slot,
      partySize: consensus.partySize,
      title: huddle.title,
    }),
    score: c.score,
  }));

  return {
    options,
    tradeoff: narrative?.tradeoff || '',
    blocked: null,
    // Fewer than three means a constraint is binding hard. Say which one
    // rather than quietly handing back a short list.
    shortfall: options.length < 3 ? explainShortfall(options.length, excluded, consensus) : null,
  };
}
