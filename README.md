# Huddle

**An AI that lives in your group chat.** It sits quietly in the conversation, and when you talk to it, it answers — searching the web for anything current, so it's actually useful for settling arguments.

```
Dev:  ronaldo is clearly the goat
Sam:  are you serious, messi has more ballon d'ors
Dev:  ronaldo has more international goals though
Sam:  huddle, who actually has more career goals?

Bot:  Ronaldo leads career goals; Messi leads on Ballon d'Ors and
      assists. Sources below — "better" is preference, not stats.
      · espn.com/...
```

Because it has been listening, you don't have to re-explain the argument. It already knows what you were fighting about.

It also has one deep specialty: **group planning**. Ask it to plan something and it collects everyone's constraints from the chat and returns three finalized, bookable options — killing the other group-chat spiral (*"Where should we go?" "What time works?" "Is it accessible?" "That's too expensive for me."*).

---

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

The **planner** works with no API key — there's a deterministic keyword extractor behind it. The **general assistant cannot be faked**, so answering questions requires credentials:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

Without a key the bot says so plainly when asked something rather than guessing. The header badge shows which engine is live: the model ID, or `heuristic`.

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Enables the Claude path. The SDK also accepts `ANTHROPIC_AUTH_TOKEN` or an `ant auth login` profile. |
| `HUDDLE_MODEL` | `claude-haiku-4-5` | Model. Set to `claude-opus-5` for noticeably better answers at ~5x the price. |
| `HUDDLE_DISABLE_LLM` | — | Set to `1` to force the heuristic path even with a key present. Useful for testing. |
| `PORT` | `3000` | |
| `HUDDLE_WAKE_WORD` | `huddle` | Word that gets the bot's attention without an @mention. |
| `HUDDLE_ASK_EFFORT` | `medium` | Reasoning effort. Ignored on Haiku-tier models, which don't accept it. |
| `HUDDLE_MAX_SEARCHES` | `3` | Web searches per question. Sharpest cost lever after model choice. |
| `HUDDLE_CONTEXT_MESSAGES` | `20` | Recent messages kept per chat. Resent as input tokens on every question. |
| `HUDDLE_DAILY_QUESTIONS_PER_CHAT` | `50` | Hard cap per chat per day. |
| `HUDDLE_DAILY_QUESTIONS_TOTAL` | `500` | Hard cap across all chats per day. |
| `HUDDLE_CACHE_TTL_MS` | `600000` | How long a repeated question is served from cache (10 min). |
| `HUDDLE_PUBLIC_URL` | `http://localhost:3000` | Host used in share links posted to chats. |

---

## Adding it to a group chat

```bash
npm start          # web app,  terminal 1
npm run bots       # chat bots, terminal 2
```

Both read the same `data/huddles.json`, so a plan started in a group chat opens in the browser at the same URL and vice versa.

### What it costs

A group chat bot has an awkward cost profile: anyone can ask anything, as often as they like, and nobody sees the bill. Five things keep that in hand.

| Lever | Default | Effect |
|---|---|---|
| **Cheap model** | `claude-haiku-4-5` | ~5x cheaper than Opus 5 for a workload that is short questions and short answers |
| **Search cap** | 3 per question | Searches bill on top of tokens; 3 settles most factual arguments |
| **Answer cache** | 10 min, per chat | A re-ask or a double-tap costs nothing |
| **Daily caps** | 50/chat, 500 total | One person cannot run up an unbounded bill |
| **Trimmed context** | 20 messages | Context is resent as input tokens on *every* question, so this is a recurring cost |

