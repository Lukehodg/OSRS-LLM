# 🧙 RuneScribe — an Old School RuneScape AI sage

RuneScribe is a chat app where **the Wise Old Man of Draynor Village** answers anything about Old School RuneScape — quests, skilling, bossing, gear, money makers — powered by **Claude (Opus 4.8)** with live game-data tools:

| Tool | Source | What it does |
|---|---|---|
| `get_player_stats` | Official OSRS hiscores | Live levels, XP, ranks, and boss KC for any player |
| `get_ge_price` | [prices.runescape.wiki](https://prices.runescape.wiki) | Real-time Grand Exchange prices, buy limits, alch values |
| `search_wiki` | [OSRS Wiki](https://oldschool.runescape.wiki) | Article summaries for drop rates, quest reqs, updates |

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

## How it works

- `server.js` — Express server. `POST /api/chat` runs a streaming agentic loop against the Claude Messages API: text deltas are forwarded to the browser as Server-Sent Events; when Claude calls a tool, the server executes it (hiscores / GE / wiki fetch), feeds the result back, and streaming continues — up to 8 tool rounds per turn. The system prompt (persona + tool policy) is cached with `cache_control`.
- `public/` — zero-dependency frontend. A canvas engine draws the star chart: seeded procedural constellations (stable per session, organic like a real star map), twinkling nodes, and a reactive center nebula whose speed, brightness and warmth track what the sage is doing (idle / pondering / scrying). Chat streams over SSE with a small built-in markdown renderer; tool calls appear as inline "scrying" lines in the transcript.

## Notes

- A fan project — not affiliated with Jagex. Data comes from the official hiscores and the community-run wiki APIs, with a proper `User-Agent` as their usage policies request.
- Conversation history lives in the browser tab; refresh for a clean slate.
