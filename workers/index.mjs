// Cloudflare Worker: Huddle's web app + huddle API, on D1.
//
// The whole browser-facing product runs here — the site, creating a huddle,
// joining, the chat that extracts preferences, finalising three options,
// voting, locking, and the link-preview cards. Storage is D1; every other
// module (consensus, recommend, extract, links, budget) is the same code the
// Node build runs.
//
// Not here: the Discord gateway and iMessage relay (long-lived connections,
// impossible on a request-scoped runtime) stay in `npm run bots`. Slack and
// Telegram webhooks are the next stage — see workers/README.md.
import venues from '../data/venues.json' with { type: 'json' };

import { store, installs, id } from './store-d1.mjs';
import { readTurn, emptyPrefs } from '../src/extract.mjs';
import { buildConsensus } from '../src/consensus.mjs';
import { recommend, setCatalog } from '../src/recommend.mjs';
import { shareLine } from '../src/links.mjs';
import { llmAvailable, MODEL } from '../src/llm.mjs';
import { todayStr, addDays, datesInWindow } from '../src/timeutil.mjs';
import { GROUP_TYPES } from '../src/vocab.mjs';
import { handleSlack, slackInstallUrl } from './slack.mjs';
import { handleGoogleChat } from './google-chat.mjs';
import { handleTelegram } from './telegram.mjs';
import { ask, formatAnswer } from '../src/assistant.mjs';
import { claimQuestion } from './chat-state.mjs';

setCatalog(venues.venues);

// --------------------------------------------------------------- responses
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
const fail = (status, message) => json({ error: message }, status);

const escapeAttr = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

/** Everything a client may see; a viewer's own prefs are unlocked only for them. */
function publicView(huddle, viewerId) {
  return {
    id: huddle.id,
    title: huddle.title,
    city: huddle.city,
    groupType: huddle.groupType,
    partySize: huddle.partySize,
    window: huddle.window,
    createdAt: huddle.createdAt,
    organizerName: huddle.organizerName,
    lockedOptionId: huddle.lockedOptionId,
    options: huddle.options,
    tradeoff: huddle.tradeoff || '',
    blocked: huddle.blocked || null,
    shortfall: huddle.shortfall || null,
    votes: huddle.votes,
    participants: huddle.participants.map((p) => ({
      id: p.id,
      name: p.name,
      done: Boolean(p.done),
      answered: Boolean(
        p.prefs && (p.prefs.availability.length || p.prefs.budgetMaxPerPerson !== null)
      ),
      prefs: p.id === viewerId ? p.prefs : undefined,
      transcript: p.id === viewerId ? p.transcript : undefined,
    })),
    consensus: buildConsensus(huddle),
    engine: llmAvailable() ? MODEL : 'heuristic',
  };
}

// --------------------------------------------------------------- OG / canonical
function withCanonical(html, path, publicUrl) {
  const url = `${publicUrl}${path}`;
  const tags =
    `<link rel="canonical" href="${escapeAttr(url)}" />` +
    (html.includes('og:url') ? '' : `\n    <meta property="og:url" content="${escapeAttr(url)}" />`);
  return html.replace('</head>', `  ${tags}\n  </head>`);
}

async function renderHuddlePage(html, huddle, publicUrl) {
  const answered = huddle.participants.filter((p) => p.done).length;
  const description = huddle.options.length
    ? `${huddle.options.length} options ready in ${huddle.city}. Tap to vote.`
    : huddle.participants.length
      ? `${huddle.city} · ${answered} of ${huddle.participants.length} answered. Tap to add yours.`
      : `${huddle.city} · tap to say when you're free and what you'd spend.`;
  const tags = [
    `<meta property="og:title" content="${escapeAttr(huddle.title)}" />`,
    `<meta property="og:description" content="${escapeAttr(description)}" />`,
    '<meta property="og:type" content="website" />',
    `<meta property="og:url" content="${escapeAttr(`${publicUrl}/h/${huddle.id}`)}" />`,
    `<meta property="og:image" content="${escapeAttr(`${publicUrl}/og.png`)}" />`,
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    '<meta name="twitter:card" content="summary_large_image" />',
  ].join('\n    ');
  return withCanonical(html.replace(/<!--OG-->[\s\S]*?<!--\/OG-->/, tags), `/h/${huddle.id}`, publicUrl);
}

