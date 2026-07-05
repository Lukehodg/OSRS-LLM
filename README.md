# 🧙 RuneScribe — an Old School RuneScape AI sage

RuneScribe is a chat app where **the Wise Old Man of Draynor Village** answers anything about Old School RuneScape — quests, skilling, bossing, gear, money makers — powered by **Claude (Opus 4.8)** with live game-data tools:

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
| `RATE_LIMIT_PER_10_MIN` | `15` | Max chat requests per IP per 10 minutes |
| `MAX_INPUT_CHARS` | `24000` | Max total conversation size per request (bounds token spend) |
| `LOG_USAGE` | `0` | Set to `1` to log per-request token usage + cache hits |

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
