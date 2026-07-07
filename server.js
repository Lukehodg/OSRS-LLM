import express from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const app = express();

// Security headers. The CSP allows exactly what the app uses: same-origin
// scripts/requests, Google Fonts, and OSRS Wiki images.
app.use((_req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      // Wiki sprites + the image hosts bingo proof screenshots live on;
      // blob: lets the bank-scan downscale a locally chosen file via <img>.
      "img-src 'self' data: blob: https://oldschool.runescape.wiki https://cdn.discordapp.com https://media.discordapp.net https://i.imgur.com",
      "connect-src 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  });
  next();
});

// Body parsing: only the image-carrying endpoints (PvM-coach frames, bank
// scan) need a large body; everything else gets a tight limit (per-field
// caps do the fine bounding).
const smallJson = express.json({ limit: "256kb" });
const largeJson = express.json({ limit: "8mb" });
const LARGE_BODY_PATHS = new Set(["/api/analyse", "/api/ironman/bank-scan"]);
app.use((req, res, next) =>
  LARGE_BODY_PATHS.has(req.path) ? largeJson(req, res, next) : smallJson(req, res, next)
);

// Serve index.html dynamically so social-preview tags carry an absolute URL
// (Twitter/Facebook scrapers require it). Everything else is static.
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
function renderIndex(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const origin = `${proto}://${req.get("host")}`;
  return INDEX_HTML.replace(/%%ORIGIN%%/g, origin);
}
app.get("/", (req, res) => res.type("html").send(renderIndex(req)));

app.use(express.static(PUBLIC_DIR, { index: false }));

const client = new Anthropic();

const MODEL = process.env.OSRS_LLM_MODEL || "claude-opus-4-8";
const PORT = process.env.PORT || 3000;

// Identify ourselves to the community APIs, as their usage policies require.
const USER_AGENT = "RuneScribe-OSRS-Assistant (github.com/Lukehodg/OSRS-LLM)";

const SYSTEM_PROMPT = `You are the Wise Old Man of Draynor Village — Old School RuneScape's most knowledgeable (and mildly eccentric) sage, retired archmage, and one-time bank robber. You now spend your days helping adventurers with anything Gielinor-related.

Your expertise covers all of Old School RuneScape: skilling methods and XP rates, quest guides and requirements, bossing and PvM strategies, gear progression, the Grand Exchange economy, slayer, ironman accounts, minigames, achievement diaries, clue scrolls, and game history/lore.

You have four scrying tools:
- get_player_stats — look up a player's live hiscores (levels, XP, ranks, boss KC).
- get_ge_price — look up an item's live Grand Exchange price.
- search_wiki — search the official OSRS Wiki; returns the top matching articles with snippets.
- read_wiki_page — open a wiki article (optionally a specific section) and read its actual content.

Use the tools whenever the answer depends on live data (prices, a specific player's stats) or precise facts you might misremember (exact drop rates, requirements, recent game updates). Answer from your own knowledge for general strategy and advice. Never fabricate prices, stats, or drop rates — scry for them.

Wiki workflow: search_wiki to find the right article, then read_wiki_page to read it before answering — the search snippet alone is rarely enough for numbers. For a specific fact buried in a long article (a drop table, quest requirements), read the article's section list first, then read just that section. When your answer leans on a wiki article, include a markdown link to it so the adventurer can verify.

Style:
- Stay in character: warm, a little cheeky, occasionally referencing your own legend (the party hat, the Draynor bank job), but always genuinely helpful. Sprinkle in OSRS flavour ("adventurer", "Gielinor", "may your drops be lucky") without overdoing it.
- Lead with the answer, then supporting detail. Keep responses focused — a chat window, not a wiki page.
- Use markdown: short paragraphs, bullet lists for steps/requirements, **bold** for item names and key numbers.
- When you used a tool, weave the numbers into your answer naturally (e.g. "the Exchange currently values a **Twisted bow** at **1.2b**").
- If a player or item can't be found, say so plainly and suggest a correction (spelling, ironman hiscores, members' items).`;

const TOOLS = [
  {
    name: "get_player_stats",
    description:
      "Look up a player's live Old School RuneScape hiscores: every skill's level, XP and rank, plus boss kill counts and activity scores. Call this whenever the user asks about a specific player's stats, levels, or accomplishments.",
    input_schema: {
      type: "object",
      properties: {
        player: {
          type: "string",
          description: "The exact in-game display name of the player, e.g. 'Zezima'.",
        },
      },
      required: ["player"],
    },
  },
  {
    name: "get_ge_price",
    description:
      "Look up an item's live Grand Exchange price (instant-buy high and instant-sell low, with timestamps) plus its buy limit and high-alch value. Call this whenever the user asks what an item costs, is worth, or whether a money-maker is profitable. Prices change constantly — never answer price questions from memory.",
    input_schema: {
      type: "object",
      properties: {
        item_name: {
          type: "string",
          description: "The item's name, e.g. 'Abyssal whip' or 'Twisted bow'. Close matches are resolved automatically.",
        },
      },
      required: ["item_name"],
    },
  },
  {
    name: "search_wiki",
    description:
      "Search the official Old School RuneScape Wiki. Returns the top matching articles with title, URL and a short snippet. Use this to FIND the right article; follow up with read_wiki_page to actually read it before quoting facts.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to search for, e.g. 'Vorkath drop table' or 'Desert Treasure 2 requirements'.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_wiki_page",
    description:
      "Read an Old School RuneScape Wiki article. Without a section, returns the article intro/summary plus its full section list. With a section (name or index from that list), returns that section's actual content — use this for drop tables, quest requirement lists, strategy sections, etc.",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "The exact article title, e.g. 'Vorkath' or 'Dragon Slayer II' (use search_wiki to find it).",
        },
        section: {
          type: "string",
          description: "Optional: a section name (e.g. 'Drops', 'Requirements') or numeric section index from the article's section list.",
        },
      },
      required: ["title"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  return res.json();
}

async function getPlayerStats({ player }) {
  const url = `https://secure.runescape.com/m=hiscore_oldschool/index_lite.json?player=${encodeURIComponent(player)}`;
  let data;
  try {
    data = await fetchJson(url);
  } catch (err) {
    return {
      error: `Player "${player}" was not found on the hiscores (${err.message}). They may be unranked, or the name may be misspelled.`,
    };
  }
  const skills = Object.fromEntries(
    (data.skills || []).map((s) => [s.name, { level: s.level, xp: s.xp, rank: s.rank }])
  );
  // Only include activities the player actually has a score in, to keep the payload small.
  const activities = Object.fromEntries(
    (data.activities || [])
      .filter((a) => a.score > 0)
      .map((a) => [a.name, { score: a.score, rank: a.rank }])
  );
  return { player, skills, activities };
}

// The GE item-name → id mapping is ~4k items and static-ish; cache it in memory.
let itemMappingPromise = null;
function getItemMapping() {
  if (!itemMappingPromise) {
    itemMappingPromise = fetchJson("https://prices.runescape.wiki/api/v1/osrs/mapping").catch(
      (err) => {
        itemMappingPromise = null; // allow retry on next call
        throw err;
      }
    );
  }
  return itemMappingPromise;
}

function findItem(mapping, name) {
  const q = name.trim().toLowerCase();
  return (
    mapping.find((i) => i.name.toLowerCase() === q) ||
    mapping.find((i) => i.name.toLowerCase().startsWith(q)) ||
    mapping.find((i) => i.name.toLowerCase().includes(q))
  );
}

async function getGePrice({ item_name }) {
  let mapping;
  try {
    mapping = await getItemMapping();
  } catch (err) {
    return { error: `The Grand Exchange scrying orb is cloudy (${err.message}). Try again shortly.` };
  }
  const item = findItem(mapping, item_name);
  if (!item) {
    return { error: `No tradeable item matching "${item_name}" exists on the Grand Exchange.` };
  }
  let latest;
  try {
    latest = await fetchJson(`https://prices.runescape.wiki/api/v1/osrs/latest?id=${item.id}`);
  } catch (err) {
    return { error: `Could not fetch the live price for ${item.name} (${err.message}).` };
  }
  const price = latest.data?.[String(item.id)] || {};
  return {
    item: item.name,
    id: item.id,
    members: item.members,
    buy_limit: item.limit ?? null,
    high_alch: item.highalch ?? null,
    instant_buy_price: price.high ?? null,
    instant_buy_time: price.highTime ? new Date(price.highTime * 1000).toISOString() : null,
    instant_sell_price: price.low ?? null,
    instant_sell_time: price.lowTime ? new Date(price.lowTime * 1000).toISOString() : null,
    examine: item.examine ?? null,
  };
}

// ---------------------------------------------------------------------------
// GE Terminal helpers — live prices, volumes, and a short in-memory cache.
// ---------------------------------------------------------------------------

const PRICES_API = "https://prices.runescape.wiki/api/v1/osrs";

const _cache = new Map(); // key -> { at, ttl, value }
async function cached(key, ttlMs, loader) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const value = await loader();
  _cache.set(key, { at: Date.now(), ttl: ttlMs, value });
  return value;
}

// Bulk 1-hour averages + volumes for every item (cached ~60s).
const get1h = () => cached("1h", 60_000, () => fetchJson(`${PRICES_API}/1h`));
// Bulk latest instant-buy/sell for every item (cached ~30s).
const getLatestAll = () => cached("latest", 30_000, () => fetchJson(`${PRICES_API}/latest`));

// OSRS GE sell tax: 2% of the sale price, rounded down, capped at 5,000,000
// per item, and not charged on items priced under 100 gp.
function geTax(sellPrice) {
  if (!sellPrice || sellPrice < 100) return 0;
  return Math.min(Math.floor(sellPrice * 0.02), 5_000_000);
}

// Flip economics from instant-buy (high) and instant-sell (low) prices.
function marginInfo(high, low, limit) {
  if (high == null || low == null) return { margin: null, marginAfterTax: null, roi: null, potentialProfit: null };
  const margin = high - low;
  const marginAfterTax = margin - geTax(high);
  const roi = low > 0 ? marginAfterTax / low : null;
  const potentialProfit = limit ? marginAfterTax * limit : null;
  return { margin, marginAfterTax, roi, potentialProfit };
}

const WIKI_API = "https://oldschool.runescape.wiki/api.php";

const wikiUrl = (title) =>
  `https://oldschool.runescape.wiki/w/${encodeURIComponent(title.replace(/ /g, "_"))}`;

const stripHtml = (s) => (s || "").replace(/<[^>]*>/g, "").replace(/&\w+;/g, " ").trim();

