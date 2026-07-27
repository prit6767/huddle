// Persistence, against a throwaway data directory.
//
// The store was moved from a rewritten JSON file to SQLite, and the whole
// point of that change was surviving a restart — so the test that matters is
// re-opening the database in a fresh process and finding the huddle still
// there. Anything less would pass against a module-level cache.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

let DIR;
before(() => {
  DIR = mkdtempSync(join(tmpdir(), 'huddle-store-'));
});
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

/** Run a snippet with the store pointed at the temp dir, in its own process. */
function inFreshProcess(code) {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, HUDDLE_DATA_DIR: DIR },
    encoding: 'utf8',
    cwd: new URL('..', import.meta.url).pathname,
  });
  return out.trim();
}

const STORE = "await import('./src/store.mjs')";

describe('store', () => {
  test('uses SQLite on a runtime that has node:sqlite', () => {
    const backend = inFreshProcess(
      `const s = ${STORE}; console.log(s.STORE_BACKEND);`
    );
    assert.equal(backend, 'sqlite');
  });

  test('a huddle survives a full process restart', () => {
    const id = inFreshProcess(`
      const s = ${STORE};
      const h = s.createHuddle({ title: 'Birthday', city: 'Portland, OR', groupType: 'friends' });
      console.log(h.id);
    `);
    assert.match(id, /^h_/);

    // Fresh process: nothing in memory, everything from disk.
    const title = inFreshProcess(`
      const s = ${STORE};
      console.log(s.getHuddle(${JSON.stringify(id)})?.title ?? 'MISSING');
    `);
    assert.equal(title, 'Birthday', 'the huddle did not survive the restart');
  });

  test('mutations persist, not just creations', () => {
    const id = inFreshProcess(`
      const s = ${STORE};
      const h = s.createHuddle({ title: 'Dinner', city: 'Austin, TX', groupType: 'friends' });
      h.participants.push({ id: 'p1', name: 'Ana', done: true });
      h.votes = { opt_1: ['p1'] };
      s.saveHuddle(h);
      console.log(h.id);
    `);

    const state = JSON.parse(
      inFreshProcess(`
        const s = ${STORE};
        const h = s.getHuddle(${JSON.stringify(id)});
        console.log(JSON.stringify({ n: h.participants.length, votes: h.votes }));
      `)
    );
    assert.equal(state.n, 1);
    assert.deepEqual(state.votes, { opt_1: ['p1'] });
  });

  test('an unknown id is null, not a throw', () => {
    const out = inFreshProcess(
      `const s = ${STORE}; console.log(String(s.getHuddle('h_nope')));`
    );
    assert.equal(out, 'null');
  });

  test('chat bindings find the right huddle and ignore closed ones', () => {
    const out = inFreshProcess(`
      const s = ${STORE};
      const a = s.createHuddle({ title: 'Old', city: 'X', binding: { platform: 'slack', chatId: 'C1', closed: true } });
      const b = s.createHuddle({ title: 'Live', city: 'X', binding: { platform: 'slack', chatId: 'C1' } });
      console.log(s.findHuddleByChat('slack', 'C1')?.title);
    `);
    assert.equal(out, 'Live');
  });

  test('chat ids match across string and number forms', () => {
    // Telegram hands back numeric chat ids; Slack and Discord hand back
    // strings. A mismatch here silently starts a second huddle in a chat that
    // already has one.
    const out = inFreshProcess(`
      const s = ${STORE};
      s.createHuddle({ title: 'Numeric', city: 'X', binding: { platform: 'telegram', chatId: -100123 } });
      console.log(s.findHuddleByChat('telegram', '-100123')?.title);
    `);
    assert.equal(out, 'Numeric');
  });

  test('ids are unguessable and prefixed', () => {
    const ids = JSON.parse(
      inFreshProcess(`
        const s = ${STORE};
        console.log(JSON.stringify([s.id('h'), s.id('h'), s.id('p')]));
      `)
    );
    assert.notEqual(ids[0], ids[1], 'ids must not collide');
    assert.match(ids[0], /^h_/);
    assert.match(ids[2], /^p_/);
    assert.ok(ids[0].length > 8, 'a share link id short enough to guess is not access control');
  });
});

describe('migration from the old JSON store', () => {
  test('existing huddles are carried over on first SQLite open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'huddle-migrate-'));
    try {
      writeFileSync(
        join(dir, 'huddles.json'),
        JSON.stringify({
          huddles: {
            h_legacy: {
              id: 'h_legacy',
              title: 'From the old store',
              createdAt: '2026-07-01T00:00:00.000Z',
              participants: [],
            },
          },
        })
      );
      const out = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const s = ${STORE}; console.log(s.getHuddle('h_legacy')?.title ?? 'MISSING');`,
        ],
        {
          env: { ...process.env, HUDDLE_DATA_DIR: dir },
          encoding: 'utf8',
          cwd: new URL('..', import.meta.url).pathname,
        }
      ).trim();
      assert.match(out, /From the old store/, 'upgrading must not lose in-flight plans');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
