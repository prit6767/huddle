import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHuddle, getHuddle, saveHuddle, listHuddles, id } from './store.mjs';
import { readTurn, emptyPrefs } from './extract.mjs';
import { buildConsensus } from './consensus.mjs';
import { recommend } from './recommend.mjs';
import { shareLine } from './links.mjs';
import { llmAvailable, MODEL } from './llm.mjs';
import { todayStr, addDays, datesInWindow } from './timeutil.mjs';
import { GROUP_TYPES } from './vocab.mjs';
import { slackRoutes, slackDistributionConfigured, installUrl } from './slack-http.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, '..', 'public');
const PORT = Number(process.env.PORT || 3000);
// The canonical origin this instance is reached at. Chat apps resolve relative
// URLs against whatever host served the page, so og:url and rel=canonical have
// to be absolute or a link pasted into WhatsApp unfurls against the wrong host.
const PUBLIC_URL = (process.env.HUDDLE_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function fail(res, status, message) {
  send(res, status, { error: message });
}

/** Errors the client caused, so the router can answer 4xx instead of 5xx. */
class ClientError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function readJson(req, limitBytes = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new ClientError('Request body too large', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ClientError('Request body is not valid JSON.');
  }
}

const escapeAttr = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

/**
 * Rewrite the Open Graph block for a specific huddle.
 *
 * This is how the product reaches chat apps with no bot API (WhatsApp,
 * iMessage): someone pastes the invite link and it unfurls into a card naming
 * the occasion and city, so the group knows what they're tapping.
 */
async function renderHuddlePage(huddleId) {
  const html = await readFile(join(PUBLIC_DIR, 'index.html'), 'utf8');
  const huddle = getHuddle(huddleId);
  if (!huddle) return withCanonical(html, '/');

  const answered = huddle.participants.filter((p) => p.done).length;
  const description = huddle.options.length
    ? `${huddle.options.length} options ready in ${huddle.city}. Tap to vote.`
    : huddle.participants.length
      ? `${huddle.city} · ${answered} of ${huddle.participants.length} answered. Tap to add yours.`
      : `${huddle.city} · tap to say when you’re free and what you’d spend.`;

  const tags = [
    `<meta property="og:title" content="${escapeAttr(huddle.title)}" />`,
    `<meta property="og:description" content="${escapeAttr(description)}" />`,
    '<meta property="og:type" content="website" />',
    `<meta property="og:url" content="${escapeAttr(`${PUBLIC_URL}/h/${huddle.id}`)}" />`,
    // This block replaces the whole OG section, so the card image has to be
    // restated here or a pasted huddle link unfurls without one.
    `<meta property="og:image" content="${escapeAttr(`${PUBLIC_URL}/og.png`)}" />`,
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    '<meta name="twitter:card" content="summary_large_image" />',
  ].join('\n    ');

  return withCanonical(html.replace(/<!--OG-->[\s\S]*?<!--\/OG-->/, tags), `/h/${huddle.id}`);
}

/**
 * Point rel=canonical (and og:url, where the page didn't already set one) at
 * this instance's real origin. Without it every deployment claims to be
 * localhost, which is wrong in previews and actively harmful once a real
 * domain is in front of the app.
 */
function withCanonical(html, path) {
  const url = `${PUBLIC_URL}${path}`;
  const tags =
    `<link rel="canonical" href="${escapeAttr(url)}" />` +
    (html.includes('og:url') ? '' : `\n    <meta property="og:url" content="${escapeAttr(url)}" />`);
  return html.replace('</head>', `  ${tags}\n  </head>`);
}

async function serveStatic(res, urlPath) {
  const shareLink = urlPath.match(/^\/h\/([\w-]+)\/?$/);
  if (shareLink) {
    const body = await renderHuddlePage(shareLink[1]);
    return send(res, 200, body, { 'content-type': MIME['.html'] });
  }

  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const full = join(PUBLIC_DIR, normalize(relative));
  if (!full.startsWith(PUBLIC_DIR)) return fail(res, 403, 'Forbidden');

  try {
    // HTML gets the canonical treatment; assets are served as-is.
    if (extname(full) === '.html' || urlPath === '/') {
      const html = await readFile(full, 'utf8');
      return send(res, 200, withCanonical(html, '/'), { 'content-type': MIME['.html'] });
    }
    const body = await readFile(full);
    send(res, 200, body, { 'content-type': MIME[extname(full)] || 'application/octet-stream' });
  } catch {
    // Unknown path: hand it to the client-side router.
    try {
      const html = await readFile(join(PUBLIC_DIR, 'index.html'), 'utf8');
      send(res, 200, withCanonical(html, '/'), { 'content-type': MIME['.html'] });
    } catch {
      fail(res, 404, 'Not found');
    }
  }
}

/** Everything a client is allowed to see, with per-participant chat kept private. */
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
      answered: Boolean(p.prefs && (p.prefs.availability.length || p.prefs.budgetMaxPerPerson !== null)),
      // Only the participant themselves gets their raw preferences back.
      prefs: p.id === viewerId ? p.prefs : undefined,
      transcript: p.id === viewerId ? p.transcript : undefined,
    })),
    consensus: buildConsensus(huddle),
    engine: llmAvailable() ? MODEL : 'heuristic',
  };
}