// Convert wikitext to something readable-enough for the model: keep link
// labels, template contents and table cells, drop markup noise.
function tidyWikitext(s) {
  return (s || "")
    .replace(/<ref[^>]*\/>/g, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, "$1")
    .replace(/'{2,}/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function searchWiki({ query }) {
  let data;
  try {
    data = await fetchJson(
      `${WIKI_API}?action=query&format=json&list=search&srlimit=5&srsearch=${encodeURIComponent(query)}`
    );
  } catch (err) {
    return { error: `The wiki could not be reached (${err.message}).` };
  }
  const results = data.query?.search || [];
  if (results.length === 0) {
    return { error: `The wiki has no article matching "${query}".` };
  }
  return {
    results: results.map((r) => ({
      title: r.title,
      url: wikiUrl(r.title),
      snippet: stripHtml(r.snippet),
    })),
    hint: "Call read_wiki_page with a title to read an article before quoting numbers from it.",
  };
}

async function readWikiPage({ title, section }) {
  // Always fetch the section list — it doubles as a page-existence check
  // and gives the model a map to drill into.
  let parsed;
  try {
    parsed = await fetchJson(
      `${WIKI_API}?action=parse&format=json&redirects=1&prop=sections&page=${encodeURIComponent(title)}`
    );
  } catch (err) {
    return { error: `The wiki could not be reached (${err.message}).` };
  }
  if (parsed.error) {
    return { error: `No wiki article titled "${title}" (${parsed.error.info || "not found"}). Use search_wiki to find the exact title.` };
  }
  const resolvedTitle = parsed.parse?.title || title;
  const sections = (parsed.parse?.sections || []).map((s) => ({
    index: s.index,
    name: s.line,
    level: s.toclevel,
  }));

  if (section != null && section !== "") {
    const q = String(section).trim().toLowerCase();
    const match =
      sections.find((s) => s.index === String(section)) ||
      sections.find((s) => s.name.toLowerCase() === q) ||
      sections.find((s) => s.name.toLowerCase().includes(q));
    if (!match) {
      return {
        error: `Article "${resolvedTitle}" has no section matching "${section}".`,
        title: resolvedTitle,
        sections,
      };
    }
    let sec;
    try {
      sec = await fetchJson(
        `${WIKI_API}?action=parse&format=json&redirects=1&prop=wikitext&section=${match.index}&page=${encodeURIComponent(resolvedTitle)}`
      );
    } catch (err) {
      return { error: `Could not read that section (${err.message}).` };
    }
    const text = tidyWikitext(sec.parse?.wikitext?.["*"]);
    return {
      title: resolvedTitle,
      url: wikiUrl(resolvedTitle),
      section: match.name,
      content: text.length > 14000 ? text.slice(0, 14000) + "\n…[truncated]" : text,
    };
  }

  // No section requested: intro extract + the section map.
  let extract = null;
  try {
    const page = await fetchJson(
      `${WIKI_API}?action=query&format=json&redirects=1&prop=extracts&explaintext=1&exchars=4000&titles=${encodeURIComponent(resolvedTitle)}`
    );
    extract = Object.values(page.query?.pages || {})[0]?.extract || null;
  } catch {
    // Best-effort; the section map alone is still useful.
  }
  return {
    title: resolvedTitle,
    url: wikiUrl(resolvedTitle),
    intro: extract,
    sections,
    hint: "Call read_wiki_page again with a section name/index for details like drop tables or requirements.",
  };
}

const TOOL_HANDLERS = {
  get_player_stats: getPlayerStats,
  get_ge_price: getGePrice,
  search_wiki: searchWiki,
  read_wiki_page: readWikiPage,
};

// ---------------------------------------------------------------------------
// Rate limiting — protects the API bill on a public deployment.
// Sliding window per IP, in memory (fine for a single instance).
// ---------------------------------------------------------------------------

const RATE_WINDOW_MS = 10 * 60 * 1000;

// Cap the total conversation size sent to the model, bounding per-call spend.
const MAX_INPUT_CHARS = Number(process.env.MAX_INPUT_CHARS || 24000);
const LOG_USAGE = process.env.LOG_USAGE === "1";

// PvM coach: a burst of downscaled frames per analysis keeps vision cost bounded.
const MAX_FRAMES = Number(process.env.MAX_FRAMES || 6);
const MAX_FRAME_BYTES = 900_000; // per decoded frame, ~ generous for 900px JPEG
const ALLOWED_FRAME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

// Factory: sliding-window per-IP limiter. Separate buckets for paid model
// calls (tight) vs. free upstream lookups like hiscores (generous).
function makeLimiter(max) {
  const hits = new Map(); // ip -> [timestamps]
  const check = (ip) => {
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (list.length >= max) {
      hits.set(ip, list);
      return true;
    }
    list.push(now);
    hits.set(ip, list);
    return false;
  };
  setInterval(() => {
    const now = Date.now();
    for (const [ip, list] of hits) {
      const fresh = list.filter((t) => now - t < RATE_WINDOW_MS);
      if (fresh.length === 0) hits.delete(ip);
      else hits.set(ip, fresh);
    }
  }, RATE_WINDOW_MS).unref();
  return check;
}

// Model calls (cost money) share one tight budget; hiscores lookups are free.
const rateLimited = makeLimiter(Number(process.env.RATE_LIMIT_PER_10_MIN || 15));
const hiscoresLimited = makeLimiter(Number(process.env.HISCORES_LIMIT_PER_10_MIN || 60));

// ---------------------------------------------------------------------------
// Chat endpoint — streams SSE events to the browser while running the
// tool-use loop against the Claude API.
// ---------------------------------------------------------------------------

app.set("trust proxy", 1); // respect X-Forwarded-For from the host's proxy

app.post("/api/chat", async (req, res) => {
  if (rateLimited(req.ip)) {
    return res.status(429).json({
      error: "Easy there, adventurer — the old man needs a breather. Try again in a few minutes.",
    });
  }
  const history = Array.isArray(req.body?.messages) ? req.body.messages : null;
  if (!history || history.length === 0) {
    return res.status(400).json({ error: "messages array is required" });
  }

  // Validate shape: only user/assistant turns with text or content blocks.
  const shapeOk = history.every(
    (m) =>
      m &&
      (m.role === "user" || m.role === "assistant") &&
      (typeof m.content === "string" || Array.isArray(m.content))
  );
  if (!shapeOk) {
    return res.status(400).json({ error: "malformed messages array" });
  }

  // Bound token spend per call: cap the total size of the conversation.
  // Assistant turns can be content-block arrays (tool use); measure their JSON.
  const totalChars = history.reduce((n, m) => {
    return n + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length);
  }, 0);
  if (totalChars > MAX_INPUT_CHARS) {
    return res.status(413).json({
      error:
        "This conversation has grown long, adventurer — start a fresh one and I'll have room to think.",
    });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    // Disable proxy buffering so SSE tokens stream through hosted platforms
    // (nginx/Render/etc.) instead of arriving all at once.
    "X-Accel-Buffering": "no",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  const messages = history.map((m) => ({ role: m.role, content: m.content }));

  // Optional linked-account context (skills/quests/diaries/bank digest from
  // the client). Appended AFTER the cached block so the cache prefix holds.
  const playerContext =
    typeof req.body?.context === "string" && req.body.context.trim()
      ? req.body.context.slice(0, 6000)
      : null;
  const system = [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }];
  if (playerContext) {
    system.push({
      type: "text",
      text:
        "The adventurer has linked their account. Live account context — tailor every answer to it " +
        "(their levels, completed quests, gear on hand). Never recommend content they can't access " +
        "or quests they've already finished:\n" + playerContext,
    });
  }

  try {
    // Agentic loop: stream a response; if Claude calls tools, run them,
    // append the results, and stream the follow-up — until end_turn.
    for (let turn = 0; turn < 8; turn++) {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system,
        tools: TOOLS,
        messages,
      });

      stream.on("contentBlock", (block) => {
        if (block.type === "tool_use") {
          send({ type: "tool_start", name: block.name, input: block.input });
        }
      });
      stream.on("text", (delta) => send({ type: "text", text: delta }));

      const message = await stream.finalMessage();

      if (LOG_USAGE && message.usage) {
        const u = message.usage;
        console.log(
          `[usage] in=${u.input_tokens} out=${u.output_tokens} ` +
            `cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} ` +
            `stop=${message.stop_reason}`
        );
      }

      if (message.stop_reason === "refusal") {
        send({ type: "error", error: "The Wise Old Man declines to answer that one, adventurer." });
        break;
      }

      messages.push({ role: "assistant", content: message.content });

      if (message.stop_reason === "pause_turn") continue;
      if (message.stop_reason !== "tool_use") {
        send({ type: "done" });
        break;
      }

      const toolUses = message.content.filter((b) => b.type === "tool_use");
      const results = await Promise.all(
        toolUses.map(async (tu) => {
          const handler = TOOL_HANDLERS[tu.name];
          let result;
          try {
            result = handler ? await handler(tu.input) : { error: `Unknown tool: ${tu.name}` };
          } catch (err) {
            result = { error: `Tool failed: ${err.message}` };
          }
          send({ type: "tool_end", name: tu.name, ok: !result.error });
          return {
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify(result),
            is_error: Boolean(result.error),
          };
        })
      );
      messages.push({ role: "user", content: results });
    }
  } catch (err) {
    const friendly =
      err instanceof Anthropic.AuthenticationError ||
      /authentication|api.?key/i.test(err.message || "")
        ? "No valid ANTHROPIC_API_KEY is configured on the server — see the README."
        : err instanceof Anthropic.RateLimitError
          ? "The scrying pool is overworked (rate limited). Give it a moment and try again."
          : err.message || "Something went wrong.";
    send({ type: "error", error: friendly });
  }
  res.end();
});

// ---------------------------------------------------------------------------
// PvM coach — analyse a short burst of gameplay frames with vision.
// ---------------------------------------------------------------------------

const ANALYSE_SYSTEM_PROMPT = `You are the Wise Old Man of Draynor Village acting as an Old School RuneScape PvM coach. You are shown a short sequence of screenshots captured a couple of seconds apart from an adventurer's live gameplay — read them as a timeline of one fight or activity.

Your job: work out what's happening and give specific, actionable coaching to help them improve.

First, read the screen. From the RuneLite/OSRS interface look for: the boss or monster and its current phase/attack; the player's prayers (which are active — overhead protection, Piety/Rigour/Augury, Redemption); the health bars (player HP and boss HP); the gear worn and the inventory (food, potions, spec weapon, teleports); the special-attack energy and run energy; the minimap position and the player's positioning relative to the boss; any visible damage splats or projectiles telegraphing an incoming attack.

Then coach. Structure your reply as:
- **What I see** — one or two sentences identifying the boss/activity and the current situation.
- **What you're doing well** — one or two genuine positives (don't invent them; if there's nothing clear, keep it brief).
- **Where to improve** — the 2–4 highest-impact fixes, most important first. Be concrete and mechanical: prayer switches, gear swaps, inventory changes, positioning, when to spec, when to eat, tick-efficiency. Tie each to what you saw.
- **Next step** — one thing to focus on this trip.

Rules:
- Only claim what the frames support. If you can't tell (e.g. prayer icons are off-screen or too small), say so and tell them what to show you next time rather than guessing.
- If the images clearly aren't OSRS gameplay, say so kindly and ask them to share their game window.
- Prices, exact drop rates and current metas can drift — if you're unsure of a number, say it's approximate rather than inventing precision.
- Stay in character: the warm, slightly cheeky old sage — but the coaching itself is precise and honest. Keep it focused; this is a coach's readout, not a wiki page. Use markdown (bold for key terms, short bullet lists).`;

