# 🧙 RuneScribe — an Old School RuneScape AI sage

RuneScribe is a chat app where **the Wise Old Man of Draynor Village** answers anything about Old School RuneScape — quests, skilling, bossing, gear, money makers — powered by **Claude (Opus 4.8)**. It can also **watch your gameplay and coach your PvM** ([PvM Coach](#-pvm-coach-vision)) and chart a **personalised ironman progression from your live hiscores** ([Ironman Path](#️-ironman-path-personalised-progression)). Live game-data tools:

| Tool | Source | What it does |
|---|---|---|
| `get_player_stats` | Official OSRS hiscores | Live levels, XP, ranks, and boss KC for any player |
| `get_ge_price` | [prices.runescape.wiki](https://prices.runescape.wiki) | Real-time Grand Exchange prices, buy limits, alch values |
| `search_wiki` | [OSRS Wiki](https://oldschool.runescape.wiki) | Full-text search returning top articles with snippets |
| `read_wiki_page` | [OSRS Wiki](https://oldschool.runescape.wiki) | Opens an article — intro + section list, or one specific section (drop tables, quest requirements) |

### Deep wiki integration

The sage doesn't just get a search snippet — it can **read the actual article**. Given a question that needs precise facts (a drop rate, a quest's requirements, a recent update), it:

1. `search_wiki` to find the right article,
2. `read_wiki_page` (no section) to see the intro **and a map of every section**,
3. `read_wiki_page` again targeting the exact section (e.g. `Drops`, `Requirements`) to read that content,
4. answers with the real numbers and a link back to the article for verification.

This uses the OSRS Wiki's MediaWiki API (`list=search`, `parse&prop=sections`, `parse&prop=wikitext&section=N`). Wiki content is CC-BY-SA — the sage links every article it leans on, which keeps attribution intact.

## 🎥 PvM Coach (vision)

Click **PvM Coach** (top-left) and the sage can *watch your gameplay* and coach you:

1. **Share your game window** — the browser's screen-share picker (`getDisplayMedia`) lets you pick your RuneLite/OSRS window. Nothing is recorded.
2. **Play for a few seconds** — the page keeps a rolling buffer of the last 6 frames (one every ~2s, ~12s of play), downscaled to 900px to bound cost.
3. **Analyse** — the frames are sent to Claude's vision as a timeline. It reads prayers, HP, gear, inventory, spec energy, positioning and boss phase, then returns a structured coaching readout: *what I see · what you're doing well · where to improve · next step*.

The advice appears in the conversation panel, so you can ask follow-ups ("what prayer should I have had there?") in text afterward. Frames are only sent when you press **Analyse**; screen sharing requires a secure (HTTPS or localhost) connection.

Cost is bounded per analysis: at most `MAX_FRAMES` (6) downscaled frames (~8k input tokens), plus the per-IP rate limit.

**Grade my trip** — the coach also has a *Grade my trip* button that returns a headline **score out of 10** and a fair-examiner breakdown, for when you want a verdict rather than a lesson.

## ⚔️ Ironman Path (personalised progression)

A live, personalised answer to static gear-progression charts (like Ladlor's): instead of one fixed sequence for everyone, it reads **your** account.

1. Enter your RuneScape name → the server pulls your **live hiscores**.
2. A curated set of ~44 ironman milestones across 7 tracks (Foundations, Melee, Ranged, Magic, Slayer, Bossing, Skilling & Supplies) is coloured against your **real levels**:
   - **obtained** (you've marked it done — saved per-account in your browser),
   - **ready now** (requirements met, go get it),
   - **locked** — showing the exact gap (e.g. *Abyssal whip · Slayer 78/85*).
3. **Get my personalised plan** → your stats and milestone status are sent to the Wise Old Man, who returns a prioritised, ironman-aware plan grounded in your actual account (*where you are · do these next · on the horizon · grind for today*) — no "buy it off the GE" advice, because irons can't.

### 📟 GE Terminal (market analysis + AI forecast)

Clicking the **Exchange** constellation opens a Bloomberg-style **Grand Exchange terminal**:

- **Ticker search** over every tradeable item.
- **Live quote panel** — instant-buy/sell, **margin after the 2% GE sales tax** (capped 5m, none under 100gp), ROI, profit-per-buy-limit, 1h volume, high alch.
- **Interactive price + volume chart** — **line or candlestick**, with 5m / 1h / 6h / 24h timeframes (drawn on canvas from the wiki timeseries; coloured green/red by trend, volume bars beneath).
- **Screeners** — *Most Traded* (by 1h volume) and *Best Flips* (ranked by after-tax profit per buy-limit, filtered for liquidity), each clickable to load the item.
- **Watchlist** — ★ pin any item; the *Watch* tab lists them with live prices (saved per device).
- **Price alerts — server-side** — 🔔 set an alert (instant-buy / instant-sell / margin crosses a threshold). Alerts mirror to the server, where a central poller keeps evaluating them **even with every tab closed**: with notification permission you get a real **Web Push** to your device (VAPID keys auto-generated on first boot), and any fires you missed greet you as "while you were away" toasts on your next visit. Alerts re-arm once the condition clears; in-tab toasts still fire instantly while the terminal is open.
- **Portfolio tracker** — ⊕ log a buy on any quote (quantity + price, prefilled from the market); the *Port* tab prices your open positions live and shows **unrealised P/L after the 2% GE tax**, plus invested total. Hit *Sell* to realise a position at your fill price — realised profit accumulates per device.
- **◆ Analyse market** — the sage gives a trading-desk read (flip viability, liquidity, trend, risks).
- **◆ AI price forecast** — feeds the recent price/volume series to Claude for a structured near-term prediction (**Outlook ▲/▼/► + confidence**, likely range, drivers, and what would flip the call). It's framed honestly: a game economy driven by players and Jagex updates can't be truly predicted, so it's an informed read, never a guarantee.

Market data comes from [prices.runescape.wiki](https://prices.runescape.wiki) (`/latest`, `/1h`, `/timeseries`, `/mapping`), cached briefly server-side; the data endpoints use the free hiscores rate-limit bucket, and only the two AI actions draw on the model budget.

### 🏰 Clan Hall

A **Clans** constellation sits at the top of the chart. Any player can:

- **Register a clan** — name + description, optionally linked to a **Discord invite** and/or a **[Wise Old Man](https://wiseoldman.net) group** (the group id is validated live and its name/member-count shown). Registration returns a **clan key**, saved on that device — only the key-holder can manage the clan's events.
- **Discord announcements** — add a **Discord webhook** (at registration or later from *My events*) and RuneScribe posts to your server automatically: new events, bingo tile claims (with points and proof link), verifications, and every completed bingo line. The webhook URL is a posting capability, so it's stored server-side only — public responses never include it.
- **Run events** — *Boss of the Week*, *Skill of the Week*, or **Bingo**: a 5×5 board (free centre) generated on the spot — **AI-conjured to your theme** when an API key is configured ("mid-level ironman friendly", "raids week"…), from a built-in task pool otherwise. Up to 5 active events per clan, 1–30 day durations.
- **Browse** — every registered clan with its links and live events; bingo events show a live mini-board and open into **Bingo HQ**.

#### 🎲 Bingo HQ

Every bingo event opens as a full-screen event dashboard in the star-chart theme:

- **Board styles** — the creator picks the board's pitch: **Mixed** (a bit of everything), or **PvM at high / mid / low level** (raids-and-Inferno down to Obor-and-Mole). Each style has its own curated task pool, and AI-generated boards follow the same pitch.
- **Tiles with points & sprites** — each of the 24 tasks carries a point value (harder = more) and its OSRS Wiki item sprite; the centre is a free ★ tile. Points wear **drop-rarity colours** (common → legendary), so the board reads like a loot table.
- **Celebrations** — landing a claim bursts stars from the tile; completing a line drops a full **✦ BINGO ✦** banner with a star-rain over the board (and the constellation draws itself in).
- **Claims & verification** — any clan member claims a tile with their RSN (and an optional note); the **clan key-holder** verifies claims (◆) or removes bogus ones. Claimed tiles glow green, verified ones brighter.
- **Proof screenshots** — attach a proof link when claiming (a Discord/Imgur screenshot URL); it renders as a thumbnail right in the tile detail (other hosts show as a link).
- **Teams** — name 2–8 teams at event creation ("Bandos, Zamorak") and the board becomes a **race**: claims carry a team, tiles wear team-coloured tags, and a **Team Standings** panel tracks each team's points, tiles and completed lines. Your team choice is remembered between claims.
- **Stats strip** — points earned / possible, tiles completed with a progress bar, verified count, bingo lines.
- **Bingo lines** — all 5 rows, 5 columns, both diagonals, four corners and blackout, tracked live.
- **Contributors** — a points leaderboard of who's claimed what.
- **Live activity** — a feed of every claim and verification, with a ticking countdown to event end.
- **Filters** — All / Open / Claimed / Verified, plus a 45-second auto-refresh so the board stays live while open.

AI-generated boards also get AI-assigned points and sprites (the model emits `task | points | wiki_image` per tile).

Clans persist server-side in `data/clans.json`, price alerts in `data/alerts.json`, and Web Push keys in `data/vapid.json` (single-instance JSON store — swap for a real DB when it outgrows that; the directory is gitignored). Edit tokens and webhook URLs never appear in public responses.

### 🔗 Link Account (RuneLite-powered personal advice)

The **Link Account** launcher ties a real account to the chat:

1. **Skills** from the live hiscores.
2. **Quests & achievement diaries** via the **[WikiSync](https://runelite.net/plugin-hub/show/wikisync) RuneLite plugin** (the player installs it once; it publishes quest/diary state to `sync.runescape.wiki`, which the server reads).
3. **Bank (optional)** — paste from RuneLite's *Bank Memory* plugin; stored only in the browser.

Once linked, **every chat answer is tailored**: a compact digest (levels, quests done/in-progress, diaries, bank highlights) rides along with each request as an extra system block (after the cached prefix, so prompt caching still holds), and the sage is instructed never to recommend content you can't access or quests you've already finished. The launcher shows "`YourName` ✓" while linked; unlink any time.

> Honest note: there's no official RuneLite "bank API" — WikiSync (quests/diaries) and Bank Memory (clipboard export) are the community-standard bridges, which is exactly what this uses.

### Constellation pickers

Three constellations open an in-UI picker instead of firing a canned question: **Skilling** → all 23 skills (training guides), **Combat** → 18 iconic bosses (strategy, gear, requirements), **Quests** → 12 high-impact quests (requirements, walkthrough, rewards). Each tile uses its real OSRS Wiki icon (with emoji fallback); selecting one asks the sage about it. All three are driven by one config in `public/pickers.js` — adding another picker is just a new entry.

**Account-aware:** once you've loaded your RSN in Ironman Path, the pickers personalise — the skill picker shows your live level on every tile (gold ✦ at 99), the boss picker badges each boss **✓ ready** or shows your exact gap against recommended stats (e.g. *Kraken · Slayer 78/87*), and every picked question carries your levels so the sage tailors its answer to your account. The account is remembered on your device across visits.

---

Each milestone shows its real **OSRS Wiki item sprite** (loaded via the wiki's `Special:FilePath`), with an emoji fallback if an image can't load — so the board always renders cleanly. The milestone dataset lives in `public/ironman-data.json` (easy to extend; each entry's `img` is the wiki file name). Hiscores lookups use a separate, generous rate limit (`HISCORES_LIMIT_PER_10_MIN`) since they don't cost anything; only the AI plan draws on the model budget.

The interface is a **living star chart**: the Wise Old Man floats in a golden particle nebula at the center of a dark void, surrounded by six hand-grown constellations — Quests, Combat, Skilling, Exchange, Hiscores, Lore. Click a constellation (or type into the command line beneath the stars) and the conversation slides in as a translucent panel. The nebula brightens while he thinks and burns ember-orange while he scries live data.

## Quick start

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # from https://platform.claude.com
npm start
```

Then open **http://localhost:3000** and ask away.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — (required) | Your Claude API key |
| `OSRS_LLM_MODEL` | `claude-opus-4-8` | Any Claude model ID |
| `PORT` | `3000` | HTTP port |
| `RATE_LIMIT_PER_10_MIN` | `15` | Max model-backed requests (chat/coach/plan) per IP per 10 min |
| `HISCORES_LIMIT_PER_10_MIN` | `60` | Max hiscores lookups per IP per 10 min (free upstream) |
| `MAX_INPUT_CHARS` | `24000` | Max total conversation size per request (bounds token spend) |
| `MAX_FRAMES` | `6` | Max gameplay frames per PvM-coach analysis (bounds vision cost) |
| `LOG_USAGE` | `0` | Set to `1` to log per-request token usage + cache hits |
| `ALERT_POLL_MS` | `60000` | How often the server evaluates GE price alerts |
| `VAPID_SUBJECT` | `mailto:admin@runescribe.example` | Contact for Web Push (set to your real mailto:/URL before launch) |

## Deploying as a public website

RuneScribe is a single Node server that serves both the site and the API — deploy it to any Node host (Render, Railway, Fly, a VPS):

- Start command: `npm start` · Health check: `/healthz`
- Set `ANTHROPIC_API_KEY` (and optionally `OSRS_LLM_MODEL`, `RATE_LIMIT_PER_10_MIN`) as env vars.
- It respects `X-Forwarded-For` behind a proxy, so per-IP rate limiting works on hosted platforms.
- **Set a spend limit + alert in the Anthropic Console before going public.**

Ready-made deploy configs are included: `render.yaml` (Render blueprint), `Procfile` (Railway/Heroku), and a `Dockerfile` (Fly/VPS/any container host). Copy `.env.example` to `.env` for local runs.

See **[ROLLOUT.md](ROLLOUT.md)** for a concrete 6-day plan from local to public launch, and **[RUNBOOK.md](RUNBOOK.md)** for deploy/rollback, key rotation, and spend-spike response.

## How it works

- `server.js` — Express server. `POST /api/chat` runs a streaming agentic loop against the Claude Messages API: text deltas are forwarded to the browser as Server-Sent Events; when Claude calls a tool, the server executes it (hiscores / GE / wiki fetch), feeds the result back, and streaming continues — up to 8 tool rounds per turn. The system prompt (persona + tool policy) is cached with `cache_control`.
- `public/` — zero-dependency frontend. A canvas engine draws the star chart: seeded procedural constellations (stable per session, organic like a real star map), twinkling nodes, and a reactive center nebula whose speed, brightness and warmth track what the sage is doing (idle / pondering / scrying). Chat streams over SSE with a small built-in markdown renderer; tool calls appear as inline "scrying" lines in the transcript.

## Notes

- A fan project — not affiliated with Jagex. Data comes from the official hiscores and the community-run wiki APIs, with a proper `User-Agent` as their usage policies request.
- Conversation history lives in the browser tab; refresh for a clean slate.
