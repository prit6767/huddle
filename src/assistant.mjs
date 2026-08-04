// General-purpose group chat assistant.
//
// The planner answers one question well. This answers everything else — and
// the common case is settling an argument, which means it needs facts that are
// newer than any model's training data. So it runs Claude's server-side web
// search: Anthropic executes the searches, we just read the results.
import Anthropic from '@anthropic-ai/sdk';
import { getClient, llmAvailable, MODEL, traitsFor } from './llm.mjs';
import { claim, refund, cacheKey, cacheGet, cacheSet, recordUsage, recordCacheHit } from './budget.mjs';
import { tidyAnswer } from './tidy.mjs';

const EFFORT = process.env.HUDDLE_ASK_EFFORT || 'medium';
// Each search is billed on top of tokens, so this is the sharpest cost lever
// after model choice. Three is enough to settle most factual arguments.
const MAX_SEARCHES = Number(process.env.HUDDLE_MAX_SEARCHES || 3);

// The model for user-facing answers, separate from the extraction model. This
// is where answer quality lives, so it's worth spending more here than on the
// cheap structured-extraction calls — set HUDDLE_ANSWER_MODEL=claude-sonnet-5
// for noticeably sharper answers while /plan extraction stays on Haiku.
// Defaults to the global model, so behaviour is unchanged unless you set it.
const ANSWER_MODEL = process.env.HUDDLE_ANSWER_MODEL || MODEL;

// Model routing: most group-chat questions (math, definitions, a score) are
// handled well and cheaply by the base model; reasoning-heavy ones (compare,
// why, should-we, trade-offs) get a stronger model. This RAISES quality where
// it matters while keeping the average cost near the cheap model, since the
// hard path is the minority. Set HUDDLE_HARD_MODEL to the base model to disable.
const BASE_MODEL = ANSWER_MODEL;
const HARD_MODEL = process.env.HUDDLE_HARD_MODEL || 'claude-sonnet-5';
const HARD_RE =
  /\b(why|how come|compare|comparison|versus|vs\.?|explain|analy[sz]e|pros and cons|worth it|should (?:i|we|they)|which is better|who is better|whats better|difference between|trade[- ]?offs?|reasons?|justif)/i;

export function pickModel(question) {
  const q = String(question || '').trim();
  if (HARD_MODEL === BASE_MODEL) return BASE_MODEL;
  if (HARD_RE.test(q)) return HARD_MODEL;
  if (q.length > 180) return HARD_MODEL; // long / multi-part asks
  if ((q.match(/[.?!]/g) || []).length >= 3) return HARD_MODEL; // several clauses
  return BASE_MODEL;
}

// Search-tool version per model, with a remembered preference so a rejected
// version isn't re-tried on every call. Starts from what the model supports,
// then steps down if the deployed API disagrees.
function searchVersionsFor(model) {
  return [traitsFor(model).searchTool, 'web_search_20250305', null].filter((v, i, a) => a.indexOf(v) === i);
}
const searchPref = new Map(); // model -> last version that worked

// Hedging that means the answer didn't really settle it — worth a stronger retry.
const LOW_CONFIDENCE =
  /\b(i'?m not sure|i am not sure|i do ?n'?t know|not (?:sure|certain)|unable to (?:find|confirm|determine)|could ?n'?t (?:find|confirm)|ca ?n'?t (?:find|confirm)|no (?:reliable |clear )?(?:info|information|data)|hard to say)\b/i;

/** messages.create, resuming a search turn that stops early with pause_turn. */
async function createWithResume(anthropic, req) {
  let response = await anthropic.messages.create(req);
  let messages = [{ role: 'user', content: req.messages[0].content }];
  let guard = 0;
  while (response.stop_reason === 'pause_turn' && guard++ < 4) {
    messages = [...messages, { role: 'assistant', content: response.content }];
    response = await anthropic.messages.create({ ...req, messages });
  }
  return response;
}

const SYSTEM = `You are a helpful assistant that lives inside a group chat. Several people are talking to each other; you are one participant among them, not a search engine and not a customer service bot.

How to behave here:

- Be SHORT. This is a chat message, not an essay. Two or three sentences is usually right. Never use headers. Use a compact list only when comparing specific numbers, and keep it to a few lines.
- Answer the question that was actually asked. If the group is arguing, give them what settles it.
- Separate fact from opinion, briefly. If a question has an objective part and a subjective part — "who has more goals" vs "who is better" — give the numbers plainly, then say in a clause that the rest is preference. Do not lecture them about it, and do not refuse to have a view if asked directly.
- Search the web whenever the answer depends on anything current: statistics, prices, scores, standings, recent events, who currently holds a position, what a thing costs today. Your training data is stale for all of it. Do not answer sports or news questions from memory. Just search and answer — never say "I'd need to search" or narrate that you're about to look something up.
- Cite numbers with enough specificity to be checkable — "as of the 2025-26 season" beats "currently".
- NEVER ask a clarifying question, and never end your message with a question back to the group. This is a group chat — nobody answers a bot's follow-up, and a question in place of an answer is a dead end. This rule is absolute.
- If a question is ambiguous, ANSWER IT ANYWAY. Pick the most likely reading and answer that, or cover the two most likely readings in one short message — e.g. "LA is ~3.9M in the city proper, ~13M in the metro area." Give the numbers. Do not then ask which one they meant; you've already answered both.
- If you genuinely do not know and cannot find out, say so in one line — a statement, not a question.
- No preamble. Do not open with "Great question" or restate what was asked. Lead with the answer.
- Match the register of the room. These are friends talking, not a business meeting.`;

