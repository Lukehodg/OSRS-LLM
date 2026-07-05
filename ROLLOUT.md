# RuneScribe — 6-Day Rollout Plan

Goal: take RuneScribe from "runs on my machine" to a **public, shareable website** that the OSRS community can use, without blowing up the Claude bill. Six focused days.

Assumptions: one developer, a few hours per day, an Anthropic API key, and a hosting account (Render / Railway / Fly — all deploy a Node app from GitHub in minutes).

---

## Day 1 — Harden the server for the public internet
The app is a website already; today makes it *safe* to be one.

- [x] **Rate limiting** — per-IP sliding window (`RATE_LIMIT_PER_10_MIN`, default 15) so one visitor can't drain the API budget. *(done)*
- [x] **`/healthz`** endpoint for uptime monitors and platform health checks. *(done)*
- [x] **`trust proxy`** so client IPs are correct behind the host's load balancer. *(done)*
- [ ] **Input caps** — reject requests whose combined history exceeds ~15k characters (return a friendly "let's start a fresh conversation" error) to bound token spend per call.
- [ ] **Turn cap per conversation** — soft-limit history length client-side (keep last N turns) so long sessions don't grow unbounded.
- [ ] **Cost guardrails** — set a monthly spend limit + email alert in the Anthropic Console. This is the real safety net.

**End of day:** server is abuse-resistant. Load-test locally with a simple loop; confirm 429s appear and the app recovers.

---

## Day 2 — Deploy to a real URL (staging)
- [ ] Create the hosting project, point it at the `main` branch, set the start command to `npm start` and health check to `/healthz`.
- [ ] Set env vars: `ANTHROPIC_API_KEY`, `OSRS_LLM_MODEL` (start on `claude-opus-4-8`), `RATE_LIMIT_PER_10_MIN`.
- [ ] First deploy → get a `*.onrender.com` (or similar) URL. Smoke-test every path: a price check, a hiscores lookup, a **wiki search → read-page → section** flow, and an error case (misspelled player).
- [ ] Confirm SSE streaming survives the host's proxy (some platforms buffer — verify tokens arrive incrementally, not all at once). If buffered, disable response buffering / enable HTTP/1.1 streaming per the platform's docs.

**End of day:** a private URL you can share with a few friends.

---

## Day 3 — Polish + trust
- [ ] **Landing clarity** — a one-line "what is this" and the "fan project, not affiliated with Jagex" line are visible before first interaction (protects against takedown risk; the OSRS Wiki content is CC-BY-SA — keep the article links so attribution is intrinsic).
- [ ] **Empty/error states** — friendly copy when a player is unranked, an item doesn't exist, or the wiki is down. (Server already returns these; make sure the UI shows them clearly.)
- [ ] **Mobile pass** — the star chart + drawer on a real phone. Tap targets, the floating command line, keyboard behavior.
- [ ] **Social preview** — Open Graph tags + a preview image (a screenshot of the star chart) so shared links look good in Discord/Twitter.
- [ ] **Analytics-lite** — a privacy-friendly counter (Plausible/Umami, or just log tool-call counts) to see what people ask. No PII.

**End of day:** it looks and feels finished to a first-time visitor.

---

## Day 4 — Closed beta with real players
- [ ] Share the staging URL in a small OSRS Discord / a handful of friends. Ask them to try to break it and to ask their *real* questions.
- [ ] Watch the logs live: which tools fire, where the model hesitates, what the wiki reader returns for gnarly pages (drop tables, quest requirement blocks).
- [ ] Collect a short list of concrete failures (wrong section matched, a price format that reads awkwardly, a persona that's too chatty).
- [ ] Track spend for the day → extrapolate a per-user cost. Decide if `claude-opus-4-8` stays or if some traffic should fall back to a cheaper model.

**End of day:** a prioritized punch-list from real usage, and a cost number.

---

## Day 5 — Fix, tune, and cost-optimize
- [ ] Burn down the top punch-list items (prompt tweaks, wiki section matching, formatting).
- [ ] **Prompt caching is already on** for the system prompt — confirm cache hits in `usage` and widen the cached prefix (tool definitions) if not.
- [ ] Tune the system prompt from real transcripts: tighten when the sage should scry vs. answer from memory (cuts unnecessary tool calls = cheaper + faster).
- [ ] Re-test the full matrix after changes; redeploy to staging.
- [ ] Write a tiny runbook: how to roll back a deploy, how to rotate the API key, what to do if spend spikes.

**End of day:** faster, cheaper, and boring-to-operate.

---

## Day 6 — Public launch
- [ ] Point a custom domain at the app (optional but makes it feel real) with HTTPS.
- [ ] Final pre-flight: health check green, rate limits sane, spend alert armed, error states verified, `main` = what's deployed.
- [ ] **Launch post** — a short write-up + the star-chart screenshot, posted where OSRS folks hang out (r/2007scape, a Discord, Twitter). Lead with the demo, credit the Wiki + hiscores + prices API.
- [ ] Monitor the first few hours: watch spend, watch for a single IP hammering it (tighten the rate limit live via env var if needed — no redeploy required if the platform supports it).
- [ ] Capture a v1.1 backlog from launch-day feedback and stop. Ship it.

**End of day:** RuneScribe is live and public.

---

## Cut-scope levers (if a day runs short)
- **Skip the custom domain** — the platform URL is fine for launch.
- **Skip analytics** — logs are enough for v1.
- **Narrow the beta** — 3 friends instead of a Discord still surfaces the big bugs.

## The two things that must not slip
1. **A spend limit + alert in the Anthropic Console** (Day 1). Everything else is polish; this is the one that can hurt.
2. **Working wiki attribution links** (Day 3). Keeps the fan project on the right side of the Wiki's CC-BY-SA license.
