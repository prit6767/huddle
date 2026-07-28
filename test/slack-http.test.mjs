// Slack request signing.
//
// This is the door to a distributed app: anything that passes this check gets
// treated as a genuine instruction from a workspace. A mistake here is not a
// bug, it's an open endpoint, so the checks get tested directly rather than
// trusted because they look right.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { verifySlackSignature } from '../src/slack-verify.mjs';

const SECRET = 'test_signing_secret';
const now = () => Math.floor(Date.now() / 1000);

function sign(body, timestamp = now(), secret = SECRET) {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

// `in` rather than ?? — passing an explicit undefined must mean "omit this",
// not "fall back to a valid one", or the missing-field tests test nothing.
const check = (over = {}) => {
  const rawBody = 'rawBody' in over ? over.rawBody : '{"type":"event_callback"}';
  const timestamp = 'timestamp' in over ? over.timestamp : now();
  return verifySlackSignature({
    signingSecret: 'signingSecret' in over ? over.signingSecret : SECRET,
    timestamp,
    signature: 'signature' in over ? over.signature : sign(rawBody, timestamp),
    rawBody,
  });
};

describe('slack signature verification', () => {
  test('accepts a correctly signed, fresh request', () => {
    assert.equal(check(), true);
  });

  test('rejects a tampered body', () => {
    const timestamp = now();
    const signature = sign('{"type":"event_callback"}', timestamp);
    // Same signature, different payload — the classic replay-with-edits.
    assert.equal(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp,
        signature,
        rawBody: '{"type":"event_callback","evil":true}',
      }),
      false
    );
  });

  test('rejects a signature made with the wrong secret', () => {
    const timestamp = now();
    const rawBody = '{"a":1}';
    assert.equal(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp,
        signature: sign(rawBody, timestamp, 'not_our_secret'),
        rawBody,
      }),
      false
    );
  });

  test('rejects a stale request, even though the signature is valid', () => {
    // Replay protection: a captured request must not work an hour later.
    const old = now() - 60 * 60;
    assert.equal(check({ timestamp: old, signature: sign('{"type":"event_callback"}', old) }), false);
  });

  test('rejects a timestamp from the future', () => {
    const ahead = now() + 60 * 60;
    assert.equal(
      check({ timestamp: ahead, signature: sign('{"type":"event_callback"}', ahead) }),
      false
    );
  });

  test('accepts a request at the edge of the window but not past it', () => {
    const inside = now() - 4 * 60;
    const outside = now() - 6 * 60;
    assert.equal(check({ timestamp: inside, signature: sign('{"type":"event_callback"}', inside) }), true);
    assert.equal(check({ timestamp: outside, signature: sign('{"type":"event_callback"}', outside) }), false);
  });

  test('rejects missing pieces rather than throwing', () => {
    assert.equal(check({ signature: undefined }), false);
    assert.equal(check({ timestamp: undefined }), false);
    assert.equal(check({ signingSecret: undefined }), false);
    assert.equal(check({ timestamp: 'not-a-number' }), false);
  });

  test('rejects a malformed signature without crashing', () => {
    // Length mismatch must short-circuit — timingSafeEqual throws on
    // different-length buffers, and an exception here would be a 500 on a
    // public endpoint.
    assert.doesNotThrow(() => check({ signature: 'v0=short' }));
    assert.equal(check({ signature: 'v0=short' }), false);
    assert.equal(check({ signature: '' }), false);
  });

  test('an empty body still verifies correctly', () => {
    assert.equal(check({ rawBody: '' }), true);
  });
});
