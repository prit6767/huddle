// Slack distribution: OAuth install + the public Events endpoint.
//
// Socket Mode (src/bots/slack.mjs) is the right thing for one workspace you
// control — no public URL, no inbound firewall rule. It cannot be distributed:
// App Directory apps must receive events over HTTPS, because Slack has no
// socket to push a stranger's workspace events down. So distribution needs
// these three routes, and a public origin.
//
//   GET  /slack/install          -> redirect to Slack's consent screen
//   GET  /slack/oauth/callback   -> exchange the code, store the workspace token
//   POST /slack/events           -> receive events for every installed workspace
//
// SETUP (in addition to the scopes in bots/slack.mjs):
//   OAuth & Permissions -> Redirect URLs -> https://your-host/slack/oauth/callback
//   Event Subscriptions -> Request URL   -> https://your-host/slack/events
//   Basic Information   -> copy the Signing Secret
//
//   SLACK_CLIENT_ID=...
//   SLACK_CLIENT_SECRET=...
//   SLACK_SIGNING_SECRET=...
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

import { handleEvent, handleVote } from './bots/bridge.mjs';
import { saveInstall, getInstall } from './installs.mjs';

const SCOPES = [
  'app_mentions:read',
  'channels:history',
  'groups:history',
  'im:history',
  'chat:write',
  'reactions:write',
  'channels:read',
  'groups:read',
  'users:read',
].join(',');

export function slackDistributionConfigured() {
  return Boolean(
    process.env.SLACK_CLIENT_ID &&
      process.env.SLACK_CLIENT_SECRET &&
      process.env.SLACK_SIGNING_SECRET
  );
}

/** The button target on the landing page, when distribution is configured. */
export function installUrl(publicUrl) {
  if (!slackDistributionConfigured()) return null;
  return `${publicUrl}/slack/install`;
}

// ------------------------------------------------------------------ security

/**
 * Verify a request genuinely came from Slack.
 *
 * Two independent checks, and both matter: the HMAC proves the body was signed
 * with our secret, and the timestamp window stops a valid captured request
 * being replayed later. Compared in constant time — a fast-exit compare leaks
 * the signature a byte at a time.
 */
export function verifySlackSignature({ signingSecret, timestamp, signature, rawBody }) {
  if (!signingSecret || !timestamp || !signature) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 60 * 5) return false;

  const expected = `v0=${createHmac('sha256', signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex')}`;

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Slack retries an event it thinks we missed, and a retry that re-answers a
// question costs real money. Bounded, in memory: a duplicate arriving after a
// restart is a far smaller problem than an unbounded set.
const seenEvents = new Set();
function firstTimeSeeing(eventId) {
  if (!eventId) return true;
  if (seenEvents.has(eventId)) return false;
  if (seenEvents.size > 2000) seenEvents.clear();
  seenEvents.add(eventId);
  return true;
}

// OAuth state, so a callback can't be forged by pointing someone at our URL.
const pendingStates = new Map();
function issueState() {
  const state = randomBytes(16).toString('base64url');
  pendingStates.set(state, Date.now());
  for (const [k, t] of pendingStates) if (Date.now() - t > 10 * 60_000) pendingStates.delete(k);
  return state;
}
function consumeState(state) {
  if (!state || !pendingStates.has(state)) return false;
  pendingStates.delete(state);
  return true;
}

// ------------------------------------------------------------------ Web API

