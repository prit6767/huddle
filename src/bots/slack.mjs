// Slack adapter (Socket Mode — no public URL, no inbound firewall rule).
//
// Slack is the one platform where this product has a second job: "where should
// we do the team lunch / offsite / leaving do" is the same constraint-merging
// problem as a friend group, except dietary and accessibility needs are not
// optional niceties at work. The `listing` labelling matters more here, not
// less — telling a colleague a venue is step-free when nobody checked is worse
// in an employment context than in a group of friends.
//
// SETUP:
//   1. https://api.slack.com/apps -> Create New App -> From scratch
//   2. Socket Mode -> Enable. Generate an app-level token with connections:write
//      -> this is SLACK_APP_TOKEN (starts xapp-)
//   3. OAuth & Permissions -> Bot Token Scopes:
//        app_mentions:read, channels:history, groups:history, im:history,
//        chat:write, reactions:write, channels:read, groups:read, users:read
//   4. Event Subscriptions -> Enable -> Subscribe to bot events:
//        message.channels, message.groups, message.im, app_mention
//   5. Install to Workspace -> copy the Bot User OAuth Token (xoxb-)
//      -> this is SLACK_BOT_TOKEN
//   6. Invite it to a channel: /invite @YourApp
//   7. SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... npm run bots
//
// Unlike Telegram and Discord there is no privacy-mode trap here: the
// channels:history scope is what lets it read the conversation, and Slack
// makes you list it up front.
import pkg from '@slack/bolt';
const { App, LogLevel } = pkg;

import { handleEvent, handleVote } from './bridge.mjs';

// Slack renders at most 3000 chars per section block; stay under it.
const SLACK_MAX = 2900;

export function slackConfigured() {
  return Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN);
}

/** Split on blank lines so an option never gets cut in half. */
function chunk(text, limit = SLACK_MAX) {
  if (text.length <= limit) return [text];
  const out = [];
  let buffer = '';
  for (const block of text.split('\n\n')) {
    if (buffer && buffer.length + block.length + 2 > limit) {
      out.push(buffer);
      buffer = block;
    } else {
      buffer = buffer ? `${buffer}\n\n${block}` : block;
    }
  }
  if (buffer) out.push(buffer);
  return out;
}

/** Vote buttons as a Block Kit actions row. */
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

// Threads the bot has spoken in. Replying inside one counts as talking to it,
// the same way a Telegram reply does. In memory and bounded — this is a
// convenience, not state worth persisting.
const ownThreads = new Set();
const remember = (ts) => {
  if (!ts) return;
  if (ownThreads.size > 500) ownThreads.clear();
  ownThreads.add(ts);
};

// channel id -> name, so plans read "#team-social" rather than "C0123".
const channelNames = new Map();
async function channelName(client, id) {
  if (channelNames.has(id)) return channelNames.get(id);
  try {
    const res = await client.conversations.info({ channel: id });
    const name = res.channel?.name ? `#${res.channel.name}` : null;
    channelNames.set(id, name);
    return name;
  } catch {
    channelNames.set(id, null); // usually a DM, or missing channels:read
    return null;
  }
}

const displayNames = new Map();
async function displayName(client, userId) {
  if (displayNames.has(userId)) return displayNames.get(userId);
  let name = userId;
  try {
    const res = await client.users.info({ user: userId });
    const p = res.user?.profile || {};
    name = p.display_name || p.real_name || res.user?.name || userId;
  } catch {
    /* missing users:read — the id is a poor but working fallback */
  }
  displayNames.set(userId, name);
  return name;
}

