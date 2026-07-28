// Google Chat on Cloudflare Workers — the bot's Q&A for Google Workspace.
//
// Simpler than Slack in one important way: Google Chat lets an app reply
// SYNCHRONOUSLY — you return the message as the HTTP response body, within its
// ~30s deadline. A web search fits comfortably, so there's no ack-then-answer
// dance and no bot token to store: Google only sends an event when the app is
// addressed (a DM or an @mention in a space), and the reply is just the JSON
// you return.
//
// One route: POST /google/events. Every request carries a Google-signed bearer
// token; we verify it's really from Google Chat and aimed at this app before
// trusting anything in the body.
//
// SETUP (Google Cloud console — no code):
//   1. console.cloud.google.com -> a project -> enable "Google Chat API"
//   2. Chat API -> Configuration:
//        App name: Huddle,  Avatar URL: https://huddle-hq.com/og.png
//        Functionality: "Receive 1:1 messages" + "Join spaces and group conversations"
//        Connection settings: "HTTP endpoint URL" = https://huddle-hq.com/google/events
//        Visibility: make it available to your Workspace (or specific people)
//   3. Set GOOGLE_PROJECT_NUMBER (the project's *number*, not id) as a Worker var.
//
// No secret to copy — verification uses Google's public token info.
import { formatAnswer } from '../src/assistant.mjs';
import { answerWithCache } from './chat-state.mjs';

const PER_CHAT_DAILY = 50;
const CONTEXT_MESSAGES = 20;
const CHAT_ISSUER_EMAIL = 'chat@system.gserviceaccount.com';

export function googleChatConfigured(env) {
  return Boolean(env.GOOGLE_PROJECT_NUMBER);
}

/**
 * Verify the request is genuinely from Google Chat, for THIS app.
 *
 * Google signs a JWT (issuer chat@system.gserviceaccount.com) whose audience is
 * this app's project number. We validate it through Google's tokeninfo endpoint
 * — Google checks the signature and expiry; we check the issuer and audience.
 * Simple and no crypto to hand-roll; can move to local JWKS verification later.
 */
async function verifiedGoogle(request, env) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return false;
  try {
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`
    );
    if (!res.ok) return false;
    const claims = await res.json();
    return (
      claims.email === CHAT_ISSUER_EMAIL &&
      claims.email_verified !== false &&
      String(claims.aud) === String(env.GOOGLE_PROJECT_NUMBER)
    );
  } catch {
    return false;
  }
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
const transcriptOf = (msgs) => msgs.map((m) => `${m.name}: ${m.text}`).join('\n');

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

async function firstTimeSeeing(db, id) {
  if (!id) return true;
  try {
    await db.prepare('INSERT INTO seen_events (event_id, seen_at) VALUES (?, ?)').bind(id, new Date().toISOString()).run();
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- handler
const reply = (text) =>
  new Response(JSON.stringify({ text }), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

export async function handleGoogleChat(request, env) {
  if (request.method !== 'POST') return new Response('Not found', { status: 404 });
  if (!googleChatConfigured(env)) return new Response('Not configured', { status: 404 });

  if (!(await verifiedGoogle(request, env))) {
    return new Response('unauthorized', { status: 401 });
  }

  let event;
  try {
    event = await request.json();
  } catch {
    return new Response('bad json', { status: 400 });
  }

  // Lifecycle events: a friendly hello, no answer needed.
  if (event.type === 'ADDED_TO_SPACE') {
    return reply(
      "Hi! I'm Huddle. @mention me with a question — I search the web and answer with sources, so I'm handy for settling a debate."
    );
  }
  if (event.type !== 'MESSAGE') return new Response('', { status: 200 });

  const msg = event.message || {};
  // Google only sends MESSAGE events when the app is addressed, so every one is
  // for us. argumentText is the text with the @mention already stripped.
  const question = (msg.argumentText || msg.text || '').trim();
  if (!question) return reply('I’m here — ask me something.');

  const space = event.space?.name || 'unknown';
  const key = `google:${space}`;
  const name = event.user?.displayName || 'Someone';

  // Dedup on the message id in case Google retries.
  if (!(await firstTimeSeeing(env.DB, msg.name))) return new Response('', { status: 200 });

  const context = transcriptOf(await loadContext(env.DB, key));
  await recordMessage(env.DB, key, name, question);

  if (!(await claimQuestion(env.DB, key))) {
    return reply(`This space has hit its daily limit of ${PER_CHAT_DAILY} questions. Resets at midnight UTC.`);
  }

  const answer = await answerWithCache(env, { question, context, platform: 'google', chatId: key });
  return reply(formatAnswer(answer));
}
