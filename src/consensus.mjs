// Collapses N sets of individual preferences into one group constraint object.
//
// The rule that matters: hard constraints UNION (one person's allergy binds
// everyone), budget takes the MINIMUM (the cheapest ceiling is the real
// ceiling), and time takes the INTERSECTION (with a sweep so a single outlier
// doesn't zero out the whole window).
import { datesInWindow, toMinutes, fromMinutes, dayName } from './timeutil.mjs';

const MIN_SLOT_MINUTES = 60;

/** Best window on one date: the stretch covered by the most people. */
function bestWindowForDate(windows) {
  const bounds = [...new Set(windows.flatMap((w) => [toMinutes(w.earliest), toMinutes(w.latest)]))].sort(
    (a, b) => a - b
  );

  const segments = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const [start, end] = [bounds[i], bounds[i + 1]];
    const coverage = windows.filter(
      (w) => toMinutes(w.earliest) <= start && toMinutes(w.latest) >= end
    ).length;
    segments.push({ start, end, coverage });
  }
  if (!segments.length) return null;

  const peak = Math.max(...segments.map((s) => s.coverage));
  if (peak === 0) return null;

  // Merge the run of adjacent peak-coverage segments into a single window,
  // keeping the longest such run if there are several.
  let best = null;
  let run = null;
  for (const seg of segments) {
    if (seg.coverage === peak) {
      run = run && run.end === seg.start ? { ...run, end: seg.end } : { start: seg.start, end: seg.end };
      if (!best || run.end - run.start > best.end - best.start) best = { ...run };
    } else {
      run = null;
    }
  }
  if (!best || best.end - best.start < MIN_SLOT_MINUTES) return null;

  return {
    earliest: fromMinutes(best.start),
    latest: fromMinutes(best.end),
    coverage: peak,
    durationMins: best.end - best.start,
  };
}

export function buildConsensus(huddle) {
  const responded = huddle.participants.filter(
    (p) => p.prefs && (p.prefs.availability.length > 0 || p.prefs.budgetMaxPerPerson !== null)
  );

  // ---- time -------------------------------------------------------------
  const slots = [];
  for (const date of datesInWindow(huddle.window.start, huddle.window.end)) {
    const here = responded.filter((p) => p.prefs.availability.some((a) => a.date === date));
    if (!here.length) continue;

    const windows = here.map((p) => p.prefs.availability.find((a) => a.date === date));
    const best = bestWindowForDate(windows);
    if (!best) continue;

    slots.push({
      date,
      day: dayName(date),
      earliest: best.earliest,
      latest: best.latest,
      durationMins: best.durationMins,
      attending: here
        .filter((p) => {
          const w = p.prefs.availability.find((a) => a.date === date);
          return toMinutes(w.earliest) <= toMinutes(best.earliest) &&
            toMinutes(w.latest) >= toMinutes(best.latest);
        })
        .map((p) => p.name),
      missing: responded
        .filter((p) => !here.some((h) => h.id === p.id))
        .map((p) => p.name),
    });
  }

  slots.sort(
    (a, b) =>
      b.attending.length - a.attending.length ||
      b.durationMins - a.durationMins ||
      a.date.localeCompare(b.date)
  );

  // ---- money ------------------------------------------------------------
  const budgets = responded
    .map((p) => p.prefs.budgetMaxPerPerson)
    .filter((b) => typeof b === 'number');
  const budgetCeiling = budgets.length ? Math.min(...budgets) : null;
  const budgetSpread =
    budgets.length > 1 ? { low: Math.min(...budgets), high: Math.max(...budgets) } : null;

  // ---- hard requirements (union) ----------------------------------------
  const union = (key) => [...new Set(responded.flatMap((p) => p.prefs[key] || []))];
  const dietary = union('dietary');
  const accessibility = union('accessibility');
  const avoid = union('avoid');

  // ---- soft preferences (frequency-ranked) ------------------------------
  const vibeCounts = {};
  for (const p of responded) {
    for (const v of p.prefs.vibes || []) vibeCounts[v] = (vibeCounts[v] || 0) + 1;
  }
  const vibes = Object.entries(vibeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([vibe, count]) => ({ vibe, count }));

  // ---- who owns which constraint (used to explain the plan) -------------
  const attribution = {};
  for (const p of responded) {
    for (const key of ['dietary', 'accessibility']) {
      for (const item of p.prefs[key] || []) {
        (attribution[item] ||= []).push(p.name);
      }
    }
    if (p.prefs.budgetMaxPerPerson === budgetCeiling && budgetCeiling !== null) {
      (attribution[`budget:${budgetCeiling}`] ||= []).push(p.name);
    }
  }

  // ---- friction the group should know about -----------------------------
  const frictions = [];
  const noOverlap = responded.filter(
    (p) => p.prefs.availability.length && !slots.some((s) => s.attending.includes(p.name))
  );
  for (const p of noOverlap) {
    frictions.push(`${p.name}'s availability doesn't overlap the best windows.`);
  }
  if (budgetSpread && budgetSpread.high >= budgetSpread.low * 3 && budgetSpread.low < 25) {
    frictions.push(
      `Budgets range from $${budgetSpread.low} to $${budgetSpread.high} per person — options are capped at $${budgetSpread.low} so nobody is squeezed.`
    );
  }
  const pending = huddle.participants.filter((p) => !responded.some((r) => r.id === p.id));
  for (const p of pending) frictions.push(`${p.name} hasn't answered yet.`);

  return {
    respondedCount: responded.length,
    totalCount: huddle.participants.length,
    partySize: Math.max(huddle.partySize || 0, huddle.participants.length, 2),
    slots: slots.slice(0, 5),
    budgetCeiling,
    budgetSpread,
    dietary,
    accessibility,
    avoid,
    vibes,
    attribution,
    frictions,
    notes: responded.map((p) => p.prefs.notes).filter(Boolean),
  };
}
