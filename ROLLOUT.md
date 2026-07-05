# RuneScribe — 6-Day Rollout Plan

Goal: take RuneScribe from "runs on my machine" to a **public, shareable website** that the OSRS community can use, without blowing up the Claude bill. Six focused days.

Assumptions: one developer, a few hours per day, an Anthropic API key, and a hosting account (Render / Railway / Fly — all deploy a Node app from GitHub in minutes).

---

## Day 1 — Harden the server for the public internet
The app is a website already; today makes it *safe* to be one.

- [x] **Rate limiting** — per-IP sliding window (`RATE_LIMIT_PER_10_MIN`, default 15) so one visitor can't drain the API budget. *(done)*
- [x] **`/healthz`** endpoint for uptime monitors and platform health checks. *(done)*
- [x] **`trust proxy`** so client IPs are correct behind the host's load balancer. *(done)*
- [x] **Input caps** — reject requests whose combined history exceeds `MAX_INPUT_CHARS` (default 24k) with a friendly "start a fresh conversation" message; also validate message shape. *(done)*
- [x] **Turn cap per conversation** — client keeps the last 24 turns so long sessions don't grow unbounded. *(done)*
- [x] **Usage logging** — `LOG_USAGE=1` logs per-request input/output tokens and cache hits, for watching cost during beta. *(done)*
- [ ] **Cost guardrails** — set a monthly spend limit + email alert in the Anthropic Console. *(needs your Console login — the one manual must-do.)*

**End of day:** server is abuse-resistant. *(Verified: 413 on oversized payloads, 400 on malformed, 429 after the limit.)*

---

## Day 2 — Deploy to a real URL (staging)
- [x] **Deploy configs written** — `render.yaml`, `Procfile`, and `Dockerfile` + `.dockerignore` are in the repo, all pointing at `node server.js` with `/healthz`. *(done)*
- [x] **SSE anti-buffering** — the chat response sends `X-Accel-Buffering: no` and flushes headers, so tokens stream through nginx/Render-style proxies. *(done)*
- [ ] Create the hosting project (Render: New → Blueprint picks up `render.yaml`), point it at `main`.
- [ ] Set the one secret env var `ANTHROPIC_API_KEY` in the dashboard (the rest have defaults in `render.yaml`).
- [ ] First deploy → get a `*.onrender.com` URL. Smoke-test every path: a price check, a hiscores lookup, a **wiki search → read-page → section** flow, and an error case (misspelled player).
- [ ] Verify tokens arrive incrementally on the live URL (the anti-buffering header is set, but confirm on the real host).

**End of day:** a private URL you can share with a few friends.

---

## Day 3 — Polish + trust
- [x] **Landing clarity** — the intro message and the "fan project · not affiliated with Jagex" colophon are visible before first interaction; the sage links every wiki article it uses (CC-BY-SA attribution is intrinsic). *(done)*
- [x] **Empty/error states** — server returns friendly copy for unranked players, missing items, and wiki outages; the UI renders them as ember error lines. *(done)*
- [x] **Social preview** — Open Graph + Twitter tags with an absolute-URL `og-image.png` (star-chart hero, 1200×630) injected at serve time so Discord/Twitter previews render. *(done)*
- [ ] **Mobile pass on a real phone** — the star chart + drawer, tap targets, floating command line, keyboard behavior. *(Layout verified in-browser down to 420px; do a real-device pass.)*
- [ ] **Analytics-lite** — a privacy-friendly counter (Plausible/Umami), or extend the existing `LOG_USAGE` logging to count tool calls. No PII.

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
- [x] **Runbook written** — deploy/rollback, API-key rotation, and spend-spike response in [RUNBOOK.md](RUNBOOK.md). *(done)*
- [x] **Prompt caching** — `cache_control` sits on the system block, which renders after `tools`, so the whole static prefix (tools + persona) is cached together. Confirm hits with `LOG_USAGE=1` (`cache_read` > 0 on repeat requests). *(in place; verify live)*
- [ ] Burn down the top punch-list items from beta (prompt tweaks, wiki section matching, formatting).
- [ ] Tune the system prompt from real transcripts: tighten when the sage should scry vs. answer from memory (cuts unnecessary tool calls = cheaper + faster).
- [ ] Re-test the full matrix after changes; redeploy to staging.

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
