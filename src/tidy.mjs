// Deterministic cleanup for the bot's answers.
//
// The system prompt forbids two things the model still does occasionally: a
// meta-preamble ("let me look that up", "I'd need to search") and a trailing
// clarifying question ("Which one did you mean?"). A prompt is a request; this
// is the guarantee. It runs on every answer before it's posted, so a model
// regression can't put those back.
//
// Deliberately conservative: it strips only well-known failure phrases, and
// never reduces an answer to a fragment — if cleaning would gut the message,
// the original is kept. Better an imperfect answer than none.

// Leading meta-preamble: an opening sentence that stalls instead of answering.
const PREAMBLE =
  /^\s*(?:great question[.,!]?\s+|good question[.,!]?\s+|sure[.,!]?\s+|let me (?:look|search|check)[^.!?]*[.!?]\s+|i(?:'|’)?d need to (?:search|look|check)[^.!?]*[.!?]\s+|i don(?:'|’)?t have (?:access to )?real[- ]?time (?:data|info)[^.!?]*[.!?]\s+|let me look that up[^.!?]*[.!?]\s+)/i;

const MIN_KEEP = 12; // don't strip down to a fragment

// A trailing sentence that addresses the user rather than answering: a
// clarifying question ("which…?", "…do you mean?") or a follow-up offer
// ("let me know…"). In a group chat nobody answers these.
function isFollowup(sentence) {
  const s = sentence.trim();
  if (/^(?:let me know|feel free|happy to help|just let me know)\b/i.test(s)) return true;
  if (!/\?$/.test(s)) return false; // otherwise it must be a question
  // second-person ("…do YOU mean?") or a "which/what" clarifier
  return /\byou\b/i.test(s) || /^(?:which|what|whom)\b/i.test(s);
}

// Split into sentences, keeping their trailing punctuation. The final chunk may
// have no terminator (a sentence the model didn't end).
function sentences(text) {
  return text.match(/[^.!?]+[.!?]+(?:["')\]]*)?|\S[^.!?]*$/g) || [text];
}

export function tidyAnswer(text) {
  if (!text || typeof text !== 'string') return text;
  let t = text.trim();

  const withoutPreamble = t.replace(PREAMBLE, '').trim();
  if (withoutPreamble.length >= MIN_KEEP) t = withoutPreamble;

  const parts = sentences(t);
  let end = parts.length;
  while (end > 1 && isFollowup(parts[end - 1])) end--;
  if (end < parts.length) {
    const kept = parts.slice(0, end).join('').trim();
    if (kept.length >= MIN_KEEP) t = kept;
  }

  return t.trim();
}
