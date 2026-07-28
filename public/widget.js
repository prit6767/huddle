// Embeddable "Ask Huddle" widget.
//
// Drop this on ANY website with one line:
//   <script src="https://huddle-hq.com/widget.js" async></script>
//
// It adds a floating button; clicking it opens Huddle's Q&A in a panel. The
// panel is an iframe to /ask, so the host page's styles and CSP never collide
// with ours, and vice versa. No dependencies, no configuration.
(function () {
  if (window.__huddleWidget) return; // guard against double-inject
  window.__huddleWidget = true;

  var BASE = 'https://huddle-hq.com';
  var CORAL = '#f0603e';

  var open = false;

  // --- floating toggle button ---
  var btn = document.createElement('button');
  btn.setAttribute('aria-label', 'Ask Huddle');
  btn.innerHTML = '<span style="font-size:20px;line-height:1">◍</span><span style="font-weight:700">Ask</span>';
  style(btn, {
    position: 'fixed',
    zIndex: 2147483647,
    right: '20px',
    bottom: '20px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '12px 18px',
    border: '0',
    borderRadius: '999px',
    background: CORAL,
    color: '#fff',
    font: '600 15px/1 ui-sans-serif,system-ui,-apple-system,sans-serif',
    boxShadow: '0 6px 24px rgba(0,0,0,.22)',
    cursor: 'pointer',
  });

  // --- panel holding the iframe ---
  var panel = document.createElement('div');
  style(panel, {
    position: 'fixed',
    zIndex: 2147483647,
    right: '20px',
    bottom: '84px',
    width: 'min(384px, calc(100vw - 40px))',
    height: 'min(600px, calc(100vh - 120px))',
    background: '#fbf7f2',
    borderRadius: '18px',
    boxShadow: '0 12px 48px rgba(0,0,0,.28)',
    overflow: 'hidden',
    display: 'none',
    transformOrigin: 'bottom right',
  });

  var frame = document.createElement('iframe');
  frame.title = 'Ask Huddle';
  frame.setAttribute('loading', 'lazy');
  style(frame, { width: '100%', height: '100%', border: '0' });
  panel.appendChild(frame);

  btn.addEventListener('click', function () {
    open = !open;
    if (open && !frame.src) frame.src = BASE + '/ask'; // load on first open
    panel.style.display = open ? 'block' : 'none';
    btn.querySelector('span:last-child').textContent = open ? 'Close' : 'Ask';
  });

  function mount() {
    document.body.appendChild(btn);
    document.body.appendChild(panel);
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);

  function style(el, s) {
    for (var k in s) el.style[k] = s[k];
  }
})();