async function slackPost(token, method, payload) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method}: ${data.error || res.status}`);
  return data;
}

const SLACK_MAX = 2900;
function chunk(text, limit = SLACK_MAX) {
  if (text.length <= limit) return [text];
  const out = [];
  let buffer = '';
  for (const block of text.split('\n\n')) {
    if (buffer && buffer.length + block.length + 2 > limit) {
      out.push(buffer);
      buffer = block;
    } else buffer = buffer ? `${buffer}\n\n${block}` : block;
  }
  if (buffer) out.push(buffer);
  return out;
}

function blocksFor(text, buttons) {
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text } }];
  if (buttons?.length) {
    blocks.push({
      type: 'actions',
      elements: buttons.slice(0, 5).map((b) => ({
        type: 'button',
        text: { type: 'plain_text', text: b.label.slice(0, 75), emoji: true },
        action_id: `huddle_vote:${b.id}`,
        value: b.id,
      })),
    });
  }
  return blocks;
}

const ownThreads = new Set();
const nameCache = new Map();

async function displayName(token, userId) {
  const key = `${token.slice(-6)}:${userId}`;
  if (nameCache.has(key)) return nameCache.get(key);
  let name = userId;
  try {
    const res = await slackPost(token, 'users.info', { user: userId });
    const p = res.user?.profile || {};
    name = p.display_name || p.real_name || res.user?.name || userId;
  } catch {
    /* missing users:read — the id still works, it just reads badly */
  }
  if (nameCache.size > 1000) nameCache.clear();
  nameCache.set(key, name);
  return name;
}

async function deliver(token, { channel, threadTs, messageTs }, action) {
  if (!action || action.silent) return;

  if (action.react) {
    try {
      await slackPost(token, 'reactions.add', {
        channel,
        timestamp: messageTs,
        name: action.react === '✅' ? 'white_check_mark' : 'eyes',
      });
    } catch (err) {
      if (!/already_reacted/.test(err.message)) console.warn('[slack] reaction:', err.message);
    }
    return;
  }
  if (!action.text) return;

  const pieces = chunk(action.text);
  for (let i = 0; i < pieces.length; i++) {
    const last = i === pieces.length - 1;
    const res = await slackPost(token, 'chat.postMessage', {
      channel,
      thread_ts: threadTs,
      text: pieces[i],
      blocks: blocksFor(pieces[i], last ? action.buttons : null),
      unfurl_links: false,
    });
    if (res.ts) ownThreads.add(res.ts);
    if (threadTs) ownThreads.add(threadTs);
    if (ownThreads.size > 500) ownThreads.clear();
  }
}

// ------------------------------------------------------------------ handling

/** Work that happens after Slack has already been acknowledged. */
async function processEvent(body) {
  const install = getInstall(body.team_id);
  if (!install) {
    console.warn(`[slack] event from uninstalled team ${body.team_id} — ignoring`);
    return;
  }
  const token = install.botToken;
  const event = body.event || {};

  if (event.type !== 'message') return;
  if (event.bot_id || event.subtype) return;
  if (event.user === install.botUserId) return;

  const text = (event.text || '').trim();
  if (!text) return;

  const mentioned =
    (install.botUserId && text.includes(`<@${install.botUserId}>`)) || event.channel_type === 'im';

  const action = await handleEvent({
    platform: 'slack',
    // Scope by workspace as well as channel: two companies can both have a
    // #general, and their huddles, caches and daily caps must never meet.
    chatId: `${body.team_id}:${event.channel}`,
    chatTitle: null,
    userId: event.user,
    userName: await displayName(token, event.user),
    text: text.replace(/<@[A-Z0-9]+>/gi, '').trim() || text,
    mentioned,
    repliedToBot: Boolean(event.thread_ts && ownThreads.has(event.thread_ts)),
  });

  await deliver(
    token,
    { channel: event.channel, threadTs: event.thread_ts, messageTs: event.ts },
    action
  );
}

async function processInteraction(payload) {
  const install = getInstall(payload.team?.id);
  if (!install) return;
  const action = payload.actions?.[0];
  if (!action?.action_id?.startsWith('huddle_vote:')) return;

  const optionId = action.action_id.split(':').slice(1).join(':') || action.value;
  const result = handleVote({
    platform: 'slack',
    chatId: `${payload.team.id}:${payload.channel?.id}`,
    userId: payload.user?.id,
    userName: await displayName(install.botToken, payload.user?.id),
    optionId,
  });
  if (result?.text) {
    await slackPost(install.botToken, 'chat.postMessage', {
      channel: payload.channel.id,
      text: result.text,
      unfurl_links: false,
    });
  }
}

// ------------------------------------------------------------------ routes

const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${title}</title>` +
  `<style>body{background:#211d1a;color:#f2ece5;font:16px/1.6 ui-sans-serif,system-ui;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px}` +
  `a{color:#ff7554}h1{font-size:24px;margin:0 0 8px}p{color:#b0a69b;max-width:32rem}</style>${body}`;

