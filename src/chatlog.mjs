// Rolling per-chat message buffer.
//
// This is what lets the bot be *in* the conversation rather than a search box:
// when someone finally asks "so who's actually better?", it can see the
// argument that prompted it.
//
// Deliberately IN MEMORY ONLY and bounded. Group chat messages are other
// people's words — persisting them to disk is a liability nobody asked for.
// A restart loses context, which is the correct trade.

// Every question resends this as input tokens, so it is a recurring cost,
// not a one-off. Twenty messages is plenty to follow an argument.
const MAX_PER_CHAT = Number(process.env.HUDDLE_CONTEXT_MESSAGES || 20);
const MAX_CHATS = 200;
const MAX_TEXT = 500;

/** Map<"platform:chatId", Array<{name, text, at}>> */
const buffers = new Map();

const key = (platform, chatId) => `${platform}:${chatId}`;

export function record(platform, chatId, { name, text }) {
  if (!text?.trim()) return;

  const k = key(platform, chatId);
  let buffer = buffers.get(k);
  if (!buffer) {
    // Simple LRU-ish cap so a busy server can't grow without bound.
    if (buffers.size >= MAX_CHATS) buffers.delete(buffers.keys().next().value);
    buffer = [];
    buffers.set(k, buffer);
  }

  buffer.push({
    name: (name || 'Someone').slice(0, 40),
    text: text.trim().slice(0, MAX_TEXT),
    at: Date.now(),
  });
  if (buffer.length > MAX_PER_CHAT) buffer.splice(0, buffer.length - MAX_PER_CHAT);
}

/** Recent messages as a plain transcript, oldest first. */
export function recent(platform, chatId, limit = MAX_PER_CHAT) {
  const buffer = buffers.get(key(platform, chatId)) || [];
  return buffer.slice(-limit);
}

export function transcript(platform, chatId, limit) {
  return recent(platform, chatId, limit)
    .map((m) => `${m.name}: ${m.text}`)
    .join('\n');
}

export function forget(platform, chatId) {
  buffers.delete(key(platform, chatId));
}
