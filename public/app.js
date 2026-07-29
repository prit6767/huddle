const $ = (sel) => document.querySelector(sel);

const state = {
  huddle: null,
  participantId: null,
  busy: false,
};

// ---------------------------------------------------------------- terminal
// Shared voice for the boot log and the planning log: timestamped lines,
// appended on a beat, real clock. All theater — but honest theater: every
// line names something the code actually does.
const stamp = () => new Date().toTimeString().slice(0, 8);

function termLine(target, text, hot = false) {
  const line = document.createElement('div');
  line.className = `term-line${hot ? ' hot' : ''}`;
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = stamp();
  line.append(t, document.createTextNode(text));
  target.appendChild(line);
  return line;
}

(function bootlog() {
  // The inline <head> gate decides whether this runs at all.
  if (!document.documentElement.dataset.boot) return;
  const el = $('#bootlog');
  const out = $('#bootlog-lines');

  const LINES = [
    'INCOMING GROUP CHAT DETECTED ...',
    'READING THE ROOM (QUIETLY) ...',
    'LOADING CONTROLLED VOCABULARIES ...',
    "BUDGET RULE ARMED: MIN OF EVERYONE'S MAX ...",
    'FREE TIME = THE OVERLAP, NOT UNANIMITY ...',
    "STAR RATINGS: NOT FOUND. GOOD — WE DON'T INVENT THOSE.",
    'STEADY HANDS. CLEAN ARITHMETIC. READY →',
  ];

  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    clearInterval(beat);
    el.classList.add('bootlog-done');
    setTimeout(() => {
      delete document.documentElement.dataset.boot;
      el.remove();
    }, 380);
  }

  let i = 0;
  const beat = setInterval(() => {
    if (i >= LINES.length) {
      clearInterval(beat);
      setTimeout(finish, 500);
      return;
    }
    termLine(out, LINES[i], i === LINES.length - 1);
    i++;
  }, 210);

  el.addEventListener('click', finish);
  window.addEventListener('keydown', finish, { once: true });
})();

// Scroll reveal: fade sections up as they enter the viewport. Under reduced
// motion the CSS already shows everything, so we just skip. If Intersection
// Observer is missing, reveal everything immediately — content is never stuck.
(function reveals() {
  const els = document.querySelectorAll('.reveal');
  if (!els.length) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
  );
  els.forEach((el) => io.observe(el));
})();

const QUICK_CHIPS = [
  'Free Saturday after 5, around $25',
  'Any evening this week, keep it cheap',
  "Weekend daytime — one of us can't do stairs",
  'Sunday brunch, two vegetarians, ~$30',
];

// ---------------------------------------------------------------- transport
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = !message;
}

const memberKey = (huddleId) => `huddle:${huddleId}:me`;

// ---------------------------------------------------------------- routing
function huddleIdFromUrl() {
  const match = location.pathname.match(/^\/h\/([\w-]+)/);
  return match ? match[1] : null;
}

async function route() {
  const huddleId = huddleIdFromUrl();
  if (!huddleId) {
    $('#view-create').hidden = false;
    $('#view-huddle').hidden = true;
    return;
  }

  $('#view-create').hidden = true;
  $('#view-huddle').hidden = false;
  state.participantId = localStorage.getItem(memberKey(huddleId));

  try {
    state.huddle = await api(
      `/api/huddles/${huddleId}${state.participantId ? `?me=${state.participantId}` : ''}`
    );
  } catch (err) {
    $('#view-huddle').innerHTML = `<div class="card"><h2>Link not found</h2><p class="muted">${escapeHtml(
      err.message
    )}</p><p><a href="/">Start a new huddle</a></p></div>`;
    return;
  }

  // A stale id from a wiped server would leave us in a broken half-joined state.
  if (state.participantId && !state.huddle.participants.some((p) => p.id === state.participantId)) {
    localStorage.removeItem(memberKey(huddleId));
    state.participantId = null;
  }

  render();
}

// ---------------------------------------------------------------- rendering
function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function render() {
  const h = state.huddle;
  if (!h) return;

  const badge = $('#engine-badge');
  if (badge) badge.textContent = h.engine;
  $('#h-title').textContent = h.title;
  $('#h-meta').textContent =
    `${h.city} · ${h.groupType} · about ${h.partySize} people · ` +
    `${h.window.start} to ${h.window.end}`;

  const me = h.participants.find((p) => p.id === state.participantId);
  $('#join-card').hidden = Boolean(me);
  $('#chat-card').hidden = !me;

  if (me) renderChat(me);
  renderRoster(h);
  renderConsensus(h.consensus);
  renderResults(h);

  $('#finalize').textContent = h.options.length ? 'Re-run the plans' : 'Get 3 plans';
  $('#finalize').disabled = state.busy || h.consensus.respondedCount === 0;
}

