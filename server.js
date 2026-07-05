import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

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

const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_10_MIN || 15);
const RATE_WINDOW_MS = 10 * 60 * 1000;
const hits = new Map(); // ip -> [timestamps]

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_LIMIT) {
    hits.set(ip, list);
    return true;
  }
  list.push(now);
  hits.set(ip, list);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) {
    const fresh = list.filter((t) => now - t < RATE_WINDOW_MS);
    if (fresh.length === 0) hits.delete(ip);
    else hits.set(ip, fresh);
  }
}, RATE_WINDOW_MS).unref();

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

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
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