function buildRequest(question, context, version, model = ANSWER_MODEL) {
  const userContent = context
    ? `Recent messages in this group chat:\n\n${context}\n\n---\n\nSomeone is now asking you directly:\n${question}`
    : question;

  return {
    model,
    max_tokens: 1200, // a chat reply; the prompt already demands brevity
    // The system prompt is identical on every question, and context is resent
    // each time — so mark the static prefix cacheable. On this workload (many
    // short questions sharing one prompt) cached input tokens bill at a
    // fraction of the normal rate, and the parameter is a no-op where
    // unsupported rather than an error.
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    // Haiku-tier models reject output_config.effort outright.
    ...(traitsFor(model).supportsEffort ? { output_config: { effort: EFFORT } } : {}),
    messages: [{ role: 'user', content: userContent }],
    ...(version
      ? { tools: [{ type: version, name: 'web_search', max_uses: model === HARD_MODEL ? Math.max(MAX_SEARCHES, 5) : MAX_SEARCHES }] }
      : {}),
  };
}

/** Pull the answer text and any sources out of a response with server-tool blocks. */
function readResponse(response) {
  // With web search, Claude often writes a preamble ("let me look that up",
  // "I don't have real-time data"), THEN searches, THEN writes the real answer.
  // Joining every text block glues the preamble onto the answer, so it reads as
  // answering twice. The answer is the text after the last tool activity — take
  // only that. With no search, there's a single block and this returns all of it.
  let lastTool = -1;
  response.content.forEach((b, i) => {
    if (b.type === 'server_tool_use' || b.type === 'web_search_tool_result') lastTool = i;
  });
  const textFrom = (blocks) =>
    blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  const text = tidyAnswer(textFrom(response.content.slice(lastTool + 1)) || textFrom(response.content));

  const sources = [];
  for (const block of response.content) {
    if (block.type !== 'web_search_tool_result') continue;
    // On an error, `content` is a single error object rather than a list.
    if (!Array.isArray(block.content)) continue;
    for (const result of block.content) {
      if (result.url && !sources.some((s) => s.url === result.url)) {
        sources.push({ url: result.url, title: result.title || result.url });
      }
    }
  }
  return { text, sources };
}

/**
 * Answer a question addressed to the bot.
 * Returns { text, sources } — or an explanatory message if unavailable.
 */
