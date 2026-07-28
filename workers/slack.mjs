// Slack on Cloudflare Workers: one-click install + the bot's Q&A, on D1.
//
// This is what makes Slack usable on the live deployment instead of a separate
// Node process. Three routes:
//   GET  /slack/install         -> Slack consent screen ("Add to Slack")
//   GET  /slack/oauth/callback  -> store this workspace's bot token in D1
//   POST /slack/events          -> verified events; the bot answers @mentions
//
// The bot reads the channel for context and answers only when addressed
// (@mention or DM) — the same etiquette as every other adapter. Context, the
// daily spend cap, and event-dedup all live in D1, because Workers isolates are
// ephemeral and can't hold the in-memory state the Node build uses.
//
// Planning (/plan) over Slack is the next stage; this ships the company pitch —
// "add it, @ it, get a sourced answer" — end to end.
import { randomBytes } from 'node:crypto';

import { verifySlackSignature } from '../src/slack-verify.mjs';
import { formatAnswer } from '../src/assistant.mjs';
import { installs } from './store-d1.mjs';
import { answerWithCache } from './chat-state.mjs';

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

const PER_CHAT_DAILY = 50;
const CONTEXT_MESSAGES = 20;

export function slackConfigured(env) {
  return Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET && env.SLACK_SIGNING_SECRET);
}
export function slackInstallUrl(env, publicUrl) {
  return slackConfigured(env) ? `${publicUrl}/slack/install` : null;
}

// ------------------------------------------------------------- D1 state
const today = () => new Date().toISOString().slice(0, 10);

async function loadContext(db, key) {
  const row = await db.prepare('SELECT messages FROM chatlog WHERE chat_key = ?').bind(key).first();
  if (!row) return [];
  try {
    return JSON.parse(row.messages);
  } catch {
    return [];
  }
}
async function recordMessage(db, key, name, text) {
  const msgs = await loadContext(db, key);
  msgs.push({ name: (name || 'Someone').slice(0, 40), text: String(text).slice(0, 500), at: Date.now() });
  const trimmed = msgs.slice(-CONTEXT_MESSAGES);
  await db
    .prepare(
      `INSERT INTO chatlog (chat_key, messages, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(chat_key) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at`
    )
    .bind(key, JSON.stringify(trimmed), new Date().toISOString())
    .run();
}
function transcriptOf(msgs) {
  return msgs.map((m) => `${m.name}: ${m.text}`).join('\n');
}

/** Claim one question against the durable daily cap. Returns true if allowed. */
async function claimQuestion(db, key) {
  const day = today();
  await db
    .prepare(
      `INSERT INTO usage (day, chat_key, used) VALUES (?, ?, 1)
       ON CONFLICT(day, chat_key) DO UPDATE SET used = used + 1`
    )
    .bind(day, key)
    .run();
  const row = await db.prepare('SELECT used FROM usage WHERE day = ? AND chat_key = ?').bind(day, key).first();
  return (row?.used ?? 1) <= PER_CHAT_DAILY;
}

/** True the first time an event id is seen; Slack retries otherwise. */
async function firstTimeSeeing(db, eventId) {
  if (!eventId) return true;
  try {
    await db
      .prepare('INSERT INTO seen_events (event_id, seen_at) VALUES (?, ?)')
      .bind(eventId, new Date().toISOString())
      .run();
    return true;
  } catch {
    return false; // primary-key clash = already processed
  }
}

// ------------------------------------------------------------- Slack Web API
async function slackPost(token, method, payload) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method}: ${data.error || res.status}`);
  return data;
}

const nameCache = new Map();
async function displayName(token, userId) {
  const k = `${token.slice(-6)}:${userId}`;
  if (nameCache.has(k)) return nameCache.get(k);
  let name = userId;
  try {
    const res = await slackPost(token, 'users.info', { user: userId });
    const p = res.user?.profile || {};
    name = p.display_name || p.real_name || res.user?.name || userId;
  } catch {
    /* missing users:read — id is a poor but working fallback */
  }
  if (nameCache.size > 500) nameCache.clear();
  nameCache.set(k, name);
  return name;
}

// ------------------------------------------------------------- event work
async function processEvent(env, body) {
  const db = env.DB;
  const install = await installs(db).get(body.team_id);
  if (!install) return;
  const token = install.botToken;
  const event = body.event || {};
  if (event.type !== 'message' && event.type !== 'app_mention') return;
  if (event.bot_id || event.subtype) return;
  if (event.user === install.botUserId) return;

  const text = (event.text || '').trim();
  if (!text) return;

  const key = `slack:${body.team_id}:${event.channel}`;
  const name = await displayName(token, event.user);
  const addressed =
    (install.botUserId && text.includes(`<@${install.botUserId}>`)) || event.channel_type === 'im';

  // Record every message for context; only answer when addressed.
  const cleaned = text.replace(/<@[A-Z0-9]+>/gi, '').trim() || text;
  if (!addressed) {
    await recordMessage(db, key, name, cleaned);
    return;
  }

  const context = transcriptOf(await loadContext(db, key));
  await recordMessage(db, key, name, cleaned);

  if (!(await claimQuestion(db, key))) {
    await slackPost(token, 'chat.postMessage', {
      channel: event.channel,
      thread_ts: event.thread_ts,
      text: `This channel has hit its daily limit of ${PER_CHAT_DAILY} questions. Resets at midnight UTC.`,
    });
    return;
  }

  const answer = await answerWithCache(env, { question: cleaned, context, platform: 'slack', chatId: key });
  // Record the bot's OWN reply too, so the next message has it in context —
  // otherwise a follow-up ("7" after "how many days?") arrives with no memory
  // of what the bot just asked.
  if (answer?.text) await recordMessage(db, key, 'Huddle', answer.text);
  await slackPost(token, 'chat.postMessage', {
    channel: event.channel,
    thread_ts: event.thread_ts,
    text: formatAnswer(answer),
    unfurl_links: false,
  });
}

// ------------------------------------------------------------- OAuth state
const pendingStates = new Map();
function issueState() {
  const s = randomBytes(16).toString('base64url');
  pendingStates.set(s, Date.now());
  for (const [k, t] of pendingStates) if (Date.now() - t > 10 * 60_000) pendingStates.delete(k);
  return s;
}

const page = (title, inner) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${title}</title><style>body{background:#211d1a;color:#f2ece5;font:16px/1.6 ui-sans-serif,system-ui;` +
      `display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px}a{color:#ff7554}` +
      `h1{font-size:24px;margin:0 0 8px}p{color:#b0a69b;max-width:32rem}</style>${inner}`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } }
  );