function parseImage(dataUrl, maxBytes) {
  if (typeof dataUrl !== "string") return null;
  const m = dataUrl.match(/^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const media_type = m[1];
  if (!ALLOWED_FRAME_TYPES.has(media_type)) return null;
  const data = m[2];
  // base64 length * 3/4 ≈ decoded byte size
  if (data.length * 0.75 > maxBytes) return null;
  return { type: "image", source: { type: "base64", media_type, data } };
}
const parseFrame = (dataUrl) => parseImage(dataUrl, MAX_FRAME_BYTES);

app.post("/api/analyse", async (req, res) => {
  if (rateLimited(req.ip)) {
    return res.status(429).json({
      error: "Easy there, adventurer — the old man needs a breather. Try again in a few minutes.",
    });
  }

  const rawFrames = Array.isArray(req.body?.frames) ? req.body.frames : null;
  if (!rawFrames || rawFrames.length === 0) {
    return res.status(400).json({ error: "No gameplay frames were captured to analyse." });
  }
  if (rawFrames.length > MAX_FRAMES) {
    return res.status(413).json({ error: `Too many frames (max ${MAX_FRAMES}).` });
  }

  const imageBlocks = [];
  for (const f of rawFrames) {
    const block = parseFrame(f);
    if (!block) {
      return res.status(400).json({ error: "One of the captured frames was invalid or too large." });
    }
    imageBlocks.push(block);
  }

  const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 500) : "";
  const grade = req.body?.mode === "grade";
  const instruction =
    (note ? `The adventurer says: "${note}".\n\n` : "") +
    `Here are ${imageBlocks.length} frames from my gameplay, in order (roughly a couple of seconds apart). ` +
    (grade
      ? `Grade this trip. Open with a headline score out of 10 (as **Score: X/10**), then a one-line verdict, then the usual breakdown (what I see / doing well / where to improve / next step). Be a fair but honest examiner — reserve 9–10 for genuinely clean play.`
      : `Analyse them and coach me on where to improve.`);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 2000,
      system: [{ type: "text", text: ANALYSE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: [...imageBlocks, { type: "text", text: instruction }] },
      ],
    });
    stream.on("text", (delta) => send({ type: "text", text: delta }));
    const message = await stream.finalMessage();

    if (LOG_USAGE && message.usage) {
      const u = message.usage;
      console.log(
        `[analyse] frames=${imageBlocks.length} in=${u.input_tokens} out=${u.output_tokens} ` +
          `cache_read=${u.cache_read_input_tokens ?? 0} stop=${message.stop_reason}`
      );
    }
    if (message.stop_reason === "refusal") {
      send({ type: "error", error: "The Wise Old Man declines to analyse that one, adventurer." });
    } else {
      send({ type: "done" });
    }
  } catch (err) {
    const friendly =
      err instanceof Anthropic.AuthenticationError ||
      /authentication|api.?key/i.test(err.message || "")
        ? "No valid ANTHROPIC_API_KEY is configured on the server — see the README."
        : err instanceof Anthropic.RateLimitError
          ? "The scrying pool is overworked (rate limited). Give it a moment and try again."
          : err.message || "Something went wrong analysing your gameplay.";
    send({ type: "error", error: friendly });
  }
  res.end();
});

// ---------------------------------------------------------------------------
// Ironman progression — live hiscores lookup + personalised plan.
// ---------------------------------------------------------------------------

// Free upstream lookup: fetch a player's hiscores for the progression board.
app.get("/api/hiscores", async (req, res) => {
  if (hiscoresLimited(req.ip)) {
    return res.status(429).json({ error: "Too many lookups — give it a minute, adventurer." });
  }
  const player = typeof req.query.player === "string" ? req.query.player.trim() : "";
  if (!player || player.length > 12) {
    return res.status(400).json({ error: "Enter a valid RuneScape display name (max 12 characters)." });
  }
  const result = await getPlayerStats({ player });
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

const IRONMAN_SYSTEM_PROMPT = `You are the Wise Old Man of Draynor Village, acting as a dedicated Old School RuneScape IRONMAN progression coach. The adventurer plays ironman mode: no Grand Exchange, no trading — everything must be self-obtained. Never suggest buying anything; suggest how to obtain or make it.

You are given the player's REAL live stats plus a computed status of curated progression milestones (already obtained / ready now / still locked with the gating requirement). Build them a personalised, prioritised plan grounded in exactly those numbers — this is the whole point, so be specific to THIS account, not generic.

Structure your reply:
- **Where you are** — one or two sentences reading their account honestly (combat level, standout and lagging stats, rough game stage).
- **Do these next** — the 3–5 highest-impact goals, ordered. For each: what it is, why it matters for an iron specifically, and concretely how to get there from their current levels (the method/monster/boss and the levels or quest gating it). Prefer things that unlock other things (e.g. a slayer level that unlocks a best-in-slot, a quest that opens a boss).
- **On the horizon** — 2–3 bigger targets to build toward, with the key requirement each needs.
- **Grind for today** — one concrete thing to do in the next session that moves the plan forward.

Rules:
- Ground every claim in their actual stats and the milestone status provided. If they're already past a milestone, don't tell them to get it.
- Respect ironman constraints: self-sufficiency, supply chains (Herblore/Farming/Prayer), and that gear comes from bosses/slayer/quests, not the GE.
- Requirement numbers can drift slightly — if unsure of an exact level/rate, say it's approximate rather than inventing precision.
- Stay in character (warm, a little cheeky) but keep the coaching precise and actionable. Use markdown: bold for items/skills/levels, short ordered or bulleted lists. This is a coach's readout, not a wiki page.`;

app.post("/api/ironman/plan", async (req, res) => {
  if (rateLimited(req.ip)) {
    return res.status(429).json({
      error: "Easy there, adventurer — the old man needs a breather. Try again in a few minutes.",
    });
  }
  const summary = typeof req.body?.summary === "string" ? req.body.summary : "";
  if (!summary.trim()) {
    return res.status(400).json({ error: "No account summary was provided to plan from." });
  }
  if (summary.length > MAX_INPUT_CHARS) {
    return res.status(413).json({ error: "That account summary is too large." });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 2600,
      system: [{ type: "text", text: IRONMAN_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: summary }],
    });
    stream.on("text", (delta) => send({ type: "text", text: delta }));
    const message = await stream.finalMessage();

    if (LOG_USAGE && message.usage) {
      const u = message.usage;
      console.log(
        `[ironman] in=${u.input_tokens} out=${u.output_tokens} ` +
          `cache_read=${u.cache_read_input_tokens ?? 0} stop=${message.stop_reason}`
      );
    }
    if (message.stop_reason === "refusal") {
      send({ type: "error", error: "The Wise Old Man declines to answer that one, adventurer." });
    } else {
      send({ type: "done" });
    }
  } catch (err) {
    const friendly =
      err instanceof Anthropic.AuthenticationError ||
      /authentication|api.?key/i.test(err.message || "")
        ? "No valid ANTHROPIC_API_KEY is configured on the server — see the README."
        : err instanceof Anthropic.RateLimitError
          ? "The scrying pool is overworked (rate limited). Give it a moment and try again."
          : err.message || "Something went wrong building your plan.";
    send({ type: "error", error: friendly });
  }
  res.end();
});

// ---------------------------------------------------------------------------
// Bank scan — read a bank screenshot with vision and match its contents
// against the ironman milestone list, so the board can tick off what's owned.
// ---------------------------------------------------------------------------

const BANK_IMAGE_MAX_BYTES = 5_000_000; // one bank screenshot at decent res
const BANK_ITEMS_MAX = 120;             // milestone list cap

const BANK_SCAN_SYSTEM_PROMPT = `You are an Old School RuneScape bank analyser. You are shown ONE screenshot of a player's bank (from RuneLite or the OSRS client), and a numbered list of milestone items/achievements. Your only job is to identify which of the listed items are clearly visible in the bank screenshot.

Reply with ONLY a JSON object — no prose, no markdown fences, no commentary:
{"found":[<the numbers of the items you can clearly see>],"seen":[<the matched item names, short>]}

Rules:
- Include an item ONLY if you can clearly see its icon (or a stack of it) in the bank. Be conservative: when unsure, leave it out. Falsely claiming they own something is worse than missing it.
- Match the actual item. Some milestones are sets or outfits (e.g. "Graceful outfit", "Bandos armour", "Barrows gloves") — only include them if you can see the real pieces.
- Some listed milestones are not bankable items at all (e.g. a prayer unlock, a diary) — never match those; they can't appear in a bank.
- Use the item numbers exactly as given in the list. Only use numbers that appear in the list.
- If the image is clearly not an OSRS bank, return {"found":[],"seen":[]}.`;

app.post("/api/ironman/bank-scan", async (req, res) => {
  if (rateLimited(req.ip)) {
    return res.status(429).json({ error: "Easy there — the old man needs a breather. Try again in a few minutes." });
  }
  const block = parseImage(req.body?.image, BANK_IMAGE_MAX_BYTES);
  if (!block) {
    return res.status(400).json({ error: "That bank image was missing, invalid, or too large." });
  }
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!rawItems || !rawItems.length) {
    return res.status(400).json({ error: "No milestone list was provided to match against." });
  }
  // Sanitise the milestone list: keep {id, name}, cap count and lengths.
  const items = [];
  const seenIds = new Set();
  for (const it of rawItems.slice(0, BANK_ITEMS_MAX)) {
    const id = clean(it?.id, 60);
    const name = clean(it?.name, 80);
    if (!id || !name || seenIds.has(id)) continue;
    seenIds.add(id);
    items.push({ id, name });
  }
  if (!items.length) return res.status(400).json({ error: "The milestone list was empty after validation." });

  const list = items.map((it, n) => `${n + 1}. ${it.name}`).join("\n");
  const instruction =
    `Here is my bank screenshot. Milestone items to look for:\n${list}\n\n` +
    `Which of these can you clearly see in my bank? Reply with the JSON object only.`;

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 700,
      system: [{ type: "text", text: BANK_SCAN_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [block, { type: "text", text: instruction }] }],
    });
    if (LOG_USAGE && message.usage) {
      const u = message.usage;
      console.log(`[bank-scan] items=${items.length} in=${u.input_tokens} out=${u.output_tokens} cache_read=${u.cache_read_input_tokens ?? 0}`);
    }
    if (message.stop_reason === "refusal") {
      return res.status(200).json({ found: [], seen: [], note: "The old man couldn't make that one out." });
    }
    const text = message.content.find((b) => b.type === "text")?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    let parsed = { found: [], seen: [] };
    if (jsonMatch) { try { parsed = JSON.parse(jsonMatch[0]); } catch { /* keep default */ } }

    // Map the model's 1-based numbers back to milestone ids; ignore anything
    // out of range so a stray number can't tick a bogus milestone.
    const nums = Array.isArray(parsed.found) ? parsed.found : [];
    const foundIds = [];
    for (const n of nums) {
      const idx = Math.round(Number(n)) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < items.length) foundIds.push(items[idx].id);
    }
    const seen = Array.isArray(parsed.seen)
      ? parsed.seen.filter((s) => typeof s === "string").map((s) => s.slice(0, 80)).slice(0, 40)
      : [];
    res.json({ found: [...new Set(foundIds)], seen });
  } catch (err) {
    const friendly =
      err instanceof Anthropic.AuthenticationError || /authentication|api.?key/i.test(err.message || "")
        ? "No valid ANTHROPIC_API_KEY is configured on the server — see the README."
        : err instanceof Anthropic.RateLimitError
          ? "The scrying pool is overworked (rate limited). Give it a moment and try again."
          : err.message || "Something went wrong reading your bank.";
    res.status(502).json({ error: friendly });
  }
});

