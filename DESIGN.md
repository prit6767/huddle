# Huddle — Design Language

**"Warm Honesty."** A group-chat product that stays quiet until asked, tells the truth about how much it knows, and never fakes confidence. The look is friendly and social — the discipline is honesty. Those two ideas govern every decision below.

Implementation lives in `public/styles.css` (tokens + components) and `src/recommend.mjs` (which classifies every claim before it reaches a renderer).

---

## 1. Principles

1. **Quiet by default, warm when present.** The product speaks rarely, so when it does the surface should feel human and inviting — soft paper, rounded corners, a friendly coral — not a cold dashboard. Restraint is behavioral, not visual. Warmth earns the right to interrupt.

2. **The interface never claims more than it knows.** Confidence is a visual system, not a footnote. Anything computed reads as solid and green; anything merely listed reads as dashed and muted. A user should be able to tell "we did the arithmetic" from "the catalog says so" at a glance, without reading a word.

3. **Attribution is a first-class citizen.** Constraints belong to people. `step-free (for Marta)` is a design pattern, not prose. Every merged constraint carries a name so no one's need gets buried.

4. **No invented trust signals.** There are no stars, ratings, or review counts anywhere in the system — not because we haven't built them, but because the data model forbids them. The design language must never leave a slot where a fake 4.6★ could live.

5. **Friction is shown, not hidden.** Non-overlap, budget squeezes, and un-answered members are surfaced honestly in their own amber voice. Disagreement is information, not an error state.

6. **New information invalidates old confidence.** When a constraint changes, computed options visibly clear rather than lingering as stale certainty.

---

## 2. Color

Warm paper base, one friendly primary, and a semantic set that carries the honesty system.

### Core

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#FBF7F2` | App background — warm paper |
| `--surface` | `#FFFFFF` | Cards, sheets, message bubbles |
| `--surface-sunk` | `#F4EEE6` | Wells, input rows, sunk panels |
| `--ink` | `#2A2622` | Primary text — warm near-black |
| `--ink-muted` | `#7A7269` | Secondary text, metadata |
| `--ink-faint` | `#A99F94` | Timestamps, placeholders |
| `--hairline` | `#EAE2D8` | Dividers, card borders |

### Brand

| Token | Hex | Use |
|---|---|---|
| `--coral` | `#F0603E` | Primary action, brand mark, the bot's own voice |
| `--coral-press` | `#D64A2C` | Pressed / active |
| `--coral-soft` | `#FFE9E2` | Tinted fills, selected states |

### Semantic — the honesty system

| Token | Hex | Meaning |
|---|---|---|
| `--computed` | `#2F8F5B` | We did the math. Solid green tick. Budget totals, attendance counts. |
| `--computed-soft` | `#E4F3EA` | Computed chip fill |
| `--listed` | `#8A8078` | From the catalog, unconfirmed. Always dashed, always muted. Accessibility & dietary live here permanently. |
| `--friction` | `#C77A12` | Honest tension — non-overlap, budget cap, pending member |
| `--friction-soft` | `#FBEFD6` | Friction note fill |
| `--link` | `#2E6FB0` | Maps / booking / calendar links |

> **Hard rule.** Accessibility and dietary claims never render in `--computed` green. They are always `--listed` (dashed, muted) and always paired with a "confirm with the venue" line. Being wrong there hurts a specific, named person.

Dark mode inverts `--bg`→`#211D1A`, `--surface`→`#2B2723`, keeps coral and green at equal chroma; `--listed` stays desaturated so the computed/listed distinction survives.

---

## 3. Typography

Friendly, rounded-humanist sans. Warm without being childish.

**Family:** Nunito, then `-apple-system`, `"Segoe UI"`, `system-ui`, `sans-serif`.

| Role | Size / Line | Weight | Notes |
|---|---|---|---|
| Display | 30 / 36 | 800 | Plan titles, screen headers |
| Title | 20 / 26 | 700 | Card titles, option names |
| Body | 16 / 24 | 500 | Answers, messages — the default |
| Body-strong | 16 / 24 | 700 | Emphasis inside answers |
| Meta | 13 / 18 | 600 | Attribution, chip labels, timestamps |
| Mono | 14 / 20 | 500 | `/commands`, `/usage` numbers |