// ------------------------------------------------------------- router
export async function handleSlack(request, env, ctx, publicUrl) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/slack/install' && request.method === 'GET') {
    if (!slackConfigured(env)) return page('Not available', '<h1>Not available</h1><p>No Slack app is configured on this instance.</p>');
    const authUrl =
      `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(env.SLACK_CLIENT_ID)}` +
      `&scope=${encodeURIComponent(SCOPES)}` +
      `&redirect_uri=${encodeURIComponent(`${publicUrl}/slack/oauth/callback`)}&state=${issueState()}`;
    return new Response(null, { status: 302, headers: { location: authUrl } });
  }

  if (path === '/slack/oauth/callback' && request.method === 'GET') {
    const code = url.searchParams.get('code');
    if (url.searchParams.get('error') || !code) {
      return page('Install cancelled', '<h1>Install cancelled</h1><p>Nothing was changed.</p>');
    }
    const form = new URLSearchParams({
      code,
      client_id: env.SLACK_CLIENT_ID,
      client_secret: env.SLACK_CLIENT_SECRET,
      redirect_uri: `${publicUrl}/slack/oauth/callback`,
    });
    const data = await (
      await fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
      })
    ).json();
    if (!data.ok) {
      console.error('[slack] oauth exchange failed:', data.error);
      return page('Install failed', `<h1>Install failed</h1><p>Slack said: ${data.error}</p>`);
    }
    await installs(env.DB).save({
      teamId: data.team?.id,
      teamName: data.team?.name,
      botToken: data.access_token,
      botUserId: data.bot_user_id,
    });
    console.log(`[slack] installed in ${data.team?.name || data.team?.id}`);
    return page(
      'Added to Slack',
      `<div><h1>Huddle is in ${data.team?.name || 'your workspace'}</h1>` +
        `<p>Invite it to a channel with <b>/invite @Huddle</b>, then @mention it to settle an argument — ` +
        `it searches the web and answers with sources.</p><p><a href="${publicUrl}">What it can do →</a></p></div>`
    );
  }

  if (path === '/slack/events' && request.method === 'POST') {
    const raw = await request.text();
    if (
      !verifySlackSignature({
        signingSecret: env.SLACK_SIGNING_SECRET,
        timestamp: request.headers.get('x-slack-request-timestamp'),
        signature: request.headers.get('x-slack-signature'),
        rawBody: raw,
      })
    ) {
      return new Response('invalid signature', { status: 401 });
    }

    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return new Response('bad json', { status: 400 });
    }

    if (body.type === 'url_verification') {
      return new Response(body.challenge || '', { headers: { 'content-type': 'text/plain' } });
    }

    // Ack within Slack's 3s window, then do the slow work (web search) after.
    if (body.type === 'event_callback') {
      // Dedup on the MESSAGE, not the event: an @mention in a channel arrives
      // as BOTH an app_mention and a message.channels event, with different
      // event_ids but the same message ts+channel. Keying on event_id let both
      // through and the bot answered twice. Fall back to event_id for events
      // without a message ts.
      const ev = body.event || {};
      const dedupKey =
        ev.ts && ev.channel ? `${body.team_id}:${ev.channel}:${ev.ts}` : body.event_id;
      const run = (async () => {
        if (!(await firstTimeSeeing(env.DB, dedupKey))) return;
        try {
          await processEvent(env, body);
        } catch (err) {
          console.error('[slack] processing failed:', err.message);
        }
      })();
      ctx?.waitUntil ? ctx.waitUntil(run) : await run;
    }
    return new Response('', { status: 200 });
  }

  return new Response('Not found', { status: 404 });
}
