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

export function adminConfigured(env) {
  return Boolean(env.HUDDLE_ADMIN_TOKEN);
}

function authorized(request, env) {
  const url = new URL(request.url);
  const t =
    url.searchParams.get('token') ||
    (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return Boolean(env.HUDDLE_ADMIN_TOKEN) && t.length > 0 && t === env.HUDDLE_ADMIN_TOKEN;
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

  const [workspaces, totalQ, todayQ, activeChats, huddles] = await Promise.all([
    one('SELECT COUNT(*) AS n FROM installs'),
    one('SELECT COALESCE(SUM(used), 0) AS n FROM usage'),
    one('SELECT COALESCE(SUM(used), 0) AS n FROM usage WHERE day = ?', today),
    one('SELECT COUNT(DISTINCT chat_key) AS n FROM usage'),
    one('SELECT COUNT(*) AS n FROM huddles'),
  ]);

  const byPlatform = await rows(
    `SELECT ${PLATFORM_EXPR} AS platform, COUNT(DISTINCT chat_key) AS chats, COALESCE(SUM(used), 0) AS questions
     FROM usage GROUP BY platform ORDER BY questions DESC`
  );
  const daily = await rows(
    `SELECT day, COALESCE(SUM(used), 0) AS questions, COUNT(DISTINCT chat_key) AS chats
     FROM usage GROUP BY day ORDER BY day DESC LIMIT 14`
  );
  const installs = await rows(
    'SELECT team_name, installed_at FROM installs ORDER BY installed_at DESC LIMIT 50'
  );

  return {
    totals: {
      workspaces: workspaces.n || 0,
      activeChats: activeChats.n || 0,
      totalQuestions: totalQ.n || 0,
      todayQuestions: todayQ.n || 0,
      huddles: huddles.n || 0,
    },
    byPlatform,
    daily,
    installs,
    generatedAt: new Date().toISOString(),
  };
}

export async function handleAdmin(request, env) {
  if (!adminConfigured(env)) return new Response('Not configured', { status: 404 });
  const json = (b, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);
  try {
    return json(await adminStats(env));
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
