const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- terminal
// The boot log: timestamped lines, appended on a beat, real clock. All theater
// — but honest theater: every line names something the product actually does.
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
  if (!el || !out) return;

  const LINES = [
    'INCOMING GROUP CHAT DETECTED ...',
    'READING THE ROOM (QUIETLY) ...',
    'WEB SEARCH ARMED — ANSWERS WITH SOURCES ...',
    'REPLIES ONLY WHEN ADDRESSED ...',
    "STAR RATINGS: NOT FOUND. GOOD — WE DON'T INVENT THOSE.",
    'STEADY HANDS. REAL SOURCES. READY →',
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

// ---------------------------------------------------------------- transport
async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

/**
 * Add-to-chat buttons for the hosted bot.
 *
 * One instance serves unlimited chats, so if whoever deployed this published
 * invite links, visitors need no setup at all. If they didn't, the block stays
 * hidden — better than a button that goes nowhere.
 */
function renderInvites(invites) {
  const block = $('#quickadd');
  if (!block) return;
  const links = [
    { key: 'slack', label: 'Add to Slack', icon: '💼' },
    { key: 'telegram', label: 'Add to Telegram', icon: '✈️' },
    { key: 'discord', label: 'Add to Discord', icon: '🎮' },
  ].filter((l) => invites?.[l.key]);

  if (!links.length) return; // stays hidden
  $('#quickadd-actions').innerHTML = links
    .map(
      (l) =>
        `<a class="btn primary lg" href="${escapeHtml(invites[l.key])}" target="_blank"
           rel="noopener noreferrer"><span aria-hidden="true">${l.icon}</span> ${l.label}</a>`
    )
    .join('');
  block.hidden = false;
}

// ---------------------------------------------------------------- boot
(async function boot() {
  try {
    const health = await api('/api/health');
    renderInvites(health.invites);
  } catch {
    /* the page is static otherwise — nothing here is required to read it */
  }
})();
