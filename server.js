import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const app = express();
// Large enough for a burst of PvM-coach frames; per-endpoint caps
// (MAX_INPUT_CHARS, MAX_FRAMES, MAX_FRAME_BYTES) do the real bounding.
app.use(express.json({ limit: "8mb" }));

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

  try {
    // Agentic loop: stream a response; if Claude calls tools, run them,
    // append the results, and stream the follow-up — until end_turn.
    for (let turn = 0; turn < 8; turn++) {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
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

function parseFrame(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const m = dataUrl.match(/^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const media_type = m[1];
  if (!ALLOWED_FRAME_TYPES.has(media_type)) return null;
  const data = m[2];
  // base64 length * 3/4 ≈ decoded byte size
  if (data.length * 0.75 > MAX_FRAME_BYTES) return null;
  return { type: "image", source: { type: "base64", media_type, data } };
}

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

// Health check for uptime monitors and hosting platforms.
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, model: MODEL, apiKey: Boolean(process.env.ANTHROPIC_API_KEY) });
});

app.listen(PORT, () => {
  console.log(`RuneScribe is listening on http://localhost:${PORT}`);
  console.log(`Model: ${MODEL}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set — chat requests will fail until it is.");
  }
});