async function deliver({ client, channel, threadTs, messageTs }, action) {
  if (!action || action.silent) return;

  if (action.react) {
    try {
      await client.reactions.add({
        channel,
        timestamp: messageTs,
        // Slack wants a name, not the character.
        name: action.react === '✅' ? 'white_check_mark' : 'eyes',
      });
    } catch (err) {
      // already_reacted is routine; anything else is worth seeing once.
      if (!/already_reacted/.test(err.message)) console.warn('[slack] reaction failed:', err.message);
    }
    return;
  }

  if (!action.text) return;
  const pieces = chunk(action.text);
  for (let i = 0; i < pieces.length; i++) {
    const last = i === pieces.length - 1;
    const res = await client.chat.postMessage({
      channel,
      thread_ts: threadTs, // undefined posts to the channel, which is what we want
      text: pieces[i], // fallback for notifications and screen readers
      blocks: blocksFor(pieces[i], last ? action.buttons : null),
      unfurl_links: false,
    });
    remember(res.ts);
    if (threadTs) remember(threadTs);
  }
}

export async function startSlack() {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.ERROR,
  });

  let botUserId = null;

  app.event('message', async ({ event, client }) => {
    // Ignore our own messages, other bots, edits, joins, and file-share noise.
    if (event.bot_id || event.subtype) return;
    if (event.user === botUserId) return;
    const text = (event.text || '').trim();
    if (!text) return;

    try {
      const mentioned =
        (botUserId && text.includes(`<@${botUserId}>`)) || event.channel_type === 'im';
      const repliedToBot = Boolean(event.thread_ts && ownThreads.has(event.thread_ts));

      const action = await handleEvent({
        platform: 'slack',
        chatId: event.channel,
        chatTitle: await channelName(client, event.channel),
        userId: event.user,
        userName: await displayName(client, event.user),
        // Strip the mention token so the question reads naturally to the model.
        text: text.replace(/<@[A-Z0-9]+>/gi, '').trim() || text,
        mentioned,
        repliedToBot,
      });

      await deliver(
        {
          client,
          channel: event.channel,
          // Answer inside the thread when asked inside one; otherwise speak to
          // the channel so the whole group sees the plan.
          threadTs: event.thread_ts,
          messageTs: event.ts,
        },
        action
      );
    } catch (err) {
      console.error('[slack] message failed:', err.message);
    }
  });

  // app_mention also fires for mentions; the message handler already covers
  // them, so acknowledge and drop it rather than answering twice.
  app.event('app_mention', async () => {});

  app.action(/^huddle_vote:/, async ({ body, ack, client, action }) => {
    await ack();
    try {
      const optionId = String(action.action_id).split(':').slice(1).join(':') || action.value;
      const result = handleVote({
        platform: 'slack',
        chatId: body.channel?.id,
        userId: body.user?.id,
        userName: await displayName(client, body.user?.id),
        optionId,
      });
      if (result?.text) {
        await client.chat.postMessage({
          channel: body.channel.id,
          text: result.text,
          unfurl_links: false,
        });
      }
    } catch (err) {
      console.error('[slack] vote failed:', err.message);
    }
  });

  // Check credentials BEFORE app.start(). Bolt surfaces an invalid token from
  // inside its socket loop as an unhandled rejection, which would take the
  // whole launcher — and every other adapter — down with it.
  let auth;
  try {
    auth = await app.client.auth.test();
    botUserId = auth.user_id;
  } catch (err) {
    const fatal = new Error(
      /invalid_auth|not_authed|account_inactive/.test(err.data?.error || err.message)
        ? 'SLACK_BOT_TOKEN rejected (invalid_auth). Copy the Bot User OAuth Token — it starts with xoxb- — from OAuth & Permissions, and reinstall the app if you changed scopes.'
        : `Slack auth failed: ${err.data?.error || err.message}`
    );
    fatal.fatal = true; // no amount of retrying fixes a wrong token
    throw fatal;
  }

  try {
    await app.start();
  } catch (err) {
    const fatal = new Error(
      /invalid_auth|not_authed/.test(err.data?.error || err.message)
        ? 'SLACK_APP_TOKEN rejected. Generate an app-level token with the connections:write scope — it starts with xapp-.'
        : `Slack Socket Mode failed to start: ${err.data?.error || err.message}`
    );
    fatal.fatal = true;
    throw fatal;
  }

  console.log(`  [slack] connected as ${auth.user} in ${auth.team}`);
  return app;
}