export function slackRoutes(publicUrl) {
  return [
    {
      method: 'GET',
      match: /^\/slack\/install$/,
      handler: (req, res) => {
        if (!slackDistributionConfigured()) {
          res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(page('Not available', '<h1>Not available</h1><p>This instance has no Slack app configured.</p>'));
        }
        const url =
          `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(process.env.SLACK_CLIENT_ID)}` +
          `&scope=${encodeURIComponent(SCOPES)}` +
          `&redirect_uri=${encodeURIComponent(`${publicUrl}/slack/oauth/callback`)}` +
          `&state=${issueState()}`;
        res.writeHead(302, { location: url });
        res.end();
      },
    },

    {
      method: 'GET',
      match: /^\/slack\/oauth\/callback$/,
      handler: async (req, res, _p, url) => {
        const done = (status, html) => {
          res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
        };
        const code = url.searchParams.get('code');
        if (url.searchParams.get('error') || !code) {
          return done(400, page('Install cancelled', '<h1>Install cancelled</h1><p>Nothing was changed.</p>'));
        }
        if (!consumeState(url.searchParams.get('state'))) {
          // Either a forged callback or a link someone sat on for ten minutes.
          return done(
            400,
            page('Expired link', `<h1>That link expired</h1><p><a href="${publicUrl}/slack/install">Start again</a></p>`)
          );
        }

        const body = new URLSearchParams({
          code,
          client_id: process.env.SLACK_CLIENT_ID,
          client_secret: process.env.SLACK_CLIENT_SECRET,
          redirect_uri: `${publicUrl}/slack/oauth/callback`,
        });
        const data = await (
          await fetch('https://slack.com/api/oauth.v2.access', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body,
          })
        ).json();

        if (!data.ok) {
          console.error('[slack] oauth exchange failed:', data.error);
          return done(400, page('Install failed', `<h1>Install failed</h1><p>Slack said: ${data.error}</p>`));
        }

        saveInstall({
          teamId: data.team?.id,
          teamName: data.team?.name,
          botToken: data.access_token,
          botUserId: data.bot_user_id,
        });
        console.log(`[slack] installed in ${data.team?.name || data.team?.id}`);

        done(
          200,
          page(
            'Added to Slack',
            `<div><h1>Huddle is in ${data.team?.name || 'your workspace'}</h1>` +
              `<p>Invite it to a channel with <b>/invite @Huddle</b>, then talk to it normally. ` +
              `It reads for context but only answers when addressed.</p>` +
              `<p><a href="${publicUrl}">What it can do →</a></p></div>`
          )
        );
      },
    },

    {
      method: 'POST',
      match: /^\/slack\/events$/,
      handler: async (req, res) => {
        const raw = await new Promise((resolve, reject) => {
          let data = '';
          req.on('data', (c) => {
            data += c;
            if (data.length > 1_000_000) reject(new Error('payload too large'));
          });
          req.on('end', () => resolve(data));
          req.on('error', reject);
        });

        if (
          !verifySlackSignature({
            signingSecret: process.env.SLACK_SIGNING_SECRET,
            timestamp: req.headers['x-slack-request-timestamp'],
            signature: req.headers['x-slack-signature'],
            rawBody: raw,
          })
        ) {
          res.writeHead(401, { 'content-type': 'text/plain' });
          return res.end('invalid signature');
        }

        // Interactions arrive form-encoded with a JSON payload field.
        let body;
        if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) {
          const payload = new URLSearchParams(raw).get('payload');
          body = payload ? JSON.parse(payload) : {};
        } else {
          body = JSON.parse(raw || '{}');
        }

        if (body.type === 'url_verification') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          return res.end(body.challenge || '');
        }

        // Slack requires a 200 within three seconds and retries otherwise. A
        // web search takes longer than that, so acknowledge first and do the
        // work after — a retry would double-charge for one question.
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('');

        const eventId = body.event_id || body.trigger_id;
        if (!firstTimeSeeing(eventId)) return;

        try {
          if (body.type === 'event_callback') await processEvent(body);
          else if (body.type === 'block_actions') await processInteraction(body);
        } catch (err) {
          console.error('[slack] processing failed:', err.message);
        }
      },
    },
  ];
}