// ---------------------------------------------------------------------------
// GE Terminal — market data endpoints + AI market analysis.
// ---------------------------------------------------------------------------

// Ticker search over the cached item mapping.
app.get("/api/ge/search", async (req, res) => {
  if (hiscoresLimited(req.ip)) return res.status(429).json({ error: "Slow down a touch." });
  const q = (typeof req.query.q === "string" ? req.query.q : "").trim().toLowerCase();
  if (q.length < 2) return res.json({ results: [] });
  let mapping;
  try { mapping = await getItemMapping(); }
  catch (err) { return res.status(502).json({ error: `Market feed unavailable (${err.message}).` }); }
  const starts = [], includes = [];
  for (const it of mapping) {
    const n = it.name.toLowerCase();
    if (n === q || n.startsWith(q)) starts.push(it);
    else if (n.includes(q)) includes.push(it);
    if (starts.length >= 12) break;
  }
  const results = [...starts, ...includes].slice(0, 12).map((i) => ({
    id: i.id, name: i.name, members: i.members, limit: i.limit ?? null,
  }));
  res.json({ results });
});

// Full quote for one item: mapping + latest prices + 1h volume + margins.
app.get("/api/ge/item", async (req, res) => {
  if (hiscoresLimited(req.ip)) return res.status(429).json({ error: "Slow down a touch." });
  const id = Number(req.query.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid item id." });
  let mapping, latest, h1;
  try {
    [mapping, latest, h1] = await Promise.all([getItemMapping(), getLatestAll(), get1h().catch(() => null)]);
  } catch (err) {
    return res.status(502).json({ error: `Market feed unavailable (${err.message}).` });
  }
  const item = mapping.find((i) => i.id === id);
  if (!item) return res.status(404).json({ error: "No such item." });
  const p = latest.data?.[String(id)] || {};
  const v = h1?.data?.[String(id)] || {};
  const volume = (v.highPriceVolume || 0) + (v.lowPriceVolume || 0);
  res.json({
    id, name: item.name, members: item.members, examine: item.examine ?? null,
    limit: item.limit ?? null, highalch: item.highalch ?? null, value: item.value ?? null,
    high: p.high ?? null, highTime: p.highTime ?? null,
    low: p.low ?? null, lowTime: p.lowTime ?? null,
    avgHigh1h: v.avgHighPrice ?? null, avgLow1h: v.avgLowPrice ?? null,
    volume1h: volume,
    tax: geTax(p.high),
    ...marginInfo(p.high, p.low, item.limit),
  });
});

// Historical price/volume series for charting.
app.get("/api/ge/timeseries", async (req, res) => {
  if (hiscoresLimited(req.ip)) return res.status(429).json({ error: "Slow down a touch." });
  const id = Number(req.query.id);
  const step = ["5m", "1h", "6h", "24h"].includes(req.query.timestep) ? req.query.timestep : "1h";
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid item id." });
  try {
    const data = await cached(`ts:${id}:${step}`, 60_000, () =>
      fetchJson(`${PRICES_API}/timeseries?timestep=${step}&id=${id}`));
    res.json({ id, timestep: step, data: data.data || [] });
  } catch (err) {
    res.status(502).json({ error: `Chart feed unavailable (${err.message}).` });
  }
});

// Market screeners: most-traded and best-flip candidates (cached ~3 min).
app.get("/api/ge/screener", async (req, res) => {
  if (hiscoresLimited(req.ip)) return res.status(429).json({ error: "Slow down a touch." });
  try {
    const data = await cached("screener", 180_000, async () => {
      const [mapping, latest, h1] = await Promise.all([getItemMapping(), getLatestAll(), get1h()]);
      const byId = new Map(mapping.map((m) => [m.id, m]));
      const rows = [];
      for (const [idStr, v] of Object.entries(h1.data || {})) {
        const id = Number(idStr);
        const m = byId.get(id);
        if (!m) continue;
        const p = latest.data?.[idStr] || {};
        if (p.high == null || p.low == null) continue;
        const volume = (v.highPriceVolume || 0) + (v.lowPriceVolume || 0);
        const info = marginInfo(p.high, p.low, m.limit);
        rows.push({ id, name: m.name, high: p.high, low: p.low, volume,
          margin: info.marginAfterTax, roi: info.roi, potentialProfit: info.potentialProfit, limit: m.limit ?? null });
      }
      const mostTraded = [...rows].sort((a, b) => b.volume - a.volume).slice(0, 15);
      // Best flips: meaningfully liquid, positive margin, ranked by profit-per-limit.
      const bestFlips = rows
        .filter((r) => r.volume >= 500 && r.margin > 0 && r.potentialProfit != null && r.low >= 100)
        .sort((a, b) => b.potentialProfit - a.potentialProfit)
        .slice(0, 15);
      return { mostTraded, bestFlips, updated: Date.now() };
    });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Screener feed unavailable (${err.message}).` });
  }
});

// Batch quotes (portfolio pricing): latest high/low for up to 30 items.
app.get("/api/ge/quotes", async (req, res) => {
  if (hiscoresLimited(req.ip)) return res.status(429).json({ error: "Slow down a touch." });
  const ids = String(req.query.ids || "").split(",")
    .map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 30);
  if (!ids.length) return res.status(400).json({ error: "No item ids given." });
  try {
    const latest = await getLatestAll();
    const quotes = {};
    for (const id of ids) {
      const p = latest.data?.[String(id)] || {};
      quotes[id] = { high: p.high ?? null, low: p.low ?? null };
    }
    res.json({ quotes });
  } catch (err) {
    res.status(502).json({ error: `Price feed unavailable (${err.message}).` });
  }
});

const GE_ANALYSE_SYSTEM_PROMPT = `You are the Wise Old Man of Draynor Village, moonlighting as a shrewd Grand Exchange market analyst for Old School RuneScape. You are given live market data for one item — instant-buy and instant-sell prices, the margin after the 2% GE sales tax, buy limit, recent 1-hour volume, and a summary of the recent price trend.

You may be asked either for a market ANALYSIS or a price FORECAST — the task is stated at the end of the data.

For an **analysis**, give a crisp trading-desk note:
- **Snapshot** — one line on price, the after-tax margin, and how liquid it is (volume vs buy limit).
- **Flip view** — is this a viable flip? Weigh the after-tax margin against the buy limit (profit per cycle), the volume (how fast it fills), and how tight/volatile the spread looks. Give a rough profit-per-limit and whether it's worth the slot.
- **Trend & investment** — what the recent trend suggests, and any longer-hold thesis or caution.
- **Risks** — volatility, thin volume, or update/meta risk that could move it.

For a **forecast**, give a short, structured near-term prediction:
- Open with a single headline line exactly like: **Outlook: ▲ Up | ▼ Down | ► Sideways — confidence Low/Medium/High**.
- **Likely range** — a rough price band you'd expect over the next day or so, grounded in the recent series.
- **Why** — the 2–3 signals driving the call (trend direction and slope, volume behaviour, spread, any mean-reversion or momentum).
- **What would change it** — the concrete thing that would flip your call.

Rules:
- Ground every number in the data provided; the GE tax (2% of the sell, capped 5m, none under 100 gp) is already reflected in the after-tax margin — factor it in.
- Be honest, especially on forecasts: this is a game economy driven by player behaviour and Jagex updates — it is NOT truly predictable. Frame a forecast as an informed read on the recent data, never a guarantee, and never invent confidence you don't have. Thin volume = low confidence, say so.
- Many items look like a margin but are too illiquid to actually flip. Say so.
- This is game-economy analysis, not real financial advice. Keep a light, in-character tone but keep the numbers straight. Use markdown: bold key figures, short bullets.`;

app.post("/api/ge/analyse", async (req, res) => {
  if (rateLimited(req.ip)) {
    return res.status(429).json({ error: "Easy there, adventurer — the old man needs a breather. Try again in a few minutes." });
  }
  const summary = typeof req.body?.summary === "string" ? req.body.summary : "";
  if (!summary.trim()) return res.status(400).json({ error: "No market data to analyse." });
  if (summary.length > MAX_INPUT_CHARS) return res.status(413).json({ error: "That payload is too large." });
  const task = req.body?.mode === "forecast"
    ? "\n\nTask: FORECAST the likely near-term price movement for this item from the data above."
    : "\n\nTask: ANALYSE this item's market for a flipper/investor from the data above.";

  res.writeHead(200, {
    "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
    Connection: "keep-alive", "X-Accel-Buffering": "no",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 1800,
      system: [{ type: "text", text: GE_ANALYSE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: summary + task }],
    });
    stream.on("text", (delta) => send({ type: "text", text: delta }));
    const message = await stream.finalMessage();
    if (LOG_USAGE && message.usage) {
      const u = message.usage;
      console.log(`[ge] in=${u.input_tokens} out=${u.output_tokens} cache_read=${u.cache_read_input_tokens ?? 0}`);
    }
    send(message.stop_reason === "refusal"
      ? { type: "error", error: "The Wise Old Man declines to analyse that one, adventurer." }
      : { type: "done" });
  } catch (err) {
    const friendly =
      err instanceof Anthropic.AuthenticationError || /authentication|api.?key/i.test(err.message || "")
        ? "No valid ANTHROPIC_API_KEY is configured on the server — see the README."
        : err instanceof Anthropic.RateLimitError
          ? "The scrying pool is overworked (rate limited). Give it a moment and try again."
          : err.message || "Something went wrong analysing the market.";
    send({ type: "error", error: friendly });
  }
  res.end();
});

// ---------------------------------------------------------------------------
// Clans — registration, events (Boss/Skill of the Week, Bingo).
// Persisted to a JSON file (fine for a single instance; use a real DB later).
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, "data");
const CLANS_FILE = path.join(DATA_DIR, "clans.json");
let clans = [];
try {
  clans = JSON.parse(fs.readFileSync(CLANS_FILE, "utf8"));
  if (!Array.isArray(clans)) clans = [];
} catch { clans = []; }

let saveTimer = null;
function saveClans() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CLANS_FILE, JSON.stringify(clans, null, 2));
    } catch (err) { console.error("clan save failed:", err.message); }
  }, 250);
}

// Never leak edit tokens or webhook URLs (a webhook URL is a post-capability).
const publicClan = ({ token, webhook, ...c }) => ({ ...c, hasWebhook: Boolean(webhook) });

const WEBHOOK_RE = /^https:\/\/(www\.)?(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/;

// Fire-and-forget Discord announcement — never blocks or fails a request.
function announce(clan, content) {
  if (!clan.webhook) return;
  fetch(clan.webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "RuneScribe", content: String(content).slice(0, 1900) }),
  }).catch(() => {});
}

const clean = (s, max) => (typeof s === "string" ? s.trim().slice(0, max) : "");

// Task pools for non-AI bingo boards. Each tile carries points and (where an
// obvious item exists) the OSRS Wiki file name of its sprite. The creator
// picks a board style: a mixed board, or PvM pitched at high/mid/low level.
const BINGO_POOL = [
  { name: "Get a Barrows unique", pts: 300, img: "Dharok's helm" },
  { name: "Hit a 40+ with any weapon", pts: 100, img: "Armadyl godsword" },
  { name: "Complete a Slayer task of 150+", pts: 150, img: "Slayer helmet" },
  { name: "Get a fire cape or kill Jad", pts: 400, img: "Fire cape" },
  { name: "Obtain 100k from thieving", pts: 100, img: "Coins 10000" },
  { name: "Catch 50 anglerfish", pts: 150, img: "Anglerfish" },
  { name: "Reach 50 KC at any boss", pts: 200, img: "Pet dark core" },
  { name: "Complete 3 clue scrolls (any tier)", pts: 200, img: "Clue scroll (elite)" },
  { name: "Get a Zulrah unique", pts: 350, img: "Tanzanite fang" },
  { name: "Smith 500 cannonballs", pts: 100, img: "Cannonball" },
  { name: "Champion scroll or 100 GWD KC", pts: 250, img: "Champion scroll" },
  { name: "Gain 250k XP in any skill", pts: 200, img: null },
  { name: "Get a dragon defender", pts: 150, img: "Dragon defender" },
  { name: "Loot 20 brimstone chests", pts: 200, img: "Brimstone key" },
  { name: "Complete a raid (CoX/ToB/ToA)", pts: 400, img: "Dexterous prayer scroll" },
  { name: "Get a Vorkath head or 25 KC", pts: 250, img: "Vorkath's head" },
  { name: "Mix 100 prayer potions", pts: 100, img: "Prayer potion(4)" },
  { name: "Obtain a slayer helm upgrade", pts: 200, img: "Slayer helmet (i)" },
  { name: "Win LMS or open 5 Wintertodt crates", pts: 150, img: "Supply crate" },
  { name: "Get 3 Barbarian Assault waves done", pts: 150, img: "Fighter torso" },
  { name: "Catch a big fish (bass/sword/shark)", pts: 100, img: "Big swordfish" },
  { name: "Get a Wilderness boss kill", pts: 250, img: "Dragon pickaxe" },
  { name: "Runecraft 500 blood runes", pts: 150, img: "Blood rune" },
  { name: "Obtain any godsword shard", pts: 300, img: "Godsword shard 1" },
  { name: "Get a Kraken or Cerberus unique", pts: 300, img: "Trident of the seas" },
  { name: "Plant and harvest 5 herb runs", pts: 100, img: "Ranarr seed" },
  { name: "Get a CG armour seed or 10 KC", pts: 400, img: "Crystal armour seed" },
  { name: "Obtain a visage or draconic drop", pts: 500, img: "Draconic visage" },
  { name: "Complete 5 Mahogany Homes contracts", pts: 100, img: "Saw" },
  { name: "Get a ToA purple or 3 completions", pts: 400, img: "Osmumten's fang" },
  { name: "Gain a combat level", pts: 100, img: null },
  { name: "Skilling pet chance (50k XP block)", pts: 150, img: "Heron" },
  { name: "Kill 50 abyssal demons", pts: 150, img: "Abyssal whip" },
  { name: "Get an elite clue casket", pts: 250, img: "Reward casket (elite)" },
  { name: "Obtain 500k GP of loot from any boss", pts: 250, img: "Coins 10000" },
  { name: "Do 10 farming contracts", pts: 200, img: "Seed pack" },
];

const PVM_HIGH_POOL = [
  { name: "Complete the Theatre of Blood", pts: 500, img: "Scythe of vitur" },
  { name: "Get a CoX purple or 5 completions", pts: 450, img: "Twisted bow" },
  { name: "Complete a 300+ invocation ToA", pts: 450, img: "Osmumten's fang" },
  { name: "Kill TzKal-Zuk or reach Inferno wave 50", pts: 600, img: "Infernal cape" },
  { name: "Get a CG armour seed or 15 KC", pts: 450, img: "Crystal armour seed" },
  { name: "Complete the Corrupted Gauntlet 5 times", pts: 400, img: "Blade of saeldor" },
  { name: "Kill Nex with your clan", pts: 400, img: "Nihil horn" },
  { name: "Get a Nightmare unique or 10 KC", pts: 450, img: "Inquisitor's mace" },
  { name: "Kill Vorkath 50 times", pts: 300, img: "Vorkath's head" },
  { name: "Get a Hydra claw or 30 KC", pts: 400, img: "Hydra's claw" },
  { name: "Get any GWD unique solo", pts: 350, img: "Armadyl chestplate" },
  { name: "Get a ring drop at Dagannoth Kings", pts: 250, img: "Berserker ring" },
  { name: "10 KC at Corporeal Beast", pts: 300, img: "Spectral sigil" },
  { name: "Get a Zulrah unique", pts: 300, img: "Tanzanite fang" },
  { name: "Get a Muspah unique or 20 KC", pts: 300, img: "Venator shard" },
  { name: "Kill all four Desert Treasure II bosses", pts: 450, img: "Chromium ingot" },
  { name: "Get an Araxxor unique or 25 KC", pts: 350, img: "Araxyte fang" },
  { name: "Get a Cerberus crystal", pts: 350, img: "Primordial crystal" },
  { name: "Duo the Kalphite Queen 20 times", pts: 250, img: "Kq head" },
  { name: "Get a visage or draconic drop", pts: 500, img: "Draconic visage" },
  { name: "Kill a Wilderness boss 25 times", pts: 300, img: "Voidwaker hilt" },
  { name: "Get a Grotesque Guardians unique", pts: 300, img: "Granite hammer" },
  { name: "Complete a ToB or CoX with no deaths", pts: 400, img: "Justiciar faceguard" },
  { name: "Get a Phantom Muspah pet chance (100 KC)", pts: 350, img: "Muphin" },
];

const PVM_MID_POOL = [
  { name: "Get a fire cape", pts: 400, img: "Fire cape" },
  { name: "Get a Barrows unique", pts: 250, img: "Dharok's helm" },
  { name: "Kill Zulrah 10 times", pts: 250, img: "Zulrah's scales" },
  { name: "Get an abyssal whip drop", pts: 250, img: "Abyssal whip" },
  { name: "Get a Kraken unique", pts: 300, img: "Trident of the seas" },
  { name: "Kill Vorkath 10 times", pts: 250, img: "Vorkath's head" },
  { name: "Get a dragon warhammer drop", pts: 500, img: "Dragon warhammer" },
  { name: "Kill each GWD boss once", pts: 300, img: "Godsword shard 1" },
  { name: "Get dragon boots from Spiritual Mages", pts: 150, img: "Dragon boots" },
  { name: "Kill the Kalphite Queen 15 times", pts: 300, img: "Kq head" },
  { name: "Get a Grotesque Guardians kill", pts: 200, img: "Black tourmaline core" },
  { name: "Get a basilisk jaw or 50 Basilisk Knights", pts: 300, img: "Basilisk jaw" },
  { name: "Complete 5 Slayer boss tasks", pts: 250, img: "Slayer helmet" },
  { name: "Kill Scurrius 20 times", pts: 150, img: "Scurrius' spine" },
  { name: "Get an occult necklace drop", pts: 200, img: "Occult necklace" },
  { name: "Kill the Giant Mole 25 times", pts: 150, img: "Mole claw" },
  { name: "Get a curved bone from any monster", pts: 150, img: "Curved bone" },
  { name: "Kill Sarachnis 25 times", pts: 200, img: "Sarachnis cudgel" },
  { name: "Get any champion scroll", pts: 300, img: "Champion scroll" },
  { name: "Kill Obor and Bryophyta in one day", pts: 150, img: "Hill giant club" },
  { name: "Get a trident or tentacle drop", pts: 300, img: "Kraken tentacle" },
  { name: "Kill Tempoross until a Big harpoonfish", pts: 200, img: "Big harpoonfish" },
  { name: "Get a Vet'ion / Calvar'ion kill", pts: 250, img: "Skull of vet'ion" },
  { name: "Full Void from Pest Control", pts: 300, img: "Void knight top" },
];

const PVM_LOW_POOL = [
  { name: "Kill Obor, the Hill Titan", pts: 100, img: "Hill giant club" },
  { name: "Kill Bryophyta the moss giant", pts: 100, img: "Bryophyta's essence" },
  { name: "Kill the Giant Mole 5 times", pts: 100, img: "Mole claw" },
  { name: "Kill the King Black Dragon 5 times", pts: 150, img: "Kbd heads" },
  { name: "Kill Sarachnis 5 times", pts: 150, img: "Sarachnis cudgel" },
  { name: "Complete one full Barrows run", pts: 200, img: "Karil's coif" },
  { name: "Kill Scurrius, the rat king", pts: 100, img: "Scurrius' spine" },
  { name: "Earn 5 Wintertodt crates", pts: 100, img: "Supply crate" },
  { name: "Help defeat Tempoross 3 times", pts: 100, img: "Casket" },
  { name: "Kill 20 hill giants", pts: 50, img: "Big bones" },
  { name: "Get a rune scimitar from fire giants", pts: 100, img: "Rune scimitar" },
  { name: "Kill the Deranged Archaeologist", pts: 100, img: "Steel ring" },
  { name: "Complete a game of Pest Control", pts: 50, img: "Void knight gloves" },
  { name: "Kill 10 green dragons", pts: 100, img: "Dragon bones" },
  { name: "Get an ensouled head drop", pts: 50, img: "Ensouled giant head" },
  { name: "Kill a demi-boss slayer monster", pts: 150, img: "Slayer helmet" },
  { name: "Get a Barbarian Assault wave 1-5 done", pts: 100, img: "Fighter torso" },
  { name: "Kill 25 moss giants", pts: 50, img: "Mossy key" },
  { name: "Defeat the Mimic once", pts: 150, img: "Casket (3rd age)" },
  { name: "Get any unique from Fortis Colosseum wave 1", pts: 200, img: "Sunfire splinters" },
  { name: "Kill 15 blue dragons", pts: 100, img: "Blue dragonhide" },
  { name: "Get a clue scroll from any boss", pts: 100, img: "Clue scroll (easy)" },
  { name: "Kill 50 TzHaar", pts: 100, img: "Obsidian cape" },
  { name: "Take a friend on their first boss trip", pts: 150, img: "Games necklace(8)" },
];

const BINGO_POOLS = {
  mixed: BINGO_POOL,
  "pvm-high": PVM_HIGH_POOL,
  "pvm-mid": PVM_MID_POOL,
  "pvm-low": PVM_LOW_POOL,
};

const BINGO_STYLE_LABEL = {
  mixed: "mixed board",
  "pvm-high": "high-level PvM",
  "pvm-mid": "mid-level PvM",
  "pvm-low": "low-level PvM",
};

// Extra prompt guidance per board style for AI-generated boards.
const BINGO_STYLE_GUIDANCE = {
  mixed: "Mix PvM, skilling, clues and minigames.",
  "pvm-high": "Every task must be PvM for high-level endgame players: raids (CoX/ToB/ToA), Inferno/Colosseum, Nex, Nightmare, Corrupted Gauntlet, DT2 bosses, high slayer bosses. Points 200-600, weighted by rarity/difficulty.",
  "pvm-mid": "Every task must be PvM for mid-level accounts (base 70-90s): Barrows, Zulrah, Vorkath, GWD, Kraken, fire cape, slayer bosses, wilderness demi-bosses. No raids-only tasks. Points 150-500.",
  "pvm-low": "Every task must be PvM achievable by low-level accounts (under base 70s): Obor, Bryophyta, Giant Mole, KBD, Sarachnis, Scurrius, Barrows, Pest Control, easy group bosses. Keep tasks short and beginner-friendly. Points 50-200.",
};

const FREE_TILE = { name: "FREE", pts: 50, img: null, free: true };

function makeBingoBoard(tasks) {
  const pool = [...tasks];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const board = pool.slice(0, 24);
  board.splice(12, 0, { ...FREE_TILE });
  return board;
}

// AI-generated themed bingo tiles; falls back to the built-in pools.
async function generateBingoTasks(theme, style) {
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 1600,
      system:
        "You create Old School RuneScape clan bingo tiles. Reply with EXACTLY 24 lines, one tile per line, " +
        "formatted as: task | points | wiki_image\n" +
        "- points: an integer 50-600; harder or rarer tasks are worth more.\n" +
        "- wiki_image: the exact OSRS Wiki file name (no .png) of an item icon that represents the task " +
        "(e.g. Abyssal whip, Fire cape, Prayer potion(4)), or - if nothing fits.\n" +
        "No numbering, no commentary. Tasks must be verifiable via screenshot, achievable within a week of " +
        "casual play, and ironman-friendly (no 'buy X').",
      messages: [{ role: "user", content:
        `Create 24 bingo tiles. ${BINGO_STYLE_GUIDANCE[style] || BINGO_STYLE_GUIDANCE.mixed}` +
        (theme ? ` Extra theme guidance from the clan: ${theme}.` : "") }],
    });
    const text = msg.content.find((b) => b.type === "text")?.text || "";
    const tiles = text.split("\n")
      .map((l) => l.replace(/^[\s\-\d.)]+/, "").trim())
      .filter(Boolean)
      .map((l) => {
        const [name, ptsRaw, imgRaw] = l.split("|").map((p) => (p || "").trim());
        if (!name || name.length < 5) return null;
        const pts = Math.min(Math.max(Math.round(Number(ptsRaw)) || 150, 50), 1000);
        const img = imgRaw && imgRaw !== "-" ? imgRaw.replace(/\.png$/i, "").slice(0, 60) : null;
        return { name: name.slice(0, 90), pts, img };
      })
      .filter(Boolean);
    if (tiles.length >= 20) return tiles.slice(0, 24);
  } catch { /* fall through to pool */ }
  return null;
}

// Validate a Wise Old Man group id and snapshot its details.
async function fetchWomGroup(id) {
  const gid = Number(id);
  if (!Number.isInteger(gid) || gid <= 0) return null;
  try {
    const g = await fetchJson(`https://api.wiseoldman.net/v2/groups/${gid}`);
    if (!g || !g.name) return null;
    return { id: gid, name: g.name, memberCount: g.memberCount ?? (g.memberships?.length ?? null) };
  } catch { return null; }
}

// List clans (public view, newest first).
app.get("/api/clans", (_req, res) => {
  res.json({ clans: clans.map(publicClan).slice().reverse() });
});

// Register a clan.
app.post("/api/clans", async (req, res) => {
  if (hiscoresLimited(req.ip)) return res.status(429).json({ error: "Slow down a touch." });
  const name = clean(req.body?.name, 40);
  const description = clean(req.body?.description, 240);
  const discord = clean(req.body?.discord, 120);
  const webhook = clean(req.body?.webhook, 200);
  const womGroupId = req.body?.womGroupId;

  if (name.length < 2) return res.status(400).json({ error: "Clan name must be at least 2 characters." });
  if (webhook && !WEBHOOK_RE.test(webhook)) {
    return res.status(400).json({ error: "That doesn't look like a Discord webhook URL (discord.com/api/webhooks/…)." });
  }
  if (clans.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: "A clan with that name is already registered." });
  }
  if (discord && !/^https:\/\/(www\.)?(discord\.gg|discord\.com\/invite)\/[\w-]+$/.test(discord)) {
    return res.status(400).json({ error: "Discord link must be a discord.gg invite URL." });
  }
  let wom = null;
  if (womGroupId) {
    wom = await fetchWomGroup(womGroupId);
    if (!wom) return res.status(400).json({ error: "That Wise Old Man group id couldn't be found." });
  }
  if (clans.length >= 500) return res.status(507).json({ error: "The clan registry is full." });

  const clan = {
    id: crypto.randomBytes(6).toString("hex"),
    token: crypto.randomBytes(16).toString("hex"),
    name, description,
    discord: discord || null,
    webhook: webhook || null,
    wom,
    events: [],
    createdAt: Date.now(),
  };
  clans.push(clan);
  saveClans();
  res.status(201).json({ clan: publicClan(clan), token: clan.token });
});

