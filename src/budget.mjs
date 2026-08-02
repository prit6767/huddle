// Cost control: answer cache, per-chat rate caps, and usage accounting.
//
// A group chat bot has an unusual cost profile — anyone can ask anything, as
// often as they like, and nobody sees the bill. These are the three levers
// that keep that from being a problem:
//
//   1. cache   — the same question asked twice in a few minutes is one call
//   2. caps    — one chat cannot spend unbounded money in a day
//   3. ledger  — you can actually see what it cost
//
// All in memory. A restart resets counters, which is the right trade for a
// self-hosted tool: no database, and the caps are a guardrail, not billing.

const PER_CHAT_DAILY = Number(process.env.HUDDLE_DAILY_QUESTIONS_PER_CHAT || 50);
const TOTAL_DAILY = Number(process.env.HUDDLE_DAILY_QUESTIONS_TOTAL || 500);
const CACHE_TTL_MS = Number(process.env.HUDDLE_CACHE_TTL_MS || 10 * 60 * 1000);
const CACHE_MAX = 300;

// Published rates, USD per million tokens. Used only to show an estimate —
// treat it as indicative, not as a bill.
const PRICES = {
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-fable-5': { in: 10, out: 50 },
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- caps

const counters = { day: today(), total: 0, perChat: new Map() };

function rollover() {
  const now = today();
  if (counters.day !== now) {
    counters.day = now;
    counters.total = 0;
    counters.perChat.clear();
  }
}

/**
 * Claim one question against the caps. Returns {allowed, reason} — call this
 * BEFORE spending money, and only once per question.
 */
export function claim(platform, chatId) {
  rollover();
  const key = `${platform}:${chatId}`;
  const used = counters.perChat.get(key) || 0;

  if (used >= PER_CHAT_DAILY) {
    return {
      allowed: false,
      reason: `This chat has hit its daily limit of ${PER_CHAT_DAILY} questions. Resets at midnight UTC.`,
    };
  }
  if (counters.total >= TOTAL_DAILY) {
    return {
      allowed: false,
      reason: `I've hit my global daily limit of ${TOTAL_DAILY} questions. Resets at midnight UTC.`,
    };
  }

  counters.perChat.set(key, used + 1);
  counters.total += 1;
  return { allowed: true, remaining: PER_CHAT_DAILY - used - 1 };
}

/** Give the claim back when a question was served from cache or failed. */
export function refund(platform, chatId) {
  const key = `${platform}:${chatId}`;
  const used = counters.perChat.get(key) || 0;
  if (used > 0) counters.perChat.set(key, used - 1);
  if (counters.total > 0) counters.total -= 1;
}

// ---------------------------------------------------------------- cache

const cache = new Map(); // key -> {value, at}

const normalize = (q) => q.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Scoped to the chat, with a short TTL. Same room, same question, same few
 * minutes — that's a re-ask or a spam tap, not a new query. The TTL is short
 * because most questions worth asking here are about live data.
 */
export function cacheKey(platform, chatId, question) {
  return `${platform}:${chatId}:${normalize(question)}`;
}

export function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

export function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { value, at: Date.now() });
}

// ---------------------------------------------------------------- ledger

const ledger = { day: today(), calls: 0, inputTokens: 0, outputTokens: 0, searches: 0, cacheHits: 0 };

export function recordUsage({ model, usage, searches = 0 }) {
  rollover();
  if (ledger.day !== counters.day) {
    Object.assign(ledger, {
      day: counters.day,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      searches: 0,
      cacheHits: 0,
    });
  }
  ledger.calls += 1;
  ledger.inputTokens += usage?.input_tokens || 0;
  ledger.outputTokens += usage?.output_tokens || 0;
  ledger.searches += searches;
  ledger.model = model;
}

export function recordCacheHit() {
  ledger.cacheHits += 1;
}

// Web search bills separately from tokens (~$10 / 1000 by default).
const SEARCH_PRICE = Number(process.env.HUDDLE_SEARCH_PRICE || 0.01);

/** Estimated USD for a bundle of token/search usage on a given model. */
export function estimateSpendUsd({ inputTokens = 0, outputTokens = 0, searches = 0, model }) {
  const m = model || process.env.HUDDLE_ANSWER_MODEL || process.env.HUDDLE_MODEL || ledger.model;
  const price = PRICES[m] || null;
  const tokenCost = price ? (inputTokens / 1e6) * price.in + (outputTokens / 1e6) * price.out : 0;
  return { usd: tokenCost + searches * SEARCH_PRICE, priced: Boolean(price), model: m };
}

export function usageReport(model) {
  const price = PRICES[model] || PRICES[ledger.model] || null;
  const dollars = price
    ? (ledger.inputTokens / 1e6) * price.in + (ledger.outputTokens / 1e6) * price.out
    : null;

  return {
    day: ledger.day,
    calls: ledger.calls,
    cacheHits: ledger.cacheHits,
    inputTokens: ledger.inputTokens,
    outputTokens: ledger.outputTokens,
    searches: ledger.searches,
    estimatedUSD: dollars,
    perChatLimit: PER_CHAT_DAILY,
    totalLimit: TOTAL_DAILY,
    totalUsed: counters.total,
  };
}

export function formatUsage(model) {
  const r = usageReport(model);
  const cost =
    r.calls === 0
      ? 'nothing yet today'
      : r.estimatedUSD === null
        ? 'unknown (no price on file for this model)'
        : r.estimatedUSD < 0.01
          ? 'under $0.01'
          : `about $${r.estimatedUSD.toFixed(2)}`;

  return [
    `Today (${r.day}), on ${model}:`,
    `  ${r.calls} model calls, ${r.cacheHits} served from cache`,
    `  ${r.inputTokens.toLocaleString()} in / ${r.outputTokens.toLocaleString()} out tokens`,
    `  ${r.searches} web searches (billed separately)`,
    `  Estimated model spend: ${cost}`,
    `  Questions used: ${r.totalUsed}/${r.totalLimit} today (${r.perChatLimit} per chat)`,
  ].join('\n');
}