// --------------------------------------------------------------- the app
export async function handle(request, env, ctx) {
  // Bridge bindings into process.env so the shared modules — which read
  // process.env for the API key, model and feature flags — work unchanged.
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') process.env[k] = v;
  }
  const PUBLIC_URL = (env.HUDDLE_PUBLIC_URL || 'http://localhost:8787').replace(/\/$/, '');
  const db = store(env.DB);
  const url = new URL(request.url);
  const path = url.pathname;

  // Slack owns these paths (configured in its app manifest, not by us).
  if (path.startsWith('/slack/')) {
    return handleSlack(request, env, ctx, PUBLIC_URL);
  }
  // Google Chat posts events here (configured in the Chat API console).
  if (path === '/google/events') {
    return handleGoogleChat(request, env);
  }
  // Telegram posts updates here (registered via setWebhook).
  if (path === '/telegram/webhook') {
    return handleTelegram(request, env, ctx);
  }
  const body = async () => {
    try {
      return await request.json();
    } catch {
      return {};
    }
  };

  // ---- homepage: inject rel=canonical / og:url on the real origin ----
  // The asset layer would serve index.html directly and skip this; wrangler's
  // run_worker_first:["/"] routes just the root through here so the canonical
  // tag is correct. Assets (css, js, og.png) still serve straight from edge.
  if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
    const asset = await env.ASSETS.fetch(new Request(new URL('/index.html', url)));
    const html = await asset.text();
    return new Response(withCanonical(html, '/', PUBLIC_URL), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  // ---- link-preview pages: /h/:id — served with per-huddle OG tags ----
  const share = path.match(/^\/h\/([\w-]+)\/?$/);
  if (request.method === 'GET' && share) {
    const asset = await env.ASSETS.fetch(new Request(new URL('/index.html', url)));
    const html = await asset.text();
    const huddle = await db.getHuddle(share[1]);
    const out = huddle
      ? await renderHuddlePage(html, huddle, PUBLIC_URL)
      : withCanonical(html, '/', PUBLIC_URL);
    return new Response(out, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  // ---- direct Q&A, for the web "Ask Huddle" page and the Meet side panel ----
  if (path === '/api/ask' && request.method === 'POST') {
    const b = await body();
    const question = String(b.question || '').trim().slice(0, 2000);
    if (!question) return fail(400, 'Ask a question.');
    // Bound cost: this endpoint is effectively public, so cap it per client IP
    // per day (on top of the model's own caps). A shared NAT hits the limit
    // sooner, which is the safe direction.
    const ip = request.headers.get('cf-connecting-ip') || 'anon';
    if (!(await claimQuestion(env.DB, `web:${ip}`, 40))) {
      return fail(429, 'Daily question limit reached for now — try again tomorrow.');
    }
    // Optional short client-supplied context (prior turns on the page).
    const context = String(b.context || '').slice(0, 4000);
    const answer = await ask({ question, context, platform: 'web', chatId: `web:${ip}` });
    return json({ text: answer.text, sources: answer.sources, formatted: formatAnswer(answer) });
  }

  // ---- API ----
  if (path === '/api/health' && request.method === 'GET') {
    const all = await db.listHuddles();
    return json({
      ok: true,
      engine: llmAvailable() ? MODEL : 'heuristic',
      huddles: all.length,
      groupTypes: GROUP_TYPES,
      defaultWindow: { start: todayStr(), end: addDays(todayStr(), 13) },
      invites: {
        telegram: env.HUDDLE_TELEGRAM_INVITE || null,
        discord: env.HUDDLE_DISCORD_INVITE || null,
        slack: slackInstallUrl(env, PUBLIC_URL) || env.HUDDLE_SLACK_INVITE || null,
      },
    });
  }

  if (path === '/api/huddles' && request.method === 'POST') {
    const b = await body();
    const title = String(b.title || '').trim();
    const city = String(b.city || '').trim();
    if (!title) return fail(400, 'A title is required (e.g. "Maya\'s birthday dinner").');
    if (!city) return fail(400, 'A city is required so links point somewhere real.');
    const start = b.windowStart || todayStr();
    const end = b.windowEnd || addDays(start, 13);
    if (end < start) return fail(400, 'The window ends before it starts.');
    if (datesInWindow(start, end, 60).length > 45) return fail(400, 'Keep the date window under 45 days.');
    const huddle = await db.createHuddle({
      title: title.slice(0, 120),
      city: city.slice(0, 80),
      groupType: GROUP_TYPES.includes(b.groupType) ? b.groupType : 'mixed',
      partySize: Math.max(2, Math.min(30, Number(b.partySize) || 4)),
      window: { start, end },
      organizerName: String(b.organizerName || 'Organizer').trim().slice(0, 40),
      tradeoff: '',
      blocked: null,
      shortfall: null,
    });
    return json(publicView(huddle, null), 201);
  }

  const m = path.match(/^\/api\/huddles\/([\w-]+)(\/(join|chat|finalize|vote|lock))?$/);
  if (m) {
    const huddle = await db.getHuddle(m[1]);
    if (!huddle) return fail(404, 'No huddle with that link.');
    const action = m[3];

    if (!action && request.method === 'GET') {
      return json(publicView(huddle, url.searchParams.get('me')));
    }
    if (action === 'join' && request.method === 'POST') {
      const b = await body();
      const name = String(b.name || '').trim().slice(0, 40);
      if (!name) return fail(400, 'Tell us your name first.');
      if (huddle.participants.length >= 30) return fail(400, 'This huddle is full (30 people).');
      const existing = huddle.participants.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (existing) return json({ participantId: existing.id, huddle: publicView(huddle, existing.id) });
      const participant = {
        id: id('p', 4),
        name,
        prefs: emptyPrefs(),
        transcript: [],
        done: false,
        joinedAt: new Date().toISOString(),
      };
      huddle.participants.push(participant);
      await db.saveHuddle(huddle);
      return json({ participantId: participant.id, huddle: publicView(huddle, participant.id) }, 201);
    }
    if (action === 'chat' && request.method === 'POST') {
      const b = await body();
      const participant = huddle.participants.find((p) => p.id === b.participantId);
      if (!participant) return fail(404, 'Join the huddle before chatting.');
      const message = String(b.message || '').trim().slice(0, 2000);
      if (!message) return fail(400, 'Empty message.');
      const turn = await readTurn({ huddle, participant, message });
      participant.transcript.push({ role: 'user', content: message });
      participant.transcript.push({ role: 'assistant', content: turn.reply });
      if (participant.transcript.length > 40) participant.transcript = participant.transcript.slice(-40);
      participant.prefs = turn.prefs;
      participant.done = turn.done;
      if (turn.prefs.displayName && participant.name === 'Guest') {
        participant.name = turn.prefs.displayName.slice(0, 40);
      }
      huddle.options = [];
      huddle.lockedOptionId = null;
      huddle.votes = {};
      await db.saveHuddle(huddle);
      return json({ reply: turn.reply, done: turn.done, prefs: participant.prefs, huddle: publicView(huddle, participant.id) });
    }
    if (action === 'finalize' && request.method === 'POST') {
      const { participantId } = await body();
      const consensus = buildConsensus(huddle);
      if (consensus.respondedCount === 0) return fail(400, 'Nobody has answered yet — share the link first.');
      const { options, tradeoff, blocked, shortfall } = await recommend({ huddle, consensus });
      Object.assign(huddle, { options, tradeoff, blocked, shortfall, votes: {}, lockedOptionId: null });
      await db.saveHuddle(huddle);
      return json(publicView(huddle, participantId || null));
    }
    if (action === 'vote' && request.method === 'POST') {
      const b = await body();
      const participant = huddle.participants.find((p) => p.id === b.participantId);
      if (!participant) return fail(404, 'Join the huddle before voting.');
      if (!huddle.options.some((o) => o.id === b.optionId)) return fail(400, 'That option is no longer on the table.');
      for (const voters of Object.values(huddle.votes)) {
        const at = voters.indexOf(participant.id);
        if (at !== -1) voters.splice(at, 1);
      }
      (huddle.votes[b.optionId] ||= []).push(participant.id);
      await db.saveHuddle(huddle);
      return json(publicView(huddle, participant.id));
    }
    if (action === 'lock' && request.method === 'POST') {
      const b = await body();
      const option = huddle.options.find((o) => o.id === b.optionId);
      if (!option) return fail(400, 'That option is no longer on the table.');
      huddle.lockedOptionId = option.id;
      await db.saveHuddle(huddle);
      return json({
        huddle: publicView(huddle, b.participantId || null),
        shareLine: shareLine({ option, city: huddle.city, title: huddle.title }),
      });
    }
    return fail(405, 'Method not allowed');
  }

  // ---- everything else: static assets (site, css, js, og.png) ----
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      console.error('[worker]', err?.stack || err?.message || err);
      return fail(500, 'Something broke on our side.');
    }
  },
};