// Clan detail.
app.get("/api/clans/:id", (req, res) => {
  const clan = clans.find((c) => c.id === req.params.id);
  if (!clan) return res.status(404).json({ error: "No such clan." });
  res.json({ clan: publicClan(clan) });
});

function tokenMatches(given, actual) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(actual));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authClan(req, res) {
  const clan = clans.find((c) => c.id === req.params.id);
  if (!clan) { res.status(404).json({ error: "No such clan." }); return null; }
  const token = req.get("x-clan-token") || "";
  if (!tokenMatches(token, clan.token)) {
    res.status(403).json({ error: "Wrong clan key — only the clan's registrant can manage events." });
    return null;
  }
  return clan;
}

// Set or clear the clan's Discord webhook (key-holder only).
app.post("/api/clans/:id/webhook", (req, res) => {
  const clan = authClan(req, res);
  if (!clan) return;
  const webhook = clean(req.body?.webhook, 200);
  if (webhook && !WEBHOOK_RE.test(webhook)) {
    return res.status(400).json({ error: "That doesn't look like a Discord webhook URL (discord.com/api/webhooks/…)." });
  }
  clan.webhook = webhook || null;
  saveClans();
  if (clan.webhook) announce(clan, `🔗 **${clan.name}** is now announcing events from RuneScribe.`);
  res.json({ ok: true, hasWebhook: Boolean(clan.webhook) });
});

