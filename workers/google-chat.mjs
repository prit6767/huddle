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
import { formatAnswer, summarize } from '../src/assistant.mjs';
import {
  answerWithCache,
  loadContext,
  recordMessage,
  transcriptOf,
  claimQuestion,
  firstTimeSeeing,
  isSummarizeCommand,
  recordUser,
  PER_CHAT_DAILY,
  WELCOME,
} from './chat-state.mjs';

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

// Per-chat state (context buffer, daily cap, event-dedup) is shared with the
// other adapters in chat-state.mjs — imported above so all three stay in lockstep.

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
    return reply(WELCOME);
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

  await recordUser(env.DB, 'google', space, event.user?.name);
  const context = transcriptOf(await loadContext(env.DB, key));
  await recordMessage(env.DB, key, name, question);

  if (!(await claimQuestion(env.DB, key))) {
    return reply(`This space has hit its daily limit of ${PER_CHAT_DAILY} questions. Resets at midnight UTC.`);
  }

  // "catch me up" / "/summarize": recap the context we already hold, no search.
  if (isSummarizeCommand(question)) {
    const summary = await summarize({ transcript: context, platform: 'google', chatId: key });
    return reply(summary.text);
  }

  const answer = await answerWithCache(env, { question, context, platform: 'google', chatId: key });
  // Save the bot's reply so a follow-up has memory of what it just said.
  if (answer?.text) await recordMessage(env.DB, key, 'Huddle', answer.text);
  return reply(formatAnswer(answer));
}
