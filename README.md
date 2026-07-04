# 🧙 RuneScribe — an Old School RuneScape AI sage

RuneScribe is a chat app where **the Wise Old Man of Draynor Village** answers anything about Old School RuneScape — quests, skilling, bossing, gear, money makers — powered by **Claude (Opus 4.8)** with live game-data tools:

| Tool | Source | What it does |
|---|---|---|
| `get_player_stats` | Official OSRS hiscores | Live levels, XP, ranks, and boss KC for any player |
| `get_ge_price` | [prices.runescape.wiki](https://prices.runescape.wiki) | Real-time Grand Exchange prices, buy limits, alch values |
| `search_wiki` | [OSRS Wiki](https://oldschool.runescape.wiki) | Article summaries for drop rates, quest reqs, updates |

The interface is styled after the OSRS client itself: stone-and-gold panels, the parchment chatbox, quest-dialogue boxes for the old man's replies, purple "game message" lines while he scries, and flickering torchlight.

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
- `public/` — zero-dependency frontend. Streams the SSE feed, renders replies with a small built-in markdown renderer, and shows tool activity both in-chat (✦ purple scrying lines) and in the sidebar's Scrying Orb log.

## Notes

- A fan project — not affiliated with Jagex. Data comes from the official hiscores and the community-run wiki APIs, with a proper `User-Agent` as their usage policies request.
- Conversation history lives in the browser tab; refresh for a clean slate.
