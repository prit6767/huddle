// Slack request-signature verification — pure, runtime-agnostic.
//
// Extracted so both the Node adapter (slack-http.mjs) and the Cloudflare Worker
// (workers/slack.mjs) share ONE implementation. Uses only node:crypto, which
// works on Node and on workerd with nodejs_compat.
//
// This is the door to a distributed app: anything that passes is treated as a
// genuine instruction from a workspace, so both checks matter — the HMAC proves
// the body was signed with our secret, and the timestamp window stops a valid
// captured request being replayed later. The compare is constant-time; a
// fast-exit compare leaks the signature a byte at a time.
import { createHmac, timingSafeEqual } from 'node:crypto';

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