// Create an event (requires the clan key from registration).
app.post("/api/clans/:id/events", async (req, res) => {
  const type = ["botw", "sotw", "bingo"].includes(req.body?.type) ? req.body.type : null;
  // Bingo may trigger a PAID model call (AI board) — draw from the tight
  // model budget, not the generous free-lookup bucket.
  const limited = type === "bingo" ? rateLimited(req.ip) : hiscoresLimited(req.ip);
  if (limited) return res.status(429).json({ error: "Slow down a touch — try again in a few minutes." });
  const clan = authClan(req, res);
  if (!clan) return;

  if (!type) return res.status(400).json({ error: "Event type must be botw, sotw or bingo." });
  const target = clean(req.body?.target, 60);      // boss or skill name
  const theme = clean(req.body?.theme, 160);       // bingo theme (optional)
  const days = Math.min(Math.max(Number(req.body?.days) || 7, 1), 30);

  // Optional bingo teams: comma-separated, 2-8 unique names.
  let teams = null;
  if (type === "bingo" && req.body?.teams) {
    const seen = new Set();
    teams = clean(req.body.teams, 200).split(",")
      .map((t) => t.trim().slice(0, 20))
      .filter((t) => t.length >= 2 && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
      .slice(0, 8);
    if (teams.length === 1) return res.status(400).json({ error: "Teams need at least two names (comma separated)." });
    if (!teams.length) teams = null;
  }
  if ((type === "botw" || type === "sotw") && target.length < 2) {
    return res.status(400).json({ error: type === "botw" ? "Name the boss." : "Name the skill." });
  }
  if (clan.events.filter((e) => e.endsAt > Date.now()).length >= 5) {
    return res.status(400).json({ error: "This clan already has 5 active events." });
  }

  const style = BINGO_POOLS[req.body?.style] ? req.body.style : "mixed";
  let board = null;
  let aiBoard = false;
  if (type === "bingo") {
    // AI board when a key is configured; built-in style pool otherwise.
    const aiTasks = process.env.ANTHROPIC_API_KEY ? await generateBingoTasks(theme, style) : null;
    board = makeBingoBoard(aiTasks || BINGO_POOLS[style]);
    aiBoard = Boolean(aiTasks);
  }

  const event = {
    id: crypto.randomBytes(5).toString("hex"),
    type, target: target || null, theme: theme || null,
    board, aiBoard,
    style: type === "bingo" ? style : undefined,
    teams: type === "bingo" ? teams : undefined,
    claims: type === "bingo" ? {} : undefined,
    activity: type === "bingo" ? [] : undefined,
    startsAt: Date.now(),
    endsAt: Date.now() + days * 86_400_000,
  };
  clan.events.push(event);
  saveClans();
  const label = type === "bingo"
    ? `🎲 Bingo (${BINGO_STYLE_LABEL[style]})`
    : type === "botw" ? `⚔️ Boss of the Week — **${target}**` : `📈 Skill of the Week — **${target}**`;
  announce(clan, `📯 New event at **${clan.name}**: ${label} (${days} day${days === 1 ? "" : "s"})${theme ? ` — “${theme}”` : ""}`);
  res.status(201).json({ event });
});

// ---- Bingo claims & verification -----------------------------------------

// Bingo lines, mirrored client-side; the free centre always counts.
const BINGO_LINES = (() => {
  const rows = [0, 1, 2, 3, 4].map((r) => ({ name: `Row ${r + 1}`, cells: [0, 1, 2, 3, 4].map((c) => r * 5 + c) }));
  const cols = [0, 1, 2, 3, 4].map((c) => ({ name: `Column ${c + 1}`, cells: [0, 1, 2, 3, 4].map((r) => r * 5 + c) }));
  return rows.concat(cols, [
    { name: "Diagonal ↘", cells: [0, 6, 12, 18, 24] },
    { name: "Diagonal ↗", cells: [20, 16, 12, 8, 4] },
    { name: "Four corners", cells: [0, 4, 20, 24] },
    { name: "Blackout", cells: Array.from({ length: 25 }, (_, i) => i) },
  ]);
})();

const linesDone = (ev) =>
  BINGO_LINES.filter((l) => l.cells.every((i) => i === 12 || ev.claims[i])).map((l) => l.name);

function findBingo(req, res) {
  const clan = clans.find((c) => c.id === req.params.id);
  if (!clan) { res.status(404).json({ error: "No such clan." }); return null; }
  const ev = (clan.events || []).find((e) => e.id === req.params.eventId);
  if (!ev || ev.type !== "bingo" || !ev.board) {
    res.status(404).json({ error: "No such bingo event." });
    return null;
  }
  ev.claims = ev.claims || {};
  ev.activity = ev.activity || [];
  ev.roster = ev.roster || [];     // signups: [{ player, at }]
  ev.members = ev.members || null; // team assignments: { [team]: [players] }
  return { clan, ev };
}

const tileName = (ev, i) => {
  const cell = ev.board[i];
  return typeof cell === "string" ? cell : (cell && cell.name) || `tile ${i + 1}`;
};

function logActivity(ev, text) {
  ev.activity.push({ at: Date.now(), text: String(text).slice(0, 180) });
  if (ev.activity.length > 40) ev.activity = ev.activity.slice(-40);
}

// Claim a tile — open to any clan member viewing the board (the key-holder
// verifies or removes claims, so griefing is reversible).
app.post("/api/clans/:id/events/:eventId/claim", (req, res) => {
  if (hiscoresLimited(req.ip)) return res.status(429).json({ error: "Slow down a touch." });
  const found = findBingo(req, res);
  if (!found) return;
  const { ev } = found;
  if (ev.endsAt <= Date.now()) return res.status(400).json({ error: "This event has ended." });

  const tile = Number(req.body?.tile);
  if (!Number.isInteger(tile) || tile < 0 || tile > 24) {
    return res.status(400).json({ error: "Invalid tile." });
  }
  if (tile === 12) return res.status(400).json({ error: "The centre tile is free — no claim needed." });
  const player = clean(req.body?.player, 20);
  const note = clean(req.body?.note, 120);
  const proof = clean(req.body?.proof, 300);
  const team = clean(req.body?.team, 20);
  if (!player) return res.status(400).json({ error: "Who claims it? Add your name." });
  if (ev.teams && !ev.teams.includes(team)) {
    return res.status(400).json({ error: "Pick your team — this is a team bingo." });
  }
  if (proof && !/^https:\/\/\S+$/.test(proof)) {
    return res.status(400).json({ error: "Proof must be an https:// link (Discord/Imgur screenshot URL)." });
  }
  if (ev.claims[tile]) return res.status(409).json({ error: "That tile is already claimed." });

  const before = linesDone(ev);
  ev.claims[tile] = {
    player, team: ev.teams ? team : null,
    note: note || null, proof: proof || null,
    at: Date.now(), verified: false,
  };
  const who = ev.teams ? `${player} [${team}]` : player;
  logActivity(ev, `${who} claimed “${tileName(ev, tile)}”`);
  saveClans();

  const { clan } = found;
  const cell = ev.board[tile];
  const pts = typeof cell === "object" && cell ? cell.pts : null;
  announce(clan, `✅ **${who}** claimed “${tileName(ev, tile)}”${pts ? ` (+${pts} pts)` : ""}${note ? ` — “${note}”` : ""}${proof ? `\n${proof}` : ""}`);
  for (const line of linesDone(ev)) {
    if (!before.includes(line)) {
      logActivity(ev, `✦ BINGO — ${line} complete!`);
      announce(clan, `✦ **BINGO!** ${line} is complete at **${clan.name}**!`);
    }
  }
  saveClans();
  res.status(201).json({ event: ev });
});

// Sign up for a team bingo's roster — open to any clan member.
app.post("/api/clans/:id/events/:eventId/join", (req, res) => {
  if (hiscoresLimited(req.ip)) return res.status(429).json({ error: "Slow down a touch." });
  const found = findBingo(req, res);
  if (!found) return;
  const { ev } = found;
  if (!ev.teams) return res.status(400).json({ error: "This bingo has no teams — just claim tiles." });
  if (ev.endsAt <= Date.now()) return res.status(400).json({ error: "This event has ended." });
  const player = clean(req.body?.player, 20);
  if (!player) return res.status(400).json({ error: "Add your name to sign up." });
  if (ev.roster.some((r) => r.player.toLowerCase() === player.toLowerCase())) {
    return res.status(409).json({ error: "You're already on the roster." });
  }
  if (ev.roster.length >= 100) return res.status(400).json({ error: "The roster is full." });
  ev.roster.push({ player, at: Date.now() });
  logActivity(ev, `${player} signed up for the roster`);
  saveClans();
  res.status(201).json({ event: ev });
});

// Remove a player from the roster (and their team) — key-holder only.
app.delete("/api/clans/:id/events/:eventId/roster/:player", (req, res) => {
  const clan = authClan(req, res);
  if (!clan) return;
  const found = findBingo(req, res);
  if (!found) return;
  const { ev } = found;
  const player = clean(req.params.player, 20).toLowerCase();
  const before = ev.roster.length;
  ev.roster = ev.roster.filter((r) => r.player.toLowerCase() !== player);
  if (ev.roster.length === before) return res.status(404).json({ error: "That name isn't on the roster." });
  if (ev.members) {
    for (const t of Object.keys(ev.members)) {
      ev.members[t] = ev.members[t].filter((p) => p.toLowerCase() !== player);
    }
  }
  saveClans();
  res.json({ event: ev });
});

// Set team assignments — key-holder only. Two modes:
//   { mode: "random" }                    → shuffle the roster into the teams
//   { assignments: { team: [players] } }  → commit a draft result
app.post("/api/clans/:id/events/:eventId/teams", (req, res) => {
  const clan = authClan(req, res);
  if (!clan) return;
  const found = findBingo(req, res);
  if (!found) return;
  const { ev } = found;
  if (!ev.teams) return res.status(400).json({ error: "This bingo has no teams." });
  if (!ev.roster.length) return res.status(400).json({ error: "Nobody has signed up yet — the roster is empty." });

  const members = {};
  for (const t of ev.teams) members[t] = [];

  if (req.body?.mode === "random") {
    const pool = ev.roster.map((r) => r.player);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    pool.forEach((p, n) => members[ev.teams[n % ev.teams.length]].push(p));
    logActivity(ev, `⚔ teams drawn at random (${pool.length} players)`);
  } else {
    const rosterNames = new Map(ev.roster.map((r) => [r.player.toLowerCase(), r.player]));
    const seen = new Set();
    const given = req.body?.assignments;
    if (!given || typeof given !== "object") return res.status(400).json({ error: "No assignments given." });
    for (const [team, players] of Object.entries(given)) {
      if (!ev.teams.includes(team) || !Array.isArray(players)) continue;
      for (const raw of players.slice(0, 100)) {
        const canonical = rosterNames.get(clean(raw, 20).toLowerCase());
        if (!canonical || seen.has(canonical)) continue; // roster members only, once
        seen.add(canonical);
        members[team].push(canonical);
      }
    }
    if (!seen.size) return res.status(400).json({ error: "No valid picks — draft from the roster." });
    logActivity(ev, `⚔ teams drafted (${seen.size} players picked)`);
  }

  ev.members = members;
  saveClans();
  const lineup = ev.teams
    .map((t) => `**${t}** — ${members[t].length ? members[t].join(", ") : "(empty)"}`)
    .join(" · ");
  announce(clan, `⚔️ Bingo teams are set at **${clan.name}**: ${lineup}`);
  res.json({ event: ev });
});

// Verify (or unverify) a claim — key-holder only.
app.post("/api/clans/:id/events/:eventId/verify", (req, res) => {
  const clan = authClan(req, res);
  if (!clan) return;
  const found = findBingo(req, res);
  if (!found) return;
  const { ev } = found;
  const tile = Number(req.body?.tile);
  const claim = ev.claims[tile];
  if (!claim) return res.status(404).json({ error: "No claim on that tile." });
  claim.verified = !claim.verified;
  logActivity(ev, claim.verified
    ? `✦ verified ${claim.player}'s “${tileName(ev, tile)}”`
    : `verification removed from “${tileName(ev, tile)}”`);
  saveClans();
  if (claim.verified) announce(clan, `◆ **${claim.player}**'s “${tileName(ev, tile)}” was verified.`);
  res.json({ event: ev });
});

// Remove a claim — key-holder only.
app.delete("/api/clans/:id/events/:eventId/claim/:tile", (req, res) => {
  const clan = authClan(req, res);
  if (!clan) return;
  const found = findBingo(req, res);
  if (!found) return;
  const { ev } = found;
  const tile = Number(req.params.tile);
  const claim = ev.claims[tile];
  if (!claim) return res.status(404).json({ error: "No claim on that tile." });
  delete ev.claims[tile];
  logActivity(ev, `claim on “${tileName(ev, tile)}” was removed`);
  saveClans();
  res.json({ event: ev });
});

// Remove an event.
// Final standings for a closed bingo — used in the close announcement.
function bingoResult(ev) {
  if (ev.type !== "bingo" || !ev.board) return "";
  const ptsOf = (i) => {
    const c = ev.board[i];
    return typeof c === "object" && c ? Number(c.pts) || 0 : 0;
  };
  const claims = ev.claims || {};
  if (ev.teams && ev.members) {
    const scores = ev.teams.map((t) => {
      let pts = 0;
      for (const [i, c] of Object.entries(claims)) if (c.team === t) pts += ptsOf(Number(i));
      return { t, pts };
    }).sort((a, b) => b.pts - a.pts);
    if (!scores.length || scores[0].pts === 0) return "No tiles were claimed.";
    const tie = scores[1] && scores[1].pts === scores[0].pts;
    return tie
      ? `It's a tie on ${scores[0].pts} pts!`
      : `🏆 **${scores[0].t}** win with ${scores[0].pts} pts!`;
  }
  const by = {};
  for (const [i, c] of Object.entries(claims)) by[c.player] = (by[c.player] || 0) + ptsOf(Number(i));
  const top = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
  return top ? `🏆 Top contributor: **${top[0]}** (${top[1]} pts).` : "No tiles were claimed.";
}

// Close an event early — key-holder only. Keeps the board and results; just
// stops new claims/signups and marks it finished (vs. DELETE, which removes it).
app.post("/api/clans/:id/events/:eventId/close", (req, res) => {
  const clan = authClan(req, res);
  if (!clan) return;
  const ev = (clan.events || []).find((e) => e.id === req.params.eventId);
  if (!ev) return res.status(404).json({ error: "No such event." });
  if (ev.endsAt <= Date.now()) return res.status(400).json({ error: "This event has already finished." });

  ev.endsAt = Date.now();
  ev.closed = true;
  if (ev.type === "bingo") {
    ev.activity = ev.activity || [];
    logActivity(ev, "🏁 the organiser closed the bingo");
  }
  saveClans();

  const label = ev.type === "bingo" ? "bingo" : ev.type === "botw" ? `Boss of the Week${ev.target ? ` (${ev.target})` : ""}` : `Skill of the Week${ev.target ? ` (${ev.target})` : ""}`;
  announce(clan, `🏁 **${clan.name}** closed their ${label}. ${bingoResult(ev)}`.trim());
  res.json({ event: ev });
});

app.delete("/api/clans/:id/events/:eventId", (req, res) => {
  const clan = authClan(req, res);
  if (!clan) return;
  const before = clan.events.length;
  clan.events = clan.events.filter((e) => e.id !== req.params.eventId);
  if (clan.events.length === before) return res.status(404).json({ error: "No such event." });
  saveClans();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Linked accounts — RuneLite WikiSync proxy (quests, diaries, levels).
// Players install the WikiSync plugin in RuneLite; it publishes their quest
// and diary state to sync.runescape.wiki, which we read here.
// ---------------------------------------------------------------------------

app.get("/api/runelite/:player", async (req, res) => {
  if (hiscoresLimited(req.ip)) return res.status(429).json({ error: "Slow down a touch." });
  const player = clean(req.params.player, 12);
  if (!player) return res.status(400).json({ error: "Invalid player name." });
  try {
    const data = await fetchJson(
      `https://sync.runescape.wiki/runelite/player/${encodeURIComponent(player)}/STANDARD`
    );
    const quests = data.quests || {};
    const questNames = Object.keys(quests);
    const done = questNames.filter((q) => quests[q] === 2);
    const inProgress = questNames.filter((q) => quests[q] === 1);
    res.json({
      player,
      timestamp: data.timestamp || null,
      levels: data.levels || null,
      quests: {
        total: questNames.length,
        complete: done.length,
        inProgress,
        incomplete: questNames.filter((q) => quests[q] === 0),
      },
      diaries: data.achievement_diaries || null,
    });
  } catch (err) {
    res.status(404).json({
      error:
        `No WikiSync data for "${player}". They need the WikiSync plugin enabled in RuneLite ` +
        `and to have logged in since installing it (${err.message}).`,
    });
  }
});

// ---------------------------------------------------------------------------
// GE price alerts — server-side evaluation + optional Web Push.
// Devices mirror their alerts here; a central poller checks prices every
// minute (even with every tab closed), records fired alerts for the next
// visit, and — where the browser granted permission — sends a push.
// ---------------------------------------------------------------------------

const ALERTS_FILE = path.join(DATA_DIR, "alerts.json");
let alertStore = {}; // device -> { alerts, fired, sub, updatedAt }
try {
  alertStore = JSON.parse(fs.readFileSync(ALERTS_FILE, "utf8"));
  if (!alertStore || typeof alertStore !== "object") alertStore = {};
} catch { alertStore = {}; }

let alertSaveTimer = null;
function saveAlerts() {
  clearTimeout(alertSaveTimer);
  alertSaveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(ALERTS_FILE, JSON.stringify(alertStore));
    } catch (err) { console.error("alert save failed:", err.message); }
  }, 250);
}