export async function ask({ question, context, platform = 'unknown', chatId = 'unknown' }) {
  // Cache first — a re-ask or a double-tap shouldn't cost anything.
  const key = cacheKey(platform, chatId, question);
  const cached = cacheGet(key);
  if (cached) {
    recordCacheHit();
    return cached;
  }

  if (!llmAvailable()) {
    return {
      text:
        "I can't answer general questions without an API key — only the /plan features work right now. " +
        'Set ANTHROPIC_API_KEY and restart the bots.',
      sources: [],
    };
  }

  const anthropic = getClient();
  if (!anthropic) return { text: 'My connection to Claude is not configured.', sources: [] };

  // Claim budget only once we know we're actually going to spend.
  const allowance = claim(platform, chatId);
  if (!allowance.allowed) return { text: allowance.reason, sources: [] };

  // Route to the right model for this question's difficulty.
  const model = pickModel(question);
  const versions = searchVersionsFor(model);
  const startAt = Math.max(0, versions.indexOf(searchPref.get(model) ?? versions[0]));

  for (let i = startAt; i < versions.length; i++) {
    const version = versions[i];
    try {
      const response = await createWithResume(anthropic, buildRequest(question, context, version, model));

      if (searchPref.get(model) !== version) {
        searchPref.set(model, version);
      }

      if (response.stop_reason === 'refusal') {
        refund(platform, chatId);
        return { text: "I can't help with that one.", sources: [] };
      }

      const base = readResponse(response);
      recordUsage({ model, usage: response.usage, searches: base.sources.length ? 1 : 0 });

      // Escalate a weak or empty base-model answer once to the stronger model —
      // exactly the answers most likely to be wrong get a second, better shot.
      let best = { ...base, usage: response.usage, model };
      if (model === BASE_MODEL && HARD_MODEL !== BASE_MODEL && (!base.text || LOW_CONFIDENCE.test(base.text))) {
        try {
          const hv = searchVersionsFor(HARD_MODEL)[0];
          const r2 = await createWithResume(anthropic, buildRequest(question, context, hv, HARD_MODEL));
          if (r2.stop_reason !== 'refusal') {
            const up = readResponse(r2);
            recordUsage({ model: HARD_MODEL, usage: r2.usage, searches: up.sources.length ? 1 : 0 });
            if (up.text) best = { ...up, usage: r2.usage, model: HARD_MODEL };
          }
        } catch (e) {
          console.warn('[assistant] escalation failed:', e.message); // keep the base answer
        }
      }

      if (!best.text) {
        refund(platform, chatId);
        return { text: 'I came up empty on that — try rephrasing?', sources: [] };
      }

      const answer = {
        text: best.text,
        sources: best.sources,
        usage: { input_tokens: best.usage?.input_tokens || 0, output_tokens: best.usage?.output_tokens || 0 },
        model: best.model,
        searches: best.sources.length ? 1 : 0,
      };
      cacheSet(key, answer);
      return answer;
    } catch (err) {
      // A 400 here usually means this API vintage doesn't know that tool
      // version. Step down; the last entry drops search entirely.
      if (err instanceof Anthropic.BadRequestError && i < versions.length - 1) {
        console.warn(`[assistant] "${version}" rejected (${err.message}) — trying next`);
        continue;
      }
      refund(platform, chatId);
      if (err instanceof Anthropic.RateLimitError) {
        return { text: "I'm being rate limited — give it a minute.", sources: [] };
      }
      if (err instanceof Anthropic.APIError) {
        console.warn(`[assistant] API error ${err.status}: ${err.message}`);
        return { text: `Something went wrong reaching Claude (${err.status}).`, sources: [] };
      }
      console.error('[assistant] failed:', err.message);
      return { text: 'Something went wrong on my end.', sources: [] };
    }
  }
  return { text: 'Something went wrong on my end.', sources: [] };
}

const SUMMARY_SYSTEM = `You are catching someone up on a group chat they missed. Read the recent messages and give a tight recap.

- Open with a one-line gist of what the conversation is about.
- Then up to 5 short bullets: what was discussed, any decisions made, and anything still open or unresolved.
- Only include what is actually in the messages. Never invent, speculate, or add outside facts. Do not search the web.
- No preamble ("Here's a summary"), no headers, and never end with a question back to the group.`;

/**
 * Recap the recent conversation for someone catching up. Reuses the answer
 * model and the same daily budget, but never searches the web — a summary is
 * grounded only in the messages it's given.
 * Returns { text, sources: [] } so it formats/posts exactly like an answer.
 */
export async function summarize({ transcript, platform = 'unknown', chatId = 'unknown' }) {
  const lines = String(transcript || '').trim();
  if (lines.split('\n').filter(Boolean).length < 3) {
    return { text: "There's not much to catch up on yet — I've only seen a message or two here.", sources: [] };
  }
  if (!llmAvailable()) {
    return { text: "I need an API key to summarize — only the /plan features work without one.", sources: [] };
  }
  const anthropic = getClient();
  if (!anthropic) return { text: 'My connection to Claude is not configured.', sources: [] };

  const allowance = claim(platform, chatId);
  if (!allowance.allowed) return { text: allowance.reason, sources: [] };

  try {
    const response = await anthropic.messages.create({
      model: ANSWER_MODEL,
      max_tokens: 700,
      system: [{ type: 'text', text: SUMMARY_SYSTEM, cache_control: { type: 'ephemeral' } }],
      ...(traitsFor(ANSWER_MODEL).supportsEffort ? { output_config: { effort: EFFORT } } : {}),
      messages: [
        { role: 'user', content: `Recent messages in this group chat:\n\n${lines}\n\n---\n\nCatch me up on what I missed.` },
      ],
    });
    recordUsage({ model: ANSWER_MODEL, usage: response.usage, searches: 0 });
    const text = tidyAnswer(
      response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()
    );
    if (!text) {
      refund(platform, chatId);
      return { text: "I couldn't put a summary together — try again in a moment.", sources: [] };
    }
    return {
      text,
      sources: [],
      usage: { input_tokens: response.usage?.input_tokens || 0, output_tokens: response.usage?.output_tokens || 0 },
      model: ANSWER_MODEL,
      searches: 0,
    };
  } catch (err) {
    refund(platform, chatId);
    console.error('[assistant] summarize failed:', err.message);
    return { text: 'Something went wrong summarizing.', sources: [] };
  }
}

/** Format for posting into a chat: answer plus a trimmed source list. */
export function formatAnswer({ text, sources }) {
  if (!sources.length) return text;
  const top = sources.slice(0, 3).map((s) => `· ${s.url}`);
  return `${text}\n\n${top.join('\n')}`;
}