function renderChat(me) {
  const log = $('#chat-log');
  const turns = me.transcript || [];

  if (!turns.length) {
    log.innerHTML = `<div class="bubble assistant">Hi ${escapeHtml(
      me.name
    )} — one message is usually enough. When are you free, roughly what do you want to spend, and is there anything the group has to work around?</div>`;
  } else {
    log.innerHTML = turns
      .map(
        (turn) =>
          `<div class="bubble ${turn.role === 'user' ? 'user' : 'assistant'}">${escapeHtml(
            turn.content
          )}</div>`
      )
      .join('');
  }
  log.scrollTop = log.scrollHeight;

  $('#quick-chips').innerHTML = turns.length
    ? ''
    : QUICK_CHIPS.map((text) => `<button class="chip" type="button">${escapeHtml(text)}</button>`).join('');
}

function renderRoster(h) {
  $('#roster').innerHTML = h.participants.length
    ? h.participants
        .map((p) => {
          const initial = escapeHtml((p.name || '?').trim().charAt(0).toUpperCase());
          const you = p.id === state.participantId ? ' <span class="ink-faint">(you)</span>' : '';
          return `<li>
            <span class="avatar" aria-hidden="true">${initial}</span>
            <span class="who">${escapeHtml(p.name)}${you}</span>
            <span class="status ${p.done ? 'ready' : ''}">${
              p.done ? 'ready' : p.answered ? 'partial' : 'waiting'
            }</span>
          </li>`;
        })
        .join('')
    : '<li class="muted">Nobody yet — share the link.</li>';
}

function renderConsensus(c) {
  const body = $('#consensus-body');
  if (!c || c.respondedCount === 0) {
    body.innerHTML = '<p class="muted">Waiting on the first answer.</p>';
    return;
  }

  const facts = [];
  const best = c.slots[0];
  if (best) {
    facts.push([
      'when',
      `${new Date(`${best.date}T12:00:00`).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      })}, ${best.earliest}–${best.latest} · ${best.attending.length}/${c.respondedCount} free`,
    ]);
  }
  if (c.budgetCeiling !== null) {
    facts.push([
      'budget',
      `up to $${c.budgetCeiling}/person` +
        (c.budgetSpread && c.budgetSpread.low !== c.budgetSpread.high
          ? ` <span class="muted">(range $${c.budgetSpread.low}–$${c.budgetSpread.high})</span>`
          : ''),
    ]);
  }
  if (c.dietary.length) facts.push(['dietary', c.dietary.join(', ')]);
  if (c.accessibility.length) facts.push(['access', c.accessibility.join(', ')]);
  if (c.avoid.length) facts.push(['avoid', c.avoid.join(', ')]);
  if (c.vibes.length) facts.push(['vibe', c.vibes.map((v) => v.vibe).slice(0, 4).join(', ')]);

  body.innerHTML =
    `<ul class="facts">${facts
      .map(([k, v]) => `<li><span class="k">${escapeHtml(k)}</span><span class="v">${v}</span></li>`)
      .join('')}</ul>` +
    c.frictions.map((f) => `<p class="friction">${escapeHtml(f)}</p>`).join('');
}

/**
 * When a constraint changes the server drops the computed options. Rather than
 * letting stale certainty vanish instantly, fade it out over 200ms so the
 * clearing is legible — old confidence should be seen to leave.
 */
function clearResultsWithFade() {
  const section = $('#results');
  const options = $('#options');
  if (section.hidden || !options.children.length) {
    section.hidden = true;
    return;
  }
  options.classList.add('clearing');
  setTimeout(() => {
    options.classList.remove('clearing');
    options.innerHTML = '';
    section.hidden = true;
  }, 200);
}