const routes = [
  {
    method: 'GET',
    match: /^\/api\/health$/,
    handler: async (_req, res) => {
      send(res, 200, {
        ok: true,
        engine: llmAvailable() ? MODEL : 'heuristic',
        huddles: listHuddles().length,
        groupTypes: GROUP_TYPES,
        defaultWindow: { start: todayStr(), end: addDays(todayStr(), 13) },
        // One bot instance serves unlimited groups — every lookup is keyed by
        // (platform, chatId). So whoever runs this can publish add-to-group
        // links and nobody else needs a terminal. Unset here means "no hosted
        // bot", and the page falls back to the self-host instructions rather
        // than offering a button that goes nowhere.
        invites: {
          telegram: process.env.HUDDLE_TELEGRAM_INVITE || null,
          discord: process.env.HUDDLE_DISCORD_INVITE || null,
          // Self-hosted OAuth: no directory listing needed for a workspace to
          // install this instance.
          slack: installUrl(PUBLIC_URL) || process.env.HUDDLE_SLACK_INVITE || null,
        },
      });
    },
  },

  {
    method: 'POST',
    match: /^\/api\/huddles$/,
    handler: async (req, res) => {
      const body = await readJson(req);
      const title = String(body.title || '').trim();
      const city = String(body.city || '').trim();
      if (!title) return fail(res, 400, 'A title is required (e.g. "Maya\'s birthday dinner").');
      if (!city) return fail(res, 400, 'A city is required so links point somewhere real.');

      const start = body.windowStart || todayStr();
      const end = body.windowEnd || addDays(start, 13);
      if (end < start) return fail(res, 400, 'The window ends before it starts.');
      if (datesInWindow(start, end, 60).length > 45) {
        return fail(res, 400, 'Keep the date window under 45 days.');
      }

      const groupType = GROUP_TYPES.includes(body.groupType) ? body.groupType : 'mixed';
      const organizerName = String(body.organizerName || 'Organizer').trim().slice(0, 40);

      const huddle = createHuddle({
        title: title.slice(0, 120),
        city: city.slice(0, 80),
        groupType,
        partySize: Math.max(2, Math.min(30, Number(body.partySize) || 4)),
        window: { start, end },
        organizerName,
        tradeoff: '',
        blocked: null,
        shortfall: null,
      });

      send(res, 201, publicView(huddle, null));
    },
  },

  {
    method: 'GET',
    match: /^\/api\/huddles\/([\w-]+)$/,
    handler: async (req, res, [huddleId], url) => {
      const huddle = getHuddle(huddleId);
      if (!huddle) return fail(res, 404, 'No huddle with that link.');
      send(res, 200, publicView(huddle, url.searchParams.get('me')));
    },
  },

  {
    method: 'POST',
    match: /^\/api\/huddles\/([\w-]+)\/join$/,
    handler: async (req, res, [huddleId]) => {
      const huddle = getHuddle(huddleId);
      if (!huddle) return fail(res, 404, 'No huddle with that link.');

      const body = await readJson(req);
      const name = String(body.name || '').trim().slice(0, 40);
      if (!name) return fail(res, 400, 'Tell us your name first.');
      if (huddle.participants.length >= 30) return fail(res, 400, 'This huddle is full (30 people).');

      const existing = huddle.participants.find(
        (p) => p.name.toLowerCase() === name.toLowerCase()
      );
      if (existing) {
        return send(res, 200, { participantId: existing.id, huddle: publicView(huddle, existing.id) });
      }

      const participant = {
        id: id('p', 4),
        name,
        prefs: emptyPrefs(),
        transcript: [],
        done: false,
        joinedAt: new Date().toISOString(),
      };
      huddle.participants.push(participant);
      saveHuddle(huddle);

      send(res, 201, { participantId: participant.id, huddle: publicView(huddle, participant.id) });
    },
  },

  {
    method: 'POST',
    match: /^\/api\/huddles\/([\w-]+)\/chat$/,
    handler: async (req, res, [huddleId]) => {
      const huddle = getHuddle(huddleId);
      if (!huddle) return fail(res, 404, 'No huddle with that link.');

      const body = await readJson(req);
      const participant = huddle.participants.find((p) => p.id === body.participantId);
      if (!participant) return fail(res, 404, 'Join the huddle before chatting.');

      const message = String(body.message || '').trim().slice(0, 2000);
      if (!message) return fail(res, 400, 'Empty message.');

      const turn = await readTurn({ huddle, participant, message });

      participant.transcript.push({ role: 'user', content: message });
      participant.transcript.push({ role: 'assistant', content: turn.reply });
      // Keep the transcript bounded so a long back-and-forth can't grow unchecked.
      if (participant.transcript.length > 40) {
        participant.transcript = participant.transcript.slice(-40);
      }
      participant.prefs = turn.prefs;
      participant.done = turn.done;
      if (turn.prefs.displayName && participant.name === 'Guest') {
        participant.name = turn.prefs.displayName.slice(0, 40);
      }

      // Any new information invalidates the previously computed plans.
      huddle.options = [];
      huddle.lockedOptionId = null;
      huddle.votes = {};
      saveHuddle(huddle);

      send(res, 200, {
        reply: turn.reply,
        done: turn.done,
        prefs: participant.prefs,
        huddle: publicView(huddle, participant.id),
      });
    },
  },

  {
    method: 'POST',
    match: /^\/api\/huddles\/([\w-]+)\/finalize$/,
    handler: async (req, res, [huddleId]) => {
      const huddle = getHuddle(huddleId);
      if (!huddle) return fail(res, 404, 'No huddle with that link.');

      // The caller identifies itself so the response still carries their own
      // prefs and transcript — otherwise the client would blank its own chat.
      const { participantId } = await readJson(req);

      const consensus = buildConsensus(huddle);
      if (consensus.respondedCount === 0) {
        return fail(res, 400, 'Nobody has answered yet — share the link first.');
      }

      const { options, tradeoff, blocked, shortfall } = await recommend({ huddle, consensus });
      huddle.options = options;
      huddle.tradeoff = tradeoff;
      huddle.blocked = blocked;
      huddle.shortfall = shortfall;
      huddle.votes = {};
      huddle.lockedOptionId = null;
      saveHuddle(huddle);

      send(res, 200, publicView(huddle, participantId || null));
    },
  },

  {
    method: 'POST',
    match: /^\/api\/huddles\/([\w-]+)\/vote$/,
    handler: async (req, res, [huddleId]) => {
      const huddle = getHuddle(huddleId);
      if (!huddle) return fail(res, 404, 'No huddle with that link.');

      const body = await readJson(req);
      const participant = huddle.participants.find((p) => p.id === body.participantId);
      if (!participant) return fail(res, 404, 'Join the huddle before voting.');
      if (!huddle.options.some((o) => o.id === body.optionId)) {
        return fail(res, 400, 'That option is no longer on the table.');
      }

      // One vote each: clear any previous choice first.
      for (const voters of Object.values(huddle.votes)) {
        const at = voters.indexOf(participant.id);
        if (at !== -1) voters.splice(at, 1);
      }
      (huddle.votes[body.optionId] ||= []).push(participant.id);
      saveHuddle(huddle);

      send(res, 200, publicView(huddle, participant.id));
    },
  },

  {
    method: 'POST',
    match: /^\/api\/huddles\/([\w-]+)\/lock$/,
    handler: async (req, res, [huddleId]) => {
      const huddle = getHuddle(huddleId);
      if (!huddle) return fail(res, 404, 'No huddle with that link.');

      const body = await readJson(req);
      const option = huddle.options.find((o) => o.id === body.optionId);
      if (!option) return fail(res, 400, 'That option is no longer on the table.');

      huddle.lockedOptionId = option.id;
      saveHuddle(huddle);

      send(res, 200, {
        huddle: publicView(huddle, body.participantId || null),
        shareLine: shareLine({ option, city: huddle.city, title: huddle.title }),
      });
    },
  },
];

