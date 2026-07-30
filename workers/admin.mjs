// Admin analytics — aggregates the operator's own usage from D1.
//
// What we can honestly report from what's stored: Slack workspaces installed,
// distinct chats/spaces that have used the bot, total and daily questions,
// plans created, and a per-platform breakdown. We do NOT track individual end
// users (chat context is bounded and disposable), so "reach" is workspaces +
// active chats, not unique people — and the dashboard says so.
//
// Gated behind HUDDLE_ADMIN_TOKEN: this is your data, never public. Unset ->
// the endpoint 404s (dormant); wrong token -> 401.

import { timingSafeEqual } from 'node:crypto';

export function adminConfigured(env) {
  return Boolean(env.HUDDLE_ADMIN_USER && env.HUDDLE_ADMIN_PASS);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/** Verify HTTP Basic credentials against the configured admin user/password. */
function authorized(request, env) {
  if (!adminConfigured(env)) return false;
  const h = request.headers.get('authorization') || '';
  if (!/^Basic\s+/i.test(h)) return false;
  let user = '';
  let pass = '';
  try {
    const decoded = atob(h.replace(/^Basic\s+/i, ''));
    const i = decoded.indexOf(':');
    user = decoded.slice(0, i);
    pass = decoded.slice(i + 1);
  } catch {
    return false;
  }
  // Evaluate both so a mismatch on the username can't short-circuit the timing.
  const okUser = safeEqual(user, env.HUDDLE_ADMIN_USER);
  const okPass = safeEqual(pass, env.HUDDLE_ADMIN_PASS);
  return okUser && okPass;
}

// chat_key looks like "slack:T:C", "google:spaces/x", "telegram:123", "web:ip".
// The platform is the prefix before the first colon.
const PLATFORM_EXPR =
  "CASE WHEN instr(chat_key, ':') > 0 THEN substr(chat_key, 1, instr(chat_key, ':') - 1) ELSE chat_key END";

export async function adminStats(env) {
  const db = env.DB;
  const one = async (sql, ...b) => (await db.prepare(sql).bind(...b).first()) || {};
  const rows = async (sql, ...b) => (await db.prepare(sql).bind(...b).all()).results || [];
  const today = new Date().toISOString().slice(0, 10);

  // Retention windows: a chat "active" in the last N days, and chats that came
  // back on 2+ separate days (the real stickiness signal — one-and-done chats
  // inflate any raw total). Cutoffs computed in JS so they don't depend on
  // SQLite date() quirks.
  const cut = (n) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const d7 = cut(6);
  const d30 = cut(29);

  const [workspaces, totalQ, todayQ, activeChats, huddles, active7, active30, returning, users, users7, users30] =
    await Promise.all([
      one('SELECT COUNT(*) AS n FROM installs'),
      one('SELECT COALESCE(SUM(used), 0) AS n FROM usage'),
      one('SELECT COALESCE(SUM(used), 0) AS n FROM usage WHERE day = ?', today),
      one('SELECT COUNT(DISTINCT chat_key) AS n FROM usage'),
      one('SELECT COUNT(*) AS n FROM huddles'),
      one('SELECT COUNT(DISTINCT chat_key) AS n FROM usage WHERE day >= ?', d7),
      one('SELECT COUNT(DISTINCT chat_key) AS n FROM usage WHERE day >= ?', d30),
      one('SELECT COUNT(*) AS n FROM (SELECT chat_key FROM usage GROUP BY chat_key HAVING COUNT(DISTINCT day) >= 2)'),
      one('SELECT COUNT(*) AS n FROM seen_users'),
      one('SELECT COUNT(*) AS n FROM seen_users WHERE last_seen >= ?', `${d7}T00:00:00`),
      one('SELECT COUNT(*) AS n FROM seen_users WHERE last_seen >= ?', `${d30}T00:00:00`),
    ]);

  // Busiest chats — platform + volume + how many days they came back. Raw
  // chat_key (which carries channel/team ids) is deliberately NOT exposed.
  const topChats = await rows(
    `SELECT ${PLATFORM_EXPR} AS platform, COALESCE(SUM(used), 0) AS questions, COUNT(DISTINCT day) AS activeDays
     FROM usage GROUP BY chat_key ORDER BY questions DESC LIMIT 10`
  );

  // Distinct users per platform, merged onto the platform breakdown below.
  const usersByPlatform = await rows('SELECT platform, COUNT(*) AS users FROM seen_users GROUP BY platform');
  const upMap = Object.fromEntries(usersByPlatform.map((r) => [r.platform, r.users]));

  const byPlatform = await rows(
    `SELECT ${PLATFORM_EXPR} AS platform, COUNT(DISTINCT chat_key) AS chats, COALESCE(SUM(used), 0) AS questions
     FROM usage GROUP BY platform ORDER BY questions DESC`
  );
  byPlatform.forEach((p) => (p.users = upMap[p.platform] || 0));
  const daily = await rows(
    `SELECT day, COALESCE(SUM(used), 0) AS questions, COUNT(DISTINCT chat_key) AS chats
     FROM usage GROUP BY day ORDER BY day DESC LIMIT 14`
  );
  const installs = await rows(
    'SELECT team_name, installed_at FROM installs ORDER BY installed_at DESC LIMIT 50'
  );

  return {
    totals: {
      users: users.n || 0,
      workspaces: workspaces.n || 0,
      activeChats: activeChats.n || 0,
      totalQuestions: totalQ.n || 0,
      todayQuestions: todayQ.n || 0,
      huddles: huddles.n || 0,
      avgQuestionsPerChat: activeChats.n ? Math.round(((totalQ.n || 0) / activeChats.n) * 10) / 10 : 0,
    },
    retention: {
      users7d: users7.n || 0,
      users30d: users30.n || 0,
      activeChats7d: active7.n || 0,
      activeChats30d: active30.n || 0,
      returningChats: returning.n || 0,
    },
    byPlatform,
    topChats,
    daily,
    installs,
    generatedAt: new Date().toISOString(),
  };
}

export async function handleAdmin(request, env) {
  if (!adminConfigured(env)) return new Response('Not configured', { status: 404 });
  const json = (b, s = 200, headers = {}) =>
    new Response(JSON.stringify(b), {
      status: s,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
    });
  if (!authorized(request, env)) {
    // Prompt the browser's native Basic-auth dialog too, so /admin works even
    // without the custom login form.
    return json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Basic realm="Huddle Admin"' });
  }
  try {
    return json(await adminStats(env));
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
