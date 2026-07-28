// Platform-neutral group-chat brain.
//
// Every adapter (Telegram, Discord, iMessage) normalises its own events into
// one shape and hands them here. This module owns all the behaviour; the
// adapters only translate. That is why adding a fourth platform is small.
//
// Incoming event:
//   { platform, chatId, chatTitle, userId, userName, text }
// Outgoing action:
//   { react?: '✅', text?: string, buttons?: [{id, label}], silent?: true }
import { createHuddle, saveHuddle, findHuddleByChat } from '../store.mjs';
import { readTurn, emptyPrefs } from '../extract.mjs';
import { buildConsensus } from '../consensus.mjs';
import { recommend } from '../recommend.mjs';
import { todayStr, addDays, formatDate, formatTime } from '../timeutil.mjs';
import { record, transcript, forget } from '../chatlog.mjs';
import { ask, formatAnswer } from '../assistant.mjs';
import { formatUsage } from '../budget.mjs';
import { MODEL } from '../llm.mjs';
import { book, billSplitFor } from '../booking.mjs';

const PUBLIC_URL = (process.env.HUDDLE_PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
const WAKE_WORD = (process.env.HUDDLE_WAKE_WORD || 'huddle').toLowerCase();
const SILENT = { silent: true };

const HELP = [
  'I’m an assistant in this chat. Two things I do:',
  '',
  'ASK ME ANYTHING',
  `  @me, reply to me, or start with "${WAKE_WORD}," and I’ll answer.`,
  '  I search the web for anything current — stats, scores, prices, news —',
  '  so I’m useful for settling arguments.',
  `  e.g. "${WAKE_WORD}, career goals for messi vs ronaldo?"`,
  '  /ask <question>          same thing, explicitly',
  '',
  'PLAN SOMETHING',
  '  /plan <what> in <city>   start planning here',
  '     e.g. /plan Maya’s birthday dinner in Portland, OR',
  '  /status                  who has answered so far',
  '  /go                      get 3 finalized options',
  '  /cancel                  drop the current plan',
  '',
  '/usage                     what I have cost today',
  '',
  'While a plan is running I read the chat for constraints (when you’re free,',
  'budget, dietary, accessibility) and react ✅ — no replies. Otherwise I stay',
  'quiet unless spoken to.',
].join('\n');

/** Strip a leading wake word so the question reads naturally. */
function stripWake(text) {
  const re = new RegExp(`^\\s*(?:hey\\s+|ok\\s+|yo\\s+)?${WAKE_WORD}\\b[\\s,:!?-]*`, 'i');
  return text.replace(re, '').trim();
}

function wasAddressed(evt, text) {
  if (evt.mentioned || evt.repliedToBot) return true;
  const re = new RegExp(`^\\s*(?:hey\\s+|ok\\s+|yo\\s+)?${WAKE_WORD}\\b`, 'i');
  return re.test(text);
}

// ---------------------------------------------------------------- helpers

/** "Maya's birthday dinner in Portland, OR" -> {title, city} */
function parsePlan(argstring) {
  const raw = argstring.trim();
  if (!raw) return null;
  const at = raw.toLowerCase().lastIndexOf(' in ');
  if (at === -1) return null;
  const title = raw.slice(0, at).trim();
  const city = raw.slice(at + 4).trim();
  if (!title || !city) return null;
  return { title, city };
}

/** Map a platform account to a participant, creating one on first sight. */
function ensureParticipant(huddle, { platform, userId, userName }) {
  let participant = huddle.participants.find(
    (p) => p.external?.platform === platform && String(p.external?.userId) === String(userId)
  );
  if (!participant) {
    participant = {
      id: `p_${Math.random().toString(36).slice(2, 8)}`,
      name: (userName || 'Someone').slice(0, 40),
      external: { platform, userId: String(userId) },
      prefs: emptyPrefs(),
      transcript: [],
      done: false,
      joinedAt: new Date().toISOString(),
    };
    huddle.participants.push(participant);
  } else if (userName && participant.name !== userName) {
    participant.name = userName.slice(0, 40); // display names change
  }
  return participant;
}

function statusText(huddle) {
  const consensus = buildConsensus(huddle);
  if (!huddle.participants.length) {
    return `No one has chimed in yet for "${huddle.title}". Just say when you’re free and what you’d spend.`;
  }

  const lines = huddle.participants.map((p) => {
    const mark = p.done ? '✅' : p.prefs.availability.length || p.prefs.budgetMaxPerPerson !== null ? '◐' : '○';
    return `${mark} ${p.name}`;
  });

  const facts = [];
  const best = consensus.slots[0];
  if (best) {
    facts.push(
      `Best window so far: ${formatDate(best.date)} ${formatTime(best.earliest)}–${formatTime(
        best.latest
      )} (${best.attending.length} free)`
    );
  }
  if (consensus.budgetCeiling !== null) facts.push(`Budget ceiling: $${consensus.budgetCeiling}/person`);
  if (consensus.dietary.length) facts.push(`Dietary: ${consensus.dietary.join(', ')}`);
  if (consensus.accessibility.length) facts.push(`Access: ${consensus.accessibility.join(', ')}`);
  if (consensus.avoid.length) facts.push(`Avoiding: ${consensus.avoid.join(', ')}`);

  return [
    `${huddle.title} — ${huddle.city}`,
    '',
    ...lines,
    ...(facts.length ? ['', ...facts] : []),
    '',
    'Run /go when enough people have answered.',
  ].join('\n');
}

function optionsText(huddle) {
  const parts = [`${huddle.title} — three ways this works:`];

  huddle.options.forEach((opt, i) => {
    const price = opt.estimatePerPerson === 0 ? 'Free' : `~$${opt.estimatePerPerson}/person`;
    const booking = opt.links.find((l) => l.kind === 'booking') || opt.links[0];
    const calendar = opt.links.find((l) => l.kind === 'calendar');

    parts.push(
      [
        '',
        `${i + 1}. ${opt.venue.name} — ${opt.headline}`,
        `   ${opt.slot.label} · ${price}`,
        `   ${opt.why}`,
        opt.accommodates.some((a) => a.source === 'computed')
          ? `   ✓ ${opt.accommodates.filter((a) => a.source === 'computed').map((a) => a.text).join(' · ')}`
          : null,
        opt.accommodates.some((a) => a.source === 'listing')
          ? `   listed: ${opt.accommodates.filter((a) => a.source === 'listing').map((a) => a.text).join(' · ')}`
          : null,
        `   Book: ${booking.url}`,
        calendar ? `   Calendar: ${calendar.url}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    );
  });

  const caveat = huddle.options.find((o) => o.confirmNote)?.confirmNote;
  if (caveat) parts.push('', `⚠ ${caveat}`);
  if (huddle.shortfall) parts.push('', huddle.shortfall);
  if (huddle.tradeoff) parts.push('', huddle.tradeoff);
  parts.push('', `Vote with 1 / 2 / 3, or open the full view: ${PUBLIC_URL}/h/${huddle.id}`);
  return parts.join('\n');
}

function voteButtons(huddle) {
  return huddle.options.map((opt, i) => ({
    id: `vote:${huddle.id}:${opt.id}`,
    label: `${i + 1}. ${opt.venue.name}`.slice(0, 40),
  }));
}

function tallyText(huddle) {
  const lines = huddle.options.map((opt, i) => {
    const voters = (huddle.votes[opt.id] || [])
      .map((pid) => huddle.participants.find((p) => p.id === pid)?.name)
      .filter(Boolean);
    return `${i + 1}. ${opt.venue.name} — ${voters.length ? voters.join(', ') : 'no votes'}`;
  });

  const counts = huddle.options.map((o) => (huddle.votes[o.id] || []).length);
  const top = Math.max(...counts, 0);
  const leaders = huddle.options.filter((o, i) => counts[i] === top && top > 0);
  const verdict =
    leaders.length === 1 ? `\n\nLeading: ${leaders[0].venue.name}.` : top > 0 ? '\n\nStill tied.' : '';

  return `Votes so far:\n${lines.join('\n')}${verdict}`;
}

// ------------------------------------------------ interactive cards
//
// A card is the LAST irreducible human choice the math can't resolve —
// "Friday or Saturday?" when both satisfy every constraint. It is NOT for
// re-litigating the venue (that's what the ranked options are for). One active
// card per huddle. A click is just another normalized inbound event routed
// back here; adapters render `card`/`buttons` natively and degrade to numbered
// text. Card state is cleared on a new constraint, like options and votes.

function makeCard({ type, question, reason, choices }) {
  return {
    id: `card_${Math.random().toString(36).slice(2, 8)}`,
    type, // 'poll' | 'rsvp' | 'option_vote'
    question,
    reason: reason || null, // names why the math can't decide — honesty, not prose
    choices: choices.map((label, i) =>
      typeof label === 'string' ? { id: `c${i + 1}`, label: label.slice(0, 80) } : label
    ),
    responses: {}, // choiceId -> [participantId], same shape as huddle.votes
    createdAt: new Date().toISOString(),
    stale: false,
  };
}

/** Choices as buttons; the id round-trips through the adapter's callback data. */
function cardButtons(huddle) {
  const c = huddle.card;
  return c.choices.map((ch) => ({
    id: `card:${huddle.id}:${c.id}:${ch.id}`, // fits Telegram's 64-byte cap
    label: ch.label.slice(0, 40),
  }));
}

/** The degrade path: the card as numbered text with a live tally. */
function cardText(huddle) {
  const c = huddle.card;
  const lines = [c.question];
  if (c.reason) lines.push(`(${c.reason})`);
  lines.push('');
  c.choices.forEach((ch, i) => {
    const voters = (c.responses[ch.id] || [])
      .map((pid) => huddle.participants.find((p) => p.id === pid)?.name)
      .filter(Boolean);
    lines.push(`${i + 1}. ${ch.label}${voters.length ? ` — ${voters.join(', ')}` : ''}`);
  });
  lines.push('', 'Tap a button, or reply with the number.');
  return lines.join('\n');
}

/** One action carrying all three renderings: rich `card`, `buttons`, and text. */
function cardAction(huddle) {
  return { text: cardText(huddle), buttons: cardButtons(huddle), card: huddle.card };
}

// ------------------------------------------------ booking render helpers

/** Pick which option a /book or /split refers to: explicit n, else the locked
 *  one, else the current vote leader, else the top-ranked option. */
function pickOption(huddle, rest) {
  const n = rest.trim().match(/^([123])$/);
  if (n) return huddle.options[Number(n[1]) - 1] || null;
  if (huddle.lockedOptionId) {
    const locked = huddle.options.find((o) => o.id === huddle.lockedOptionId);
    if (locked) return locked;
  }
  const counts = huddle.options.map((o) => (huddle.votes[o.id] || []).length);
  const top = Math.max(...counts, 0);
  if (top > 0) return huddle.options[counts.indexOf(top)];
  return huddle.options[0] || null;
}

function reservationText(huddle) {
  const r = huddle.reservation;
  const confirmed = r.status === 'confirmed'; // only when a real hold returned a ref
  const lines = confirmed
    ? [`✓ Held: ${r.venueName} — party of ${r.partySize}, ${r.date} ${r.time}. Confirmation ${r.ref}.`]
    : [
        `Reservation link for ${r.venueName} — party of ${r.partySize}, ${r.date} ${r.time}:`,
        `   ${r.url}`,
        `   (I haven't confirmed this booking — tap through to finish it.)`,
      ];
  const option = huddle.options.find((o) => o.id === r.optionId);
  const calendar = option?.links.find((l) => l.kind === 'calendar');
  if (calendar) lines.push(`   Calendar: ${calendar.url}`);
  return lines.join('\n');
}

function splitText(huddle) {
  const s = huddle.billSplit;
  // Green "we did the math" style: the leading ✓ marks a computed claim, the
  // same convention optionsText uses for computed accommodations.
  const lines = [
    `✓ $${s.perPerson}/person — party of ${s.count}, ~$${s.total} total. (Our arithmetic.)`,
  ];
  for (const l of s.requestLinks) lines.push(`   ${l.label}: ${l.url}`);
  if (!s.requestLinks.length) lines.push(`   (No request link — set HUDDLE_SPLIT_PROVIDER to venmo.)`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- commands

async function cmdPoll(evt, rest) {
  const huddle = findHuddleByChat(evt.platform, evt.chatId);
  if (!huddle) return { text: 'Start a plan first with /plan <what> in <city>.' };
  // "/poll Which day? | Friday | Saturday"
  const parts = rest.split('|').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 3) {
    return { text: 'Usage: /poll Question? | Choice A | Choice B [| Choice C]' };
  }
  const [question, ...choices] = parts;
  huddle.card = makeCard({ type: 'poll', question, choices: choices.slice(0, 5) });
  saveHuddle(huddle);
  return cardAction(huddle);
}

async function cmdBook(evt, rest) {
  const huddle = findHuddleByChat(evt.platform, evt.chatId);
  if (!huddle) return { text: 'Nothing being planned here.' };
  if (!huddle.options.length) return { text: 'No options yet — run /go first.' };
  const option = pickOption(huddle, rest);
  if (!option) return { text: 'Which one? Try /book 1' };

  const consensus = buildConsensus(huddle);
  huddle.reservation = await book(option, {
    partySize: consensus.partySize,
    date: option.slot.date,
    time: option.slot.start,
  });
  huddle.lockedOptionId = option.id;
  saveHuddle(huddle);
  return { text: reservationText(huddle) };
}

async function cmdSplit(evt, rest) {
  const huddle = findHuddleByChat(evt.platform, evt.chatId);
  if (!huddle) return { text: 'Nothing being planned here.' };
  if (!huddle.options.length) return { text: 'No options yet — run /go first.' };
  const option = pickOption(huddle, rest);
  if (!option) return { text: 'Which one? Try /split 1' };

  const consensus = buildConsensus(huddle);
  huddle.billSplit = billSplitFor(option, consensus.partySize);
  saveHuddle(huddle);
  return { text: splitText(huddle) };
}

async function cmdPlan(evt, argstring) {
  const existing = findHuddleByChat(evt.platform, evt.chatId);
  if (existing) {
    return {
      text: `Already planning "${existing.title}" in this chat. Run /go for options, or /cancel to start over.`,
    };
  }

  const parsed = parsePlan(argstring);
  if (!parsed) {
    return {
      text: 'I need a city so the booking links go somewhere real.\n\nTry: /plan Maya’s birthday dinner in Portland, OR',
    };
  }

  const start = todayStr();
  const huddle = createHuddle({
    title: parsed.title.slice(0, 120),
    city: parsed.city.slice(0, 80),
    groupType: 'mixed',
    partySize: 4, // refined as people join
    window: { start, end: addDays(start, 13) },
    organizerName: evt.userName || 'Organizer',
    tradeoff: '',
    blocked: null,
    shortfall: null,
    binding: {
      platform: evt.platform,
      chatId: String(evt.chatId),
      chatTitle: evt.chatTitle || null,
      closed: false,
    },
  });

  return {
    text: [
      `Planning "${huddle.title}" in ${huddle.city}. 📍`,
      '',
      'Everyone: just say when you’re free, roughly what you’d spend, and anything',
      'the group has to work around (dietary, accessibility, things you won’t do).',
      'One message each is usually enough — I’ll react ✅ when I’ve got you.',
      '',
      'Someone run /go when you’re ready for three options.',
    ].join('\n'),
  };
}

async function cmdStatus(evt) {
  const huddle = findHuddleByChat(evt.platform, evt.chatId);
  if (!huddle) return { text: 'Nothing being planned here yet. Start with /plan <what> in <city>.' };
  if (huddle.options.length) return { text: `${statusText(huddle)}\n\n${tallyText(huddle)}` };
  return { text: statusText(huddle) };
}

async function cmdGo(evt) {
  const huddle = findHuddleByChat(evt.platform, evt.chatId);
  if (!huddle) return { text: 'Nothing being planned here yet. Start with /plan <what> in <city>.' };

  const consensus = buildConsensus(huddle);
  if (consensus.respondedCount === 0) {
    return { text: 'Nobody has told me anything yet — say when you’re free and what you’d spend first.' };
  }

  // Party size is better inferred from who actually turned up than from a guess.
  huddle.partySize = Math.max(2, huddle.participants.length);

  const { options, tradeoff, blocked, shortfall } = await recommend({ huddle, consensus });
  huddle.options = options;
  huddle.tradeoff = tradeoff;
  huddle.blocked = blocked;
  huddle.shortfall = shortfall;
  huddle.votes = {};
  huddle.lockedOptionId = null;
  saveHuddle(huddle);

  if (blocked) return { text: blocked };
  return { text: optionsText(huddle), buttons: voteButtons(huddle) };
}

async function cmdCancel(evt) {
  const huddle = findHuddleByChat(evt.platform, evt.chatId);
  if (!huddle) return { text: 'Nothing to cancel here.' };
  huddle.binding.closed = true;
  saveHuddle(huddle);
  return { text: `Dropped "${huddle.title}". Start a new one with /plan <what> in <city>.` };
}

// ---------------------------------------------------------------- entry

/** A tap on a vote button (Telegram/Discord). */
export function handleVote({ platform, chatId, userId, userName, optionId }) {
  const huddle = findHuddleByChat(platform, chatId);
  if (!huddle || !huddle.options.some((o) => o.id === optionId)) {
    return { text: 'That plan is no longer on the table.' };
  }

  const participant = ensureParticipant(huddle, { platform, userId, userName });
  for (const voters of Object.values(huddle.votes)) {
    const at = voters.indexOf(participant.id);
    if (at !== -1) voters.splice(at, 1);
  }
  (huddle.votes[optionId] ||= []).push(participant.id);
  saveHuddle(huddle);

  return { text: tallyText(huddle) };
}

/** A tap on an interactive-card choice (Telegram/Discord), or a numbered reply
 *  on a platform without buttons. Mutates card state, re-renders. */
export function handleCardResponse({ platform, chatId, userId, userName, cardId, choiceId }) {
  const huddle = findHuddleByChat(platform, chatId);
  if (!huddle || !huddle.card || huddle.card.id !== cardId) {
    return { text: 'That poll is no longer open.' };
  }
  const card = huddle.card;
  if (!card.choices.some((ch) => ch.id === choiceId)) return { text: 'That choice is gone.' };

  const participant = ensureParticipant(huddle, { platform, userId, userName });
  // One response each: clear any prior pick, then set the new one.
  for (const arr of Object.values(card.responses)) {
    const at = arr.indexOf(participant.id);
    if (at !== -1) arr.splice(at, 1);
  }
  (card.responses[choiceId] ||= []).push(participant.id);
  saveHuddle(huddle);
  return cardAction(huddle);
}

/**
 * Answer a question addressed to the bot.
 *
 * `context` is captured by the caller BEFORE the question is recorded, so the
 * model sees the argument that prompted it without the question appearing
 * twice.
 */
async function respond(evt, question, context) {
  if (!question) {
    return { text: `I'm here. Ask me something, or /help for what I can do.` };
  }
  await evt.typing?.();
  const answer = await ask({
    question,
    context,
    platform: evt.platform,
    chatId: evt.chatId, // scopes both the answer cache and the daily cap
  });
  return { text: formatAnswer(answer) };
}

export async function handleEvent(evt) {
  const text = (evt.text || '').trim();
  if (!text) return SILENT;

  // Snapshot the conversation before adding this message, so a question the
  // bot is about to answer isn't also sitting in its own context.
  const priorContext = () => transcript(evt.platform, evt.chatId);
  const remember = () => record(evt.platform, evt.chatId, { name: evt.userName, text });

  // ---- commands ----
  const command = text.match(/^\/(\w+)(?:@\S+)?\s*([\s\S]*)$/);
  if (command) {
    const [, name, rest] = command;
    switch (name.toLowerCase()) {
      case 'ask': {
        const context = priorContext();
        remember();
        return respond(evt, rest.trim(), context);
      }
      case 'plan':
        return cmdPlan(evt, rest);
      case 'status':
        return cmdStatus(evt);
      case 'go':
      case 'plans':
        return cmdGo(evt);
      case 'cancel':
      case 'stop':
        return cmdCancel(evt);
      case 'poll':
        return cmdPoll(evt, rest);
      case 'book':
        return cmdBook(evt, rest);
      case 'split':
        return cmdSplit(evt, rest);
      case 'usage':
      case 'cost':
        return { text: formatUsage(MODEL) };
      case 'forget':
        forget(evt.platform, evt.chatId);
        return { text: 'Forgotten — I’ve dropped the recent chat context I was holding.' };
      case 'help':
      case 'start':
        return { text: HELP };
      default:
        return SILENT; // another bot's command — not ours to answer
    }
  }

  // ---- spoken to directly: answer anything ----
  if (wasAddressed(evt, text)) {
    const context = priorContext();
    remember();
    return respond(evt, stripWake(text), context);
  }

  // Ambient chatter is remembered for context but never answered.
  remember();

  const huddle = findHuddleByChat(evt.platform, evt.chatId);
  if (!huddle) return SILENT; // no active plan: stay completely quiet

  // ---- interactive-card response by plain text (iMessage / no-button degrade)
  // A card is the most recent human choice, so it takes precedence over an
  // option vote when both are somehow live.
  if (huddle.card) {
    const pick = text.match(/^([1-9])$/);
    if (pick) {
      const choice = huddle.card.choices[Number(pick[1]) - 1];
      if (choice) {
        return handleCardResponse({
          platform: evt.platform,
          chatId: evt.chatId,
          userId: evt.userId,
          userName: evt.userName,
          cardId: huddle.card.id,
          choiceId: choice.id,
        });
      }
    }
  }

  // ---- voting by plain text, for platforms without buttons ----
  if (huddle.options.length) {
    const vote = text.match(/^(?:vote\s*)?([123])$/i);
    if (vote) {
      const option = huddle.options[Number(vote[1]) - 1];
      if (option) {
        return handleVote({
          platform: evt.platform,
          chatId: evt.chatId,
          userId: evt.userId,
          userName: evt.userName,
          optionId: option.id,
        });
      }
    }
  }

  // ---- ordinary chatter: extract preferences, silently ----
  const participant = ensureParticipant(huddle, evt);

  // Only hard constraints count as "I got you". Vibes are soft and noisy —
  // in a chat app the word "chat" alone reads as a preference — and a bot that
  // ✅s ordinary banter looks like it has misunderstood the conversation.
  const HARD = ['availability', 'budgetMaxPerPerson', 'dietary', 'accessibility', 'avoid'];
  const fingerprint = (prefs) => JSON.stringify(HARD.map((k) => prefs[k]));
  const before = fingerprint(participant.prefs);

  const turn = await readTurn({ huddle, participant, message: text.slice(0, 2000) });

  participant.transcript.push({ role: 'user', content: text });
  participant.transcript.push({ role: 'assistant', content: turn.reply });
  if (participant.transcript.length > 40) participant.transcript = participant.transcript.slice(-40);
  participant.prefs = turn.prefs;
  participant.done = turn.done;

  // iMessage gives us a phone number or email as the "name". If the person
  // says who they are, use that instead — "+15551234567 can't do stairs" is
  // a worse plan explanation than "Marta can't do stairs".
  if (turn.prefs.displayName && /^[+\d]|@/.test(participant.name)) {
    participant.name = turn.prefs.displayName.slice(0, 40);
  }

  const learned = fingerprint(participant.prefs) !== before;
  let reservationWentStale = false;
  if (learned) {
    // Someone's constraints changed, so any computed state is now stale. The
    // card (a human choice built ON those constraints) is cleared like options
    // and votes; the reservation is a real commitment, so it's flagged and
    // warned, never silently deleted.
    huddle.options = [];
    huddle.votes = {};
    huddle.lockedOptionId = null;
    huddle.card = null;
    if (huddle.reservation && !huddle.reservation.stale) {
      huddle.reservation.stale = true;
      reservationWentStale = true;
    }
  }
  saveHuddle(huddle);

  if (reservationWentStale) {
    return {
      text:
        `Heads up — a new constraint just landed after the ${huddle.reservation.venueName} booking. ` +
        `That reservation may no longer fit; re-run /go and /book if it matters.`,
    };
  }

  // Group etiquette: acknowledge with a reaction, never a message. A bot that
  // replies to every line is the thing this product exists to eliminate.
  return learned ? { react: '✅' } : SILENT;
}

export { HELP, optionsText, statusText, PUBLIC_URL, cardAction, reservationText, splitText };