const SLACK_ROUTES = slackRoutes(PUBLIC_URL);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Slack's OAuth and Events endpoints live outside /api/ because Slack owns
  // those URLs — they're configured in the app manifest, not by us.
  if (url.pathname.startsWith('/slack/')) {
    for (const route of SLACK_ROUTES) {
      if (!url.pathname.match(route.match)) continue;
      if (req.method !== route.method) return fail(res, 405, 'Method not allowed');
      try {
        return await route.handler(req, res, [], url);
      } catch (err) {
        console.error(`[server] ${req.method} ${url.pathname} failed:`, err.message);
        if (!res.headersSent) return fail(res, 500, 'Something broke on our side.');
        return;
      }
    }
    return fail(res, 404, 'Not found');
  }

  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');
    return serveStatic(res, url.pathname);
  }

  for (const route of routes) {
    const params = url.pathname.match(route.match);
    if (!params) continue;
    if (req.method !== route.method) return fail(res, 405, 'Method not allowed');
    try {
      return await route.handler(req, res, params.slice(1), url);
    } catch (err) {
      if (err instanceof ClientError) return fail(res, err.status, err.message);
      console.error(`[server] ${req.method} ${url.pathname} failed:`, err);
      return fail(res, 500, 'Something broke on our side.');
    }
  }
  fail(res, 404, 'Not found');
});

server.listen(PORT, () => {
  console.log(`\n  Huddle running at http://localhost:${PORT}`);
  console.log(
    `  Planning engine: ${llmAvailable() ? MODEL : 'heuristic fallback (set ANTHROPIC_API_KEY for the real thing)'}`
  );
  if (slackDistributionConfigured()) {
    console.log(`  Slack install:   ${PUBLIC_URL}/slack/install`);
    console.log(`  Slack events:    ${PUBLIC_URL}/slack/events`);
  }
  console.log('');
});