Answers cap at two to three sentences — the type scale assumes short blocks, not walls. Numbers in `/usage` and computed claims use tabular figures so columns align.

---

## 4. Shape, space & elevation

Warmth comes from radius and softness, not decoration.

- **Radius:** `--r-chip: 999px`, `--r-card: 18px`, `--r-bubble: 20px` (with one squared corner toward the sender), `--r-input: 14px`
- **Spacing scale (4-based):** 4, 8, 12, 16, 24, 32, 48
- **Elevation:** cards use a single soft shadow `0 2px 8px rgba(42,38,34,.06)` — never harsh. The bot never uses heavy shadow; it stays close to the surface, matching its quiet demeanor.
- **Touch targets ≥ 44px.** This is a phone-first, group-chat product.

---

## 5. Voice & motion

The bot has one visual voice: coral, small, and calm. Its messages sit in a `--coral-soft` bubble with a coral rail on the leading edge. It never uses the loud shadow or the full-width banner — it looks like a considerate guest in someone else's chat.

**Acknowledgment, not chatter.** During planning the bot reacts with a single ✅ and stays silent. There is no "typing…" theatre, no celebratory confetti. Motion is limited to: a 120ms fade-in for new answers, a gentle 200ms cross-fade when computed options clear after a new constraint, and the ✅ reaction pop. Nothing bounces.

---

## 6. Components

### Confidence chip

The heart of the system. Two and only two forms:

- **Computed** — solid `--computed-soft` fill, green ✓, e.g. `✓ under $20/person (for Ruth)`. Means: the arithmetic is ours.
- **Listed** — transparent fill, dashed `--listed` border, muted text, e.g. `⌁ listed: step-free (for Marta)`. Means: from the catalog, not confirmed.

Attribution `(for Name)` is always present when a chip traces to a person. Accessibility/dietary chips are locked to the listed form and carry a "confirm with venue" caption. **Computed chips are ordered first, listed after** — settled in `recommend.mjs` so no renderer can get it wrong.

### Plan option card

Title, one narrated sentence naming whose constraint it satisfies, a row of confidence chips (computed first, listed after), then three actions: Map, Book / Hours, Add to Calendar (all `--link`). No image slot that implies endorsement, and structurally no ratings field. The three cards in a plan are visually parallel but categorically distinct — never three variants of one evening.

### Friction note

An amber `--friction-soft` strip with a small ⚠ and plain-language honesty: *"Budgets range $20–$60 — capped at $20 so nobody's squeezed,"* *"Wei's availability doesn't overlap,"* *"Priya hasn't answered yet."* Informational tone, never a red error.

### Answer bubble

Coral-rail bot bubble, two–three sentences, inline source links. Sources render as quiet `--link` underlines, not cards, unless a link preview is warranted.

### Command & usage

`/plan` `/status` `/go` `/cancel` `/ask` `/usage` `/forget` `/help` render in mono chips. `/usage` shows real tabular numbers (questions, API calls, searches, caps) — honesty extends to cost.

### Person constraint row

Avatar initial, name, and their extracted constraints as chips. Second-hand constraints ("grandma uses a walker") attribute to the speaker and show the affected name in the chip.

---

## 7. What the language forbids

- No stars, ratings, or review counts — no slot for them to exist.
- No green tick on accessibility or dietary claims.
- No full-bleed bot banners or notification badges that make a quiet product feel loud.
- No stale computed options after a constraint changes.
- No decorative venue photography that implies a visit or endorsement.
- No red "error" styling for honest friction — tension is amber and informational.

Sample venue data ("Neighborhood Noodle House," etc.) is invented archetypes, labelled as such. The design language treats all catalog-sourced claims as `--listed` precisely because the real data — and its uncertainty — will look the same when swapped in.