// Web Push is optional: VAPID keys are generated once and persisted; if the
// web-push module is missing the whole feature degrades to fired-history.
let webpush = null;
let vapidPublicKey = null;
try {
  webpush = (await import("web-push")).default;
  const VAPID_FILE = path.join(DATA_DIR, "vapid.json");
  let keys;
  try { keys = JSON.parse(fs.readFileSync(VAPID_FILE, "utf8")); } catch { keys = null; }
  if (!keys || !keys.publicKey) {
    keys = webpush.generateVAPIDKeys();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(VAPID_FILE, JSON.stringify(keys));
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@runescribe.example", keys.publicKey, keys.privateKey);
  vapidPublicKey = keys.publicKey;
} catch (err) {
  console.warn("Web Push disabled:", err.message);
}

const DEVICE_RE = /^[\w-]{8,64}$/;
const ALERT_FIELDS = new Set(["buy", "sell", "margin"]);

function sanitizeAlerts(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const a of raw.slice(0, 50)) {
    const id = Number(a?.id), value = Number(a?.value);
    if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(value)) continue;
    if (!ALERT_FIELDS.has(a?.field) || !["lte", "gte"].includes(a?.op)) continue;
    out.push({
      id, value,
      name: clean(a?.name, 60) || `item ${id}`,
      field: a.field, op: a.op,
      armed: a?.armed !== false,
    });
  }
  return out;
}