Token spend lands in fractions of a cent per question. **Web searches are billed separately** from tokens — check [current pricing](https://platform.claude.com/docs/en/pricing) for the rate, and lower `HUDDLE_MAX_SEARCHES` if it adds up.

Run `/usage` in any chat for today's real numbers:

```
Today (2026-07-26), on claude-haiku-4-5:
  3 model calls, 1 served from cache
  4,500 in / 600 out tokens
  3 web searches (billed separately)
  Estimated model spend: under $0.01
  Questions used: 3/500 today (50 per chat)
```

The estimate covers model tokens only, from published per-token rates. It is indicative, not a bill.

**Want better answers instead?** `HUDDLE_MODEL=claude-opus-5` and raise `HUDDLE_MAX_SEARCHES`. The request shape adapts automatically — effort and the newer search tool are only sent to models that accept them.

### Asking it things

Three ways to get its attention — it answers **only** to these:

```
@YourBot who won the game last night?
huddle, what's the exchange rate right now?
/ask is this restaurant still open
```

…or just reply to one of its messages to continue the thread.

It searches the web whenever the answer depends on anything current — stats, scores, prices, standings, news — because model training data is stale for all of it. Answers come back short, with sources.

**The core etiquette rule: it never speaks unless spoken to.** It reads everything for context but stays completely silent otherwise. A bot that comments on every message is the thing this exists to eliminate.

`/forget` drops the chat context it's holding. `/usage` shows what it has cost today.

### Planning something

```
/plan Maya's birthday dinner in Portland, OR
```

Then everyone just **talks normally**. The bot reads the conversation, pulls out constraints, and reacts ✅ when it has someone — no replies. `/status` shows who's answered, `/go` returns three options with vote buttons.

It ignores banter: "no way" and "we should chat later" don't register as a veto or a preference.

### Platform support — read this before you start

| Platform | Status | Why |
|---|---|---|
| **Telegram** | ✅ Full bot | Official Bot API |
| **Discord** | ✅ Full bot | Official gateway API, real buttons |
| **iMessage** | ⚠️ Local Mac relay | No bot API exists; automates Messages on a Mac you own |
| **WhatsApp** | ❌ No bot possible | See below |

**WhatsApp has no legitimate path.** The official Business API is 1:1 customer messaging with no group support whatsoever. The only workaround is driving WhatsApp Web with an unofficial library, which violates the ToS and reliably gets phone numbers banned — so this project doesn't do it.

What works instead: the invite link. Paste `…/h/<id>` into any WhatsApp or iMessage thread and it unfurls into a card with the occasion and city; everyone taps through to the web app. That's one extra tap versus a bot, and it works in every chat app on earth with zero setup.

### Telegram

1. Message **@BotFather** → `/newbot` → copy the token
2. **@BotFather → `/setprivacy` → your bot → Disable** ← *not optional*
3. Remove and re-add the bot to your group (privacy mode is cached at join time)
4. `TELEGRAM_BOT_TOKEN=... npm run bots`

Step 2 is the one everyone misses. With privacy mode on, Telegram only delivers messages starting with `/`, so the bot can't read ordinary chatter — which is the entire product. The launcher warns you at startup if it detects this.

### Discord

1. [Developer Portal](https://discord.com/developers/applications) → New Application → Bot
2. Bot → Privileged Gateway Intents → **enable Message Content Intent** ← *not optional, same trap*
3. OAuth2 → URL Generator → scope `bot`, permissions: Send Messages, Read Message History, Add Reactions
4. Open the generated URL, add to your server
5. `DISCORD_BOT_TOKEN=... npm run bots`

### iMessage (macOS only)

Apple ships no bot API and there is no server-side way to join a conversation. The only thing that works — and how every "iMessage bot" including the commercial ones is built — is automating Messages on a Mac you control: read `~/Library/Messages/chat.db`, send via AppleScript.

1. **System Settings → Privacy & Security → Full Disk Access** → add your terminal app (Terminal, iTerm, VS Code — whichever launches node), then **fully quit and reopen it**
2. `ENABLE_IMESSAGE=1 npm run bots`
3. Approve the Automation prompt for controlling Messages on first send

Honest limitations:

- Runs only while that Mac is awake, logged in, and running Messages.
- Messages send from **your own number** — to the group it looks like you typing, not a bot.
- No tapbacks, so the ✅ acknowledgment is silent there; the bot only speaks for `/status` and `/go`.
- `chat.db` is an internal Apple format that changes between macOS releases. The reader handles both the legacy `text` column and the newer `attributedBody` blob, with a fallback, but it is not a supported interface and Apple can break it.

### Public links

By default share links say `localhost:3000`, which is useless to anyone else. Point it at a reachable host:

```bash
HUDDLE_PUBLIC_URL=https://huddle.example.com npm run bots
```

---

## How it works

```
participant chat ──▶ extract ──▶ merge ──▶ filter + score ──▶ narrate ──▶ 3 options
   (free text)      (per person)  (group)    (deterministic)    (Claude)    (+ links)
```

**1. Extract** (`src/extract.mjs`) — each participant's message becomes a structured preference record: availability windows, budget ceiling, dietary needs, accessibility needs, vibes, hard vetoes. Second-hand constraints count: *"my grandma is coming and uses a walker"* becomes `accessibility: [step-free, reserved-seating]`, attributed to that participant, not a note nobody reads.

**2. Merge** (`src/consensus.mjs`) — the arithmetic that group chats get wrong:

| Constraint | Rule | Why |
|---|---|---|
| Time | **Intersection**, via a coverage sweep | One person's odd window shouldn't zero out the whole day, so it finds the stretch covered by the most people rather than requiring unanimity |
| Budget | **Minimum** of everyone's maximum | The cheapest ceiling is the real ceiling — the person who can't afford $60 never has to say so twice |
| Dietary / accessibility | **Union** | One person's allergy binds the group |
| Vetoes | **Union** | "No bowling" means no bowling |
| Vibes | **Frequency-ranked** | Soft preference, used for scoring only |

**3. Filter and score** (`src/recommend.mjs`) — hard constraints filter, soft preferences score. The model never sees a venue that fails a hard constraint, so it cannot recommend one. Scoring weights attendance highest (a plan two people can attend beats a nicer plan one person can), then vibe match, time-of-day fit, and budget headroom. The final three are picked for genuine variety, not three versions of the same evening.

**4. Narrate** — Claude picks three from the pre-filtered shortlist and writes the rationale, naming whose constraint each option satisfies. If that call fails for any reason, deterministic sentences fill in and the group still gets three options.

**5. Act** — each option carries a Maps link, a booking or hours link, and a Google Calendar link with the date, time, and location pre-filled.

---

## Design decisions worth knowing

**The model never overrides a hard constraint.** Filtering happens in plain JavaScript before Claude sees anything. An LLM that hallucinates a wheelchair ramp is a safety problem, not a UX problem.

**No reviews, ratings, or stars — anywhere.** There is no rating field in the venue schema and no social proof in the UI, by design. Inventing a 4.6★ for a place nobody has been to is the single easiest way to make this product dishonest, so the data model makes it impossible rather than relying on discipline.

**Claims are labelled by how much we actually know.** Every line on an option card carries a `source`:

| | Rendered as | Meaning |
|---|---|---|
| `computed` | `✓ under $20/person` | We derived it from what people said. The arithmetic is ours and it is correct. |
| `listing` | `listed: step-free (for Marta)` | It came from the venue catalog. **We have not confirmed it.** |

Accessibility and dietary claims are always `listing`, and they are the two where being wrong actually hurts someone — a wheelchair user who can't get through the door, a coeliac who gets sick. They never get the green tick, and any option carrying one shows a confirm-with-the-venue line. If you swap in a real places feed, that labelling is what stops the app from asserting a building is step-free on the authority of a scraped tag.

**Everything degrades.** No key, rate limit, refusal, malformed JSON, truncated response — every failure path lands on deterministic output rather than an error page. The structured-output call also steps through parameter shapes (`output_config.format` → `output_format` → prompt-only JSON) and remembers which one the deployed API accepts, so it keeps working across API vintages.

**Chat context is memory-only.** The rolling buffer that lets the bot follow an argument is held in RAM, bounded, and never written to disk. A restart loses it. Those are other people's messages — persisting them is a liability nobody asked for.

**Preferences are private, results are shared.** A participant's raw preferences and chat transcript are only ever returned to that participant. Everyone else sees the merged group constraints and who asked for what — enough to understand the plan, not enough to see that Dennis said $15 was his limit.

**New information invalidates old plans.** Any chat message clears the computed options and votes. A plan built on stale constraints is worse than no plan.

---

## The venue catalog is sample data

`data/venues.json` contains illustrative venue *archetypes* — "Neighborhood Noodle House", "Quiet Corner Coffee House" — not real businesses. This is deliberate: shipping invented reviews or hours for real-sounding places would be worse than useless.

Booking links are generated as **live, city-scoped search URLs** (Google Maps search, OpenTable search, Resy search). They genuinely work and can't misdirect you to a listing that has moved or closed.

**Deliberately absent: any rating, review count, or star field.** Don't add one when you swap in real data unless you are passing through a real, attributed rating from the provider — a number the user can go and check.

To make it real, replace `data/venues.json` with a feed from Google Places, Yelp Fusion, or Foursquare, keeping the same shape:

```jsonc
{
  "id": "...", "name": "...", "category": "restaurant|activity|outdoor|cafe|culture",
  "cuisine": "italian",          // null for non-food
  "perPerson": 24,               // estimated spend per head
  "vibes": ["lively", "cozy"],           // must use terms from src/vocab.mjs VIBES
  "dietary": ["vegetarian", "gluten-free"],   // DIETARY
  "accessibility": ["step-free"],             // ACCESSIBILITY
  "noise": "low|medium|high", "setting": "indoor|outdoor",
  "goodFor": ["lunch", "dinner"],   // buckets from vocab.mjs TIME_BUCKETS
  "groupMin": 2, "groupMax": 12, "durationMins": 90,
  "booking": "opentable|resy|website|none",
  "ageFit": ["teen", "adult", "family", "senior"]
}
```

The vocabularies in `src/vocab.mjs` are the join keys between what people say and what venues are tagged with. Add a term to one side only and matching degrades silently — change both.

Monetary values are unitless in the data and rendered with `$`; the sample catalog is US-scale.

---

## API

| | | |
|---|---|---|
| `GET` | `/api/health` | Engine in use, default date window |
| `POST` | `/api/huddles` | `{title, city, groupType, partySize, windowStart, windowEnd, organizerName}` |
| `GET` | `/api/huddles/:id?me=<pid>` | Full state; `me` unlocks that participant's private prefs |
| `POST` | `/api/huddles/:id/join` | `{name}` → `{participantId}` |
| `POST` | `/api/huddles/:id/chat` | `{participantId, message}` → `{reply, prefs, done, huddle}` |
| `POST` | `/api/huddles/:id/finalize` | Computes the three options |
| `POST` | `/api/huddles/:id/vote` | `{participantId, optionId}` — one vote each |
| `POST` | `/api/huddles/:id/lock` | `{optionId}` → also returns a paste-ready line for the group chat |

Share link format: `/h/<huddleId>`.

---

## Layout

```
src/
  server.mjs      HTTP + routing + request validation + link-preview tags
  assistant.mjs   general Q&A with server-side web search
  budget.mjs      answer cache, per-chat daily caps, usage ledger
  chatlog.mjs     rolling per-chat context buffer (in memory, never on disk)
  bots/
    run.mjs       launcher — starts whichever adapters are configured
    bridge.mjs    platform-neutral group-chat brain (routes ask vs plan)
    telegram.mjs  Bot API long-poll, zero deps
    discord.mjs   discord.js gateway + buttons
    imessage.mjs  macOS relay: chat.db reader + AppleScript sender
  store.mjs       JSON-file persistence (atomic write-through)
  extract.mjs     free text -> structured preferences (Claude + heuristic fallback)
  consensus.mjs   N preference sets -> one group constraint object
  recommend.mjs   constraints + catalog -> 3 options
  links.mjs       Maps / booking / calendar URL builders
  vocab.mjs       controlled vocabularies (the join keys)
  timeutil.mjs    date + window arithmetic
  llm.mjs         Anthropic SDK wrapper, degrades to null on every failure
public/           single-page client, no build step
data/venues.json  sample catalog — replace for production
data/huddles.json created at runtime
```

## Before this is production

- **Storage**: `data/huddles.json` is single-process and rewritten on every mutation. Move to Postgres or SQLite past a handful of concurrent groups.
- **Auth**: participant identity is an unguessable ID in `localStorage`. Anyone with the share link can join under any name. Fine for a group of friends; not fine for anything with real stakes.
- **Real venues**: see above. Accessibility tags from places APIs are notoriously incomplete — treat them as a hint that ranks options, never as a promise to the person who needs the ramp. The `listing` labelling exists precisely so this stays honest at scale.
- **Live availability**: options say "check hours" because nothing here queries actual reservation inventory. OpenTable and Resy both have partner APIs for this.
- **Bot hosting**: `npm run bots` is a foreground process. For always-on, run it under `launchd`/`systemd`/a container. The iMessage relay additionally pins you to one always-awake Mac.
- **One huddle per chat**: a chat can only plan one thing at a time. `/cancel` then `/plan` to switch.