function renderResults(h) {
  const section = $('#results');

  if (h.blocked) {
    section.hidden = false;
    $('#tradeoff').textContent = '';
    $('#options').innerHTML = `<p class="blocked">${escapeHtml(h.blocked)}</p>`;
    return;
  }
  if (!h.options.length) {
    clearResultsWithFade();
    return;
  }

  section.hidden = false;
  $('#tradeoff').textContent = [h.shortfall, h.tradeoff].filter(Boolean).join(' ');

  $('#options').innerHTML = h.options
    .map((opt) => {
      const voters = (h.votes[opt.id] || []).map(
        (pid) => h.participants.find((p) => p.id === pid)?.name || '?'
      );
      const isLocked = h.lockedOptionId === opt.id;
      const iVoted = (h.votes[opt.id] || []).includes(state.participantId);

      return `
      <article class="option ${isLocked ? 'locked' : ''}">
        <div class="headline">${escapeHtml(opt.headline)}${isLocked ? ' · locked in' : ''}</div>
        <div class="venue">${escapeHtml(opt.venue.name)}</div>
        <div class="when">${escapeHtml(opt.slot.label)}</div>
        <div class="price">${
          opt.estimatePerPerson === 0
            ? 'Free'
            : `~$${opt.estimatePerPerson}/person · ~$${opt.estimateTotal} total`
        }</div>
        <p class="why">${escapeHtml(opt.why)}</p>
        <div class="tags">
          ${opt.accommodates
            .map(
              (a) =>
                `<span class="tag ${a.source === 'computed' ? 'check' : 'listed'}">${escapeHtml(
                  a.text
                )}</span>`
            )
            .join('')}
        </div>
        ${opt.confirmNote ? `<p class="caveat">${escapeHtml(opt.confirmNote)}</p>` : ''}
        <div class="links">
          ${opt.links
            .map(
              (l) =>
                `<a href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
                  l.label
                )}</a>`
            )
            .join('')}
        </div>
        <div class="option-actions">
          <button class="btn small ${iVoted ? 'primary' : ''}" data-vote="${opt.id}" ${
            state.participantId ? '' : 'disabled'
          }>${iVoted ? 'Voted' : 'Vote'}</button>
          <button class="btn small" data-lock="${opt.id}">${isLocked ? 'Locked' : 'Lock it in'}</button>
          <span class="votes">${voters.length ? escapeHtml(voters.join(', ')) : 'no votes yet'}</span>
        </div>
      </article>`;
    })
    .join('');
}

// ---------------------------------------------------------------- actions
$('#create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  showError($('#create-error'), '');
  try {
    const huddle = await api('/api/huddles', {
      method: 'POST',
      body: Object.fromEntries(form.entries()),
    });
    history.pushState({}, '', `/h/${huddle.id}`);
    await route();
  } catch (err) {
    showError($('#create-error'), err.message);
  }
});

$('#join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError($('#join-error'), '');
  try {
    const result = await api(`/api/huddles/${state.huddle.id}/join`, {
      method: 'POST',
      body: { name: $('#join-name').value },
    });
    state.participantId = result.participantId;
    localStorage.setItem(memberKey(state.huddle.id), result.participantId);
    state.huddle = result.huddle;
    render();
    $('#chat-input').focus();
  } catch (err) {
    showError($('#join-error'), err.message);
  }
});

$('#chat-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#chat-input');
  const message = input.value.trim();
  if (!message || state.busy) return;

  state.busy = true;
  input.value = '';
  $('#chat-send').disabled = true;
  $('#quick-chips').innerHTML = '';

  const log = $('#chat-log');
  log.insertAdjacentHTML('beforeend', `<div class="bubble user">${escapeHtml(message)}</div>`);
  log.insertAdjacentHTML('beforeend', '<div class="bubble assistant pending">thinking…</div>');
  log.scrollTop = log.scrollHeight;

  try {
    const result = await api(`/api/huddles/${state.huddle.id}/chat`, {
      method: 'POST',
      body: { participantId: state.participantId, message },
    });
    state.huddle = result.huddle;
  } catch (err) {
    log.querySelector('.pending')?.remove();
    log.insertAdjacentHTML(
      'beforeend',
      `<div class="bubble assistant">Something went wrong: ${escapeHtml(err.message)}</div>`
    );
  } finally {
    state.busy = false;
    $('#chat-send').disabled = false;
    render();
    input.focus();
  }
});

$('#quick-chips').addEventListener('click', (event) => {
  if (!event.target.classList.contains('chip')) return;
  $('#chat-input').value = event.target.textContent;
  $('#chat-input').focus();
});

/**
 * The planning log: while finalize runs, the results area becomes a terminal
 * narrating the actual pipeline (extract → merge → filter → score → narrate).
 * Under reduced motion it stays a plain button-label change.
 */