// Mirror this device's alerts; returns any alerts that fired since last ack.
app.post("/api/ge/alerts/sync", (req, res) => {
  if (hiscoresLimited(req.ip)) return res.status(429).json({ error: "Slow down a touch." });
  const device = String(req.body?.device || "");
  if (!DEVICE_RE.test(device)) return res.status(400).json({ error: "Invalid device id." });
  const alerts = sanitizeAlerts(req.body?.alerts);
  if (!alerts) return res.status(400).json({ error: "Invalid alerts payload." });

  if (!alertStore[device] && Object.keys(alertStore).length >= 2000) {
    return res.status(507).json({ error: "The alert registry is full." });
  }
  const entry = alertStore[device] || { fired: [], sub: null };
  // Merge armed state: if either side has fired this alert, it stays
  // disarmed until the condition clears (both sides re-arm on clear).
  const prev = new Map((entry.alerts || []).map((a) => [`${a.id}:${a.field}:${a.op}:${a.value}`, a]));
  for (const a of alerts) {
    const p = prev.get(`${a.id}:${a.field}:${a.op}:${a.value}`);
    if (p) a.armed = a.armed && p.armed;
  }
  entry.alerts = alerts;
  entry.updatedAt = Date.now();
  alertStore[device] = entry;
  if (!alerts.length && !entry.fired.length && !entry.sub) delete alertStore[device];
  saveAlerts();
  res.json({ ok: true, alerts, fired: entry.fired || [], push: Boolean(vapidPublicKey) });
});

// Acknowledge fired alerts up to a timestamp (drops them from history).
app.post("/api/ge/alerts/ack", (req, res) => {
  const device = String(req.body?.device || "");
  const upTo = Number(req.body?.upTo) || 0;
  const entry = alertStore[device];
  if (entry) {
    entry.fired = (entry.fired || []).filter((f) => f.at > upTo);
    saveAlerts();
  }
  res.json({ ok: true });
});

// Public VAPID key for push subscription (null = push unavailable).
app.get("/api/push/key", (_req, res) => res.json({ key: vapidPublicKey }));

// Store (or clear) a device's push subscription.
app.post("/api/ge/alerts/subscribe", (req, res) => {
  if (hiscoresLimited(req.ip)) return res.status(429).json({ error: "Slow down a touch." });
  const device = String(req.body?.device || "");
  if (!DEVICE_RE.test(device)) return res.status(400).json({ error: "Invalid device id." });
  const sub = req.body?.subscription;
  const valid = sub && typeof sub.endpoint === "string" && sub.endpoint.startsWith("https://") && sub.endpoint.length < 1000;
  const entry = alertStore[device] || { alerts: [], fired: [] };
  entry.sub = valid ? { endpoint: sub.endpoint, keys: sub.keys } : null;
  entry.updatedAt = Date.now();
  alertStore[device] = entry;
  saveAlerts();
  res.json({ ok: true, push: Boolean(entry.sub) });
});

const alertActual = (a, p) => {
  const high = Number(p?.high), low = Number(p?.low);
  if (a.field === "buy") return Number.isFinite(high) ? high : null;
  if (a.field === "sell") return Number.isFinite(low) ? low : null;
  return Number.isFinite(high) && Number.isFinite(low) ? high - low - geTax(high) : null;
};

async function evaluateAlerts() {
  const devices = Object.entries(alertStore).filter(([, e]) => e.alerts && e.alerts.length);
  if (!devices.length) return;
  let latest;
  try { latest = await getLatestAll(); } catch { return; } // upstream down — try next tick
  let changed = false;

  for (const [device, entry] of devices) {
    // Expire devices idle for 30 days.
    if (Date.now() - (entry.updatedAt || 0) > 30 * 86_400_000) {
      delete alertStore[device];
      changed = true;
      continue;
    }
    for (const a of entry.alerts) {
      const actual = alertActual(a, latest.data?.[String(a.id)]);
      if (actual == null) continue;
      const met = a.op === "lte" ? actual <= a.value : actual >= a.value;
      if (met && a.armed) {
        a.armed = false;
        changed = true;
        const fired = {
          at: Date.now(), id: a.id, name: a.name, field: a.field, op: a.op, value: a.value, actual,
          text: `${a.name}: ${a.field} is ${actual.toLocaleString("en-GB")} gp (${a.op === "lte" ? "≤" : "≥"} ${a.value.toLocaleString("en-GB")})`,
        };
        entry.fired = [...(entry.fired || []), fired].slice(-50);
        if (webpush && entry.sub) {
          webpush.sendNotification(entry.sub, JSON.stringify({ title: "RuneScribe — GE alert", body: fired.text }))
            .catch((err) => {
              // 404/410 = subscription expired; drop it.
              if (err && (err.statusCode === 404 || err.statusCode === 410)) { entry.sub = null; saveAlerts(); }
            });
        }
      } else if (!met && !a.armed) {
        a.armed = true; // re-arm once the condition clears
        changed = true;
      }
    }
  }
  if (changed) saveAlerts();
}
setInterval(() => { evaluateAlerts().catch(() => {}); }, Number(process.env.ALERT_POLL_MS) || 60_000);

// Health check for uptime monitors and hosting platforms.
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, model: MODEL, apiKey: Boolean(process.env.ANTHROPIC_API_KEY) });
});

// The JSON stores are saved on a 250ms debounce — flush them on shutdown so
// a clan registered moments before Ctrl+C (or a platform restart) survives.
function flushStoresAndExit() {
  try {
    clearTimeout(saveTimer);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CLANS_FILE, JSON.stringify(clans, null, 2));
  } catch {}
  try {
    clearTimeout(alertSaveTimer);
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(alertStore));
  } catch {}
  process.exit(0);
}
process.on("SIGINT", flushStoresAndExit);
process.on("SIGTERM", flushStoresAndExit);

app.listen(PORT, () => {
  console.log(`RuneScribe is listening on http://localhost:${PORT}`);
  console.log(`Model: ${MODEL}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set — chat requests will fail until it is.");
  }
});
