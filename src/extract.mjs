// Turns a free-text chat message into structured preferences.
//
// Two paths, identical output shape:
//   1. Claude with a JSON schema (accurate, handles "grandma uses a walker")
//   2. A keyword/regex fallback so the app works with no credentials at all
import { structured, llmAvailable } from './llm.mjs';
import { DIETARY, ACCESSIBILITY, VIBES, TIME_BUCKETS } from './vocab.mjs';
import { datesInWindow, dayName, todayStr, addDays, formatDate } from './timeutil.mjs';

export function emptyPrefs() {
  return {
    displayName: null,
    availability: [],
    budgetMaxPerPerson: null,
    dietary: [],
    accessibility: [],
    vibes: [],
    avoid: [],
    notes: '',
  };
}

const nullable = (type) => ({ anyOf: [{ type }, { type: 'null' }] });

const PREFS_SCHEMA = {
  type: 'object',
  properties: {
    displayName: nullable('string'),
    availability: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD, must be inside the huddle window' },
          earliest: { type: 'string', description: 'HH:MM 24h, earliest they can start' },
          latest: { type: 'string', description: 'HH:MM 24h, latest they must be done by' },
        },
        required: ['date', 'earliest', 'latest'],
        additionalProperties: false,
      },
    },
    budgetMaxPerPerson: {
      anyOf: [{ type: 'number' }, { type: 'null' }],
      description: 'Most this person is comfortable spending, in whole currency units',
    },
    dietary: { type: 'array', items: { type: 'string', enum: DIETARY } },
    accessibility: { type: 'array', items: { type: 'string', enum: ACCESSIBILITY } },
    vibes: { type: 'array', items: { type: 'string', enum: VIBES } },
    avoid: {
      type: 'array',
      items: { type: 'string' },
      description: 'Hard vetoes: cuisines, venue types, or activities to exclude',
    },
    notes: { type: 'string', description: 'Anything else worth carrying into the plan' },
  },
  required: [
    'displayName',
    'availability',
    'budgetMaxPerPerson',
    'dietary',
    'accessibility',
    'vibes',
    'avoid',
    'notes',
  ],
  additionalProperties: false,
};

const TURN_SCHEMA = {
  type: 'object',
  properties: {
    reply: {
      type: 'string',
      description: 'One or two sentences back to the participant. Warm, brief, no bullet lists.',
    },
    prefs: PREFS_SCHEMA,
    done: {
      type: 'boolean',
      description: 'True once you have availability and a budget and have nothing left to ask.',
    },
  },
  required: ['reply', 'prefs', 'done'],
  additionalProperties: false,
};

function systemPrompt(huddle) {
  const days = datesInWindow(huddle.window.start, huddle.window.end)
    .map((d) => `${d} (${dayName(d)})`)
    .join(', ');

  return `You are the planning companion inside a group chat. The group is sorting out: "${huddle.title}" in ${huddle.city}. Group type: ${huddle.groupType}. Party size: about ${huddle.partySize}. Candidate dates: ${days}.

Your job is to collect one person's constraints in as few messages as possible, then get out of the way. You need three things: when they are free, what they can spend, and any hard requirements (dietary, accessibility, mobility, things they refuse to do). Everything else is a bonus.

Rules:
- Ask for at most two missing things per message. Never send a checklist or a bulleted form.
- If they say something vague ("evening works", "cheap"), pick a sensible interpretation and reflect it back rather than interrogating them. "Cheap" is a budget; write down a number.
- Second-hand constraints count. "My grandma is coming and uses a walker" means step-free and reserved-seating go in accessibility, not in notes.
- Return the COMPLETE preference state every turn, carrying forward everything established earlier in this conversation. Do not return only the delta.
- Every availability date must be one of the candidate dates above, in YYYY-MM-DD form.
- Set done to true as soon as you have availability and a budget. Do not keep fishing for extras.
- Keep replies short. Two sentences is plenty.`;
}