function startPlanLog() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};
  const results = $('#results');
  const term = $('#plan-term');
  const out = $('#plan-term-lines');
  out.textContent = '';
  results.hidden = false;
  results.classList.add('planning');
  term.hidden = false;
  results.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const n = state.huddle?.consensus?.respondedCount || state.huddle?.participants?.length || 0;
  const engine = $('#engine-badge')?.textContent || 'heuristic';
  const LINES = [
    `extract   pulling constraints from ${n} ${n === 1 ? 'person' : 'people'} ...`,
    'merge     budget = min of maxes · dietary = union · time = overlap ...',
    'filter    dropping every venue that fails a hard constraint ...',
    'score     attendance first, vibes second, budget headroom last ...',
    engine === 'heuristic'
      ? 'narrate   no model configured — deterministic sentences it is ...'
      : `narrate   asking ${engine} to explain the picks ...`,
  ];
  let i = 0;
  const beat = setInterval(() => {
    if (i < LINES.length) termLine(out, LINES[i++]);
  }, 420);

  return function stop(failed) {
    clearInterval(beat);
    if (failed) termLine(out, 'error     that did not work — details below.', true);
    term.hidden = true;
    results.classList.remove('planning');
    if (failed && !state.huddle?.options?.length) results.hidden = true;
  };
}

$('#finalize').addEventListener('click', async () => {
  if (state.busy) return;
  state.busy = true;
  const button = $('#finalize');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Working it out…';
  showError($('#finalize-error'), '');
  const stopLog = startPlanLog();

  try {
    state.huddle = await api(`/api/huddles/${state.huddle.id}/finalize`, {
      method: 'POST',
      body: { participantId: state.participantId },
    });
    stopLog(false);
    render();
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    stopLog(true);
    showError($('#finalize-error'), err.message);
    button.textContent = original;
  } finally {
    state.busy = false;
    button.disabled = false;
  }
});

$('#options').addEventListener('click', async (event) => {
  const voteId = event.target.dataset?.vote;
  const lockId = event.target.dataset?.lock;

  try {
    if (voteId) {
      state.huddle = await api(`/api/huddles/${state.huddle.id}/vote`, {
        method: 'POST',
        body: { participantId: state.participantId, optionId: voteId },
      });
      render();
    } else if (lockId) {
      const result = await api(`/api/huddles/${state.huddle.id}/lock`, {
        method: 'POST',
        body: { participantId: state.participantId, optionId: lockId },
      });
      state.huddle = result.huddle;
      render();
      await copy(result.shareLine, event.target, 'Copied for the chat');
    }
  } catch (err) {
    alert(err.message);
  }
});

$('#copy-link').addEventListener('click', (event) => {
  copy(location.href, event.target, 'Link copied');
});

async function copy(text, button, confirmation) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = confirmation;
  } catch {
    button.textContent = 'Copy failed — select the URL';
  }
  setTimeout(() => {
    button.textContent = original;
  }, 1800);
}

/**
 * Add-to-group buttons for the hosted bot.
 *
 * One instance serves unlimited chats, so if whoever deployed this published
 * invite links, visitors need no setup at all. If they didn't, the whole block
 * stays hidden and the self-host steps below are the only path — better than a
 * button that goes nowhere.
 */
function renderInvites(invites) {
  const block = $('#quickadd');
  if (!block) return;
  const links = [
    { key: 'slack', label: 'Add to Slack', icon: '💼' },
    { key: 'telegram', label: 'Add to Telegram', icon: '✈️' },
    { key: 'discord', label: 'Add to Discord', icon: '🎮' },
  ].filter((l) => invites?.[l.key]);

  if (!links.length) return; // stays hidden; self-host is the only honest path
  $('#quickadd-actions').innerHTML = links
    .map(
      (l) =>
        `<a class="btn primary lg" href="${escapeHtml(invites[l.key])}" target="_blank"
           rel="noopener noreferrer"><span aria-hidden="true">${l.icon}</span> ${l.label}</a>`
    )
    .join('');
  block.hidden = false;
  // The self-host section is a <details> now; the summary already reads
  // "Prefer to self-host?", so there's nothing to rename here.
}

// ---------------------------------------------------------------- boot
window.addEventListener('popstate', route);

(async function boot() {
  try {
    const health = await api('/api/health');
    const engineBadge = $('#engine-badge');
    if (engineBadge) engineBadge.textContent = health.engine;
    renderInvites(health.invites);
    $('#f-start').value = health.defaultWindow.start;
    $('#f-end').value = health.defaultWindow.end;
    $('#f-start').min = health.defaultWindow.start;
  } catch {
    /* the create form still works with empty dates — the server fills defaults */
  }
  await route();
})();
