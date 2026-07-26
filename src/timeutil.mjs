// Date/time helpers. Everything is naive local time in "YYYY-MM-DD" +
// "HH:MM" strings — no timezone math, because a huddle is always one city.

const DAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function fromMinutes(mins) {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(mins)));
  const h = String(Math.floor(clamped / 60)).padStart(2, '0');
  const m = String(clamped % 60).padStart(2, '0');
  return `${h}:${m}`;
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

/** Every date in [start, end] inclusive, capped so a typo can't blow up memory. */
export function datesInWindow(start, end, cap = 45) {
  const out = [];
  let cursor = start;
  while (cursor <= end && out.length < cap) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

export function dayName(dateStr) {
  return DAY_NAMES[new Date(`${dateStr}T12:00:00`).getDay()];
}

export function formatDate(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export function formatTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour12} ${period}` : `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

/** Intersect two [earliest, latest] windows. Returns null when they don't overlap. */
export function intersect(a, b) {
  const start = Math.max(toMinutes(a.earliest), toMinutes(b.earliest));
  const end = Math.min(toMinutes(a.latest), toMinutes(b.latest));
  if (end - start < 45) return null; // less than 45 min of overlap isn't a plan
  return { earliest: fromMinutes(start), latest: fromMinutes(end) };
}

/** ISO basic format used by Google Calendar template links: 20260801T183000 */
export function toCalendarStamp(dateStr, hhmm) {
  return `${dateStr.replace(/-/g, '')}T${hhmm.replace(':', '')}00`;
}