/** Union arrays, prefer the newer scalar when it is set. */
export function mergePrefs(base, incoming) {
  if (!incoming) return base;
  const uniq = (a = [], b = []) => [...new Set([...a, ...b])];
  return {
    displayName: incoming.displayName || base.displayName,
    availability: incoming.availability?.length ? incoming.availability : base.availability,
    budgetMaxPerPerson:
      typeof incoming.budgetMaxPerPerson === 'number'
        ? incoming.budgetMaxPerPerson
        : base.budgetMaxPerPerson,
    dietary: uniq(base.dietary, incoming.dietary),
    accessibility: uniq(base.accessibility, incoming.accessibility),
    vibes: uniq(base.vibes, incoming.vibes),
    avoid: uniq(base.avoid, incoming.avoid),
    notes: [base.notes, incoming.notes].filter(Boolean).join(' ').trim().slice(0, 500),
  };
}

export async function readTurn({ huddle, participant, message }) {
  if (llmAvailable()) {
    const history = [...(participant.transcript || []), { role: 'user', content: message }].map(
      (turn) => ({ role: turn.role, content: turn.content })
    );

    const result = await structured({
      system: systemPrompt(huddle),
      messages: history,
      schema: TURN_SCHEMA,
      effort: 'low',
      maxTokens: 2000,
    });

    if (result) {
      return {
        reply: result.reply,
        prefs: sanitizePrefs(result.prefs, huddle),
        done: Boolean(result.done),
      };
    }
    // structured() already logged why; fall through to heuristics.
  }
  return heuristicTurn({ huddle, participant, message });
}

/** Clamp anything the model returned to values the rest of the app can trust. */
function sanitizePrefs(prefs, huddle) {
  const valid = new Set(datesInWindow(huddle.window.start, huddle.window.end));
  const base = emptyPrefs();
  if (!prefs) return base;

  const timeOk = (t) => typeof t === 'string' && /^\d{2}:\d{2}$/.test(t);

  return {
    displayName: prefs.displayName || null,
    availability: (prefs.availability || [])
      .filter((slot) => valid.has(slot?.date) && timeOk(slot.earliest) && timeOk(slot.latest))
      .filter((slot) => slot.earliest < slot.latest)
      .slice(0, 30),
    budgetMaxPerPerson:
      typeof prefs.budgetMaxPerPerson === 'number' && prefs.budgetMaxPerPerson >= 0
        ? Math.round(prefs.budgetMaxPerPerson)
        : null,
    dietary: (prefs.dietary || []).filter((d) => DIETARY.includes(d)),
    accessibility: (prefs.accessibility || []).filter((a) => ACCESSIBILITY.includes(a)),
    vibes: (prefs.vibes || []).filter((v) => VIBES.includes(v)),
    avoid: (prefs.avoid || []).map((s) => String(s).toLowerCase().trim()).filter(Boolean).slice(0, 10),
    notes: String(prefs.notes || '').slice(0, 500),
  };
}

// ---------------------------------------------------------------------------
// Heuristic fallback
// ---------------------------------------------------------------------------

const DIET_WORDS = {
  vegetarian: ['vegetarian', 'veggie', 'no meat'],
  vegan: ['vegan', 'plant based', 'plant-based'],
  'gluten-free': ['gluten', 'celiac', 'coeliac'],
  halal: ['halal'],
  kosher: ['kosher'],
  'dairy-free': ['dairy', 'lactose'],
  'nut-aware': ['nut allergy', 'peanut', 'nut-free', 'tree nut'],
  pescatarian: ['pescatarian'],
};

const ACCESS_WORDS = {
  'step-free': ['wheelchair', 'walker', 'step-free', 'stairs', 'ramp', 'mobility', 'cane'],
  'accessible-restroom': ['accessible restroom', 'accessible bathroom'],
  elevator: ['elevator', 'lift'],
  'quiet-space': ['hearing', 'hard of hearing', 'loud', 'noisy', 'quiet', 'sensory'],
  'reserved-seating': ['seating', 'sit down', 'need to sit', 'somewhere to sit'],
  'low-walking': ["can't walk far", 'cant walk far', 'not much walking', 'limited walking'],
};

