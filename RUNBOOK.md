# RuneScribe — Operations Runbook

Short, boring, and the thing you want when something's on fire.

## Deploy / rollback
- **Deploy:** push to `main`. If `autoDeploy` is on (see `render.yaml`), the host redeploys automatically. Otherwise trigger a deploy in the dashboard.
- **Roll back:** in the host dashboard, redeploy the previous successful build (Render/Railway keep deploy history) — or `git revert <bad-commit> && git push`. The health check is `/healthz`; a bad deploy that fails it won't take traffic.
- **Verify a deploy:** hit `/healthz` → `{ "ok": true, "apiKey": true }`. Then send one real question end-to-end.

## Rotate the API key
1. Create a new key in the [Anthropic Console](https://platform.claude.com).
2. Update `ANTHROPIC_API_KEY` in the host's env-var settings (secret).
3. Redeploy / restart so the new value is picked up.
4. Revoke the old key in the Console.
5. Confirm `/healthz` shows `apiKey: true` and a live question works.

## Spend spike / abuse
- **First move:** lower `RATE_LIMIT_PER_10_MIN` (e.g. to `5`) in env vars. Most hosts apply env changes without a code deploy.
- Tighten `MAX_INPUT_CHARS` if long conversations are the driver.
- Turn on `LOG_USAGE=1` to see per-request token + cache-hit numbers in the logs.
- If it's one IP hammering the app, block it at the host/CDN layer.
- **Nuclear option:** the spend limit set in the Anthropic Console caps the damage regardless of app state. This is why it's step one of the rollout.

## Third-party API failures
The app degrades gracefully — each tool returns a friendly error the model relays, so the site stays up even if a data source is down.
- **Hiscores / GE / Wiki down:** nothing to do; it self-heals when the upstream recovers. Users still get answers from the model's own knowledge.
- **Persistent GE failures:** the item-name→id map is cached in memory and retried on next call; a restart clears it.

## Key facts
- Single stateless Node process; no database. Restart is always safe.
- Rate-limit + GE-map state live in memory — a restart resets them (fine).
- Conversation history lives in the browser tab, never on the server.
- All env vars and their defaults: see `.env.example`.