const VIBE_WORDS = {
  casual: ['casual', 'chill', 'laid back', 'low key'],
  upscale: ['upscale', 'fancy', 'nice place', 'dress up'],
  lively: ['lively', 'fun', 'buzzing', 'energetic'],
  quiet: ['quiet', 'calm', 'mellow', 'talk', 'catch up'],
  outdoors: ['outdoor', 'outside', 'patio', 'park', 'fresh air'],
  active: ['active', 'move', 'sporty', 'exercise'],
  playful: ['games', 'game', 'playful', 'silly', 'competitive'],
  cozy: ['cozy', 'cosy', 'warm'],
  budget: ['cheap', 'budget', 'affordable', 'inexpensive'],
  'special-occasion': ['birthday', 'anniversary', 'celebrat', 'special'],
  conversation: ['catch up', 'talk', 'conversation', 'chat'],
  nightlife: ['bar', 'drinks', 'night out', 'club'],
  'indoor-rainy-day': ['rain', 'indoors', 'inside'],
};

function parseBudget(text) {
  const patterns = [
    /(?:under|below|max|maximum|up to|no more than|less than|around|about|roughly)\s*\$?\s*(\d{1,4})/i,
    /\$\s?(\d{1,4})/,
    /(\d{1,4})\s*(?:bucks|dollars|quid|euros?)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return Number(m[1]);
  }
  // "free" almost always means *available*, not *costless* — only treat it as a
  // budget when it is unambiguously about money.
  if (/\bfor free\b|\bno money\b|\bbroke\b|\bnothing to spend\b|\$\s?0\b/i.test(text)) return 0;
  if (/\bcheap\b|\bbudget\b|\baffordable\b/i.test(text)) return 20;
  if (/\bdoesn'?t matter\b|\bany budget\b|\bmy treat\b|\bwhatever\b/i.test(text)) return 200;
  return null;
}

function parseTimeWindow(text) {
  let earliest = null;
  let latest = null;

  const hourOf = (raw, meridiem) => {
    let h = Number(raw);
    if (meridiem) {
      const pm = /p/i.test(meridiem);
      if (pm && h < 12) h += 12;
      if (!pm && h === 12) h = 0;
    } else if (h <= 11) {
      h += 12; // bare "after 5" in a social-plans context means 5 PM
    }
    return `${String(Math.min(h, 23)).padStart(2, '0')}:00`;
  };

  const after = text.match(/(?:after|from|past|any time after)\s*(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)?/i);
  if (after) earliest = hourOf(after[1], after[2]);

  const before = text.match(/(?:before|until|til|till|by|home by|back by)\s*(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)?/i);
  if (before) latest = hourOf(before[1], before[2]);

  if (!earliest && !latest) {
    for (const bucket of TIME_BUCKETS) {
      if (new RegExp(`\\b${bucket.name.replace('-', '[ -]?')}\\b`, 'i').test(text)) {
        earliest = bucket.start;
        latest = bucket.end;
        break;
      }
    }
  }
  if (!earliest && !latest) return null;
  return { earliest: earliest || '11:00', latest: latest || '22:00' };
}

function parseAvailability(text, huddle) {
  const dates = datesInWindow(huddle.window.start, huddle.window.end);
  const window = parseTimeWindow(text) || { earliest: '11:00', latest: '22:00' };
  const hit = new Set();

  for (const date of dates) {
    const name = dayName(date);
    if (new RegExp(`\\b${name}\\b|\\b${name.slice(0, 3)}\\b`, 'i').test(text)) hit.add(date);
  }
  if (/\bweekend\b/i.test(text)) {
    dates.filter((d) => ['saturday', 'sunday'].includes(dayName(d))).forEach((d) => hit.add(d));
  }
  if (/\bweekday|during the week\b/i.test(text)) {
    dates
      .filter((d) => !['saturday', 'sunday'].includes(dayName(d)))
      .forEach((d) => hit.add(d));
  }
  if (/\btomorrow\b/i.test(text)) {
    const t = addDays(todayStr(), 1);
    if (dates.includes(t)) hit.add(t);
  }
  if (/\banytime\b|\bany day\b|\bwhenever\b|\bflexible\b|\bopen\b/i.test(text)) {
    dates.forEach((d) => hit.add(d));
  }
  // A bare time with no day at all ("free after 6") applies across the window.
  if (hit.size === 0 && parseTimeWindow(text)) dates.forEach((d) => hit.add(d));

  return [...hit].sort().map((date) => ({ date, ...window }));
}

function matchVocab(text, table) {
  const lower = text.toLowerCase();
  return Object.entries(table)
    .filter(([, words]) => words.some((w) => lower.includes(w)))
    .map(([key]) => key);
}

// "no way", "no idea", "no worries" are interjections, not vetoes. Without
// this the bot decides the group refuses to go anywhere called "way".
const NOT_A_VETO = new Set([
  'way',
  'idea',
  'problem',
  'worries',
  'worry',
  'clue',
  'thanks',
  'biggie',
  'rush',
  'doubt',
  'chance',
  'offense',
  'joke',
  'kidding',
  'really',
  'matter',
  'sure',
  'stress',
  'pressure',
  'one',
  'time',
]);

function parseAvoid(text) {
  const out = [];
  const re =
    /\b(?:no|not|cannot|avoid|hate|can'?t do|don'?t want|anything but)\s+([a-z][a-z ]{2,18})/gi;
  let m;
  while ((m = re.exec(text))) {
    const phrase = m[1]
      .trim()
      .replace(/^do\s+/i, '') // "cannot do sushi" -> "sushi"
      .replace(/\b(the|a|an|any|more|again|please|thanks)\b/g, '')
      .trim();
    const head = phrase.toLowerCase().split(/\s+/)[0];
    if (phrase.length > 2 && !NOT_A_VETO.has(head)) out.push(phrase.toLowerCase());
  }
  return out.slice(0, 5);
}

function heuristicTurn({ huddle, participant, message }) {
  const prior = participant.prefs || emptyPrefs();
  const found = {
    displayName: null,
    availability: parseAvailability(message, huddle),
    budgetMaxPerPerson: parseBudget(message),
    dietary: matchVocab(message, DIET_WORDS),
    accessibility: matchVocab(message, ACCESS_WORDS),
    vibes: matchVocab(message, VIBE_WORDS),
    avoid: parseAvoid(message),
    notes: '',
  };

  const prefs = mergePrefs(prior, found);
  const missing = [];
  if (!prefs.availability.length) missing.push('when you are free');
  if (prefs.budgetMaxPerPerson === null) missing.push('roughly what you want to spend per person');

  const acked = [];
  if (found.availability.length) {
    const first = found.availability[0];
    acked.push(
      found.availability.length === 1
        ? `${formatDate(first.date)} it is`
        : `got ${found.availability.length} days that work`
    );
  }
  if (found.budgetMaxPerPerson !== null) acked.push(`budget around ${found.budgetMaxPerPerson}`);
  if (found.dietary.length) acked.push(`noted: ${found.dietary.join(', ')}`);
  if (found.accessibility.length) acked.push(`accessibility: ${found.accessibility.join(', ')}`);
  if (found.avoid.length) acked.push(`skipping ${found.avoid.join(', ')}`);

  const head = acked.length ? `Got it — ${acked.join('; ')}.` : "Thanks, I've noted that.";
  const tail = missing.length
    ? ` Last thing: ${missing.join(' and ')}?`
    : " That's everything I need — you're done.";

  return { reply: head + tail, prefs, done: missing.length === 0 };
}
