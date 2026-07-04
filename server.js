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

You have three scrying tools:
- get_player_stats — look up a player's live hiscores (levels, XP, ranks, boss KC).
- get_ge_price — look up an item's live Grand Exchange price.
- search_wiki — search the official OSRS Wiki for anything you're unsure about (current meta, recent updates, exact drop rates, quest details).

Use the tools whenever the answer depends on live data (prices, a specific player's stats) or precise facts you might misremember (exact drop rates, requirements, recent game updates). Answer from your own knowledge for general strategy and advice. Never fabricate prices, stats, or drop rates — scry for them.

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
      "Search the official Old School RuneScape Wiki and return the top matching article's summary and URL. Call this for precise facts you might misremember: exact drop rates, quest requirements, recent game updates, or anything niche.",
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

async function searchWiki({ query }) {
  const base = "https://oldschool.runescape.wiki/api.php";
  let search;
  try {
    search = await fetchJson(
      `${base}?action=opensearch&format=json&limit=3&search=${encodeURIComponent(query)}`
    );
  } catch (err) {
    return { error: `The wiki could not be reached (${err.message}).` };
  }
  const [, titles, , urls] = search;
  if (!titles || titles.length === 0) {
    return { error: `The wiki has no article matching "${query}".` };
  }
  const title = titles[0];
  let extract = null;
  try {
    const page = await fetchJson(
      `${base}?action=query&format=json&prop=extracts&explaintext=1&exchars=2500&redirects=1&titles=${encodeURIComponent(title)}`
    );
    const pages = page.query?.pages || {};
    extract = Object.values(pages)[0]?.extract || null;
  } catch {
    // Summary is best-effort; the title + URL alone are still useful.
  }
  return {
    title,
    url: urls?.[0] || `https://oldschool.runescape.wiki/w/${encodeURIComponent(title.replace(/ /g, "_"))}`,
    summary: extract,
    other_matches: titles.slice(1),
  };
}

const TOOL_HANDLERS = {
  get_player_stats: getPlayerStats,
  get_ge_price: getGePrice,
  search_wiki: searchWiki,
};

// ---------------------------------------------------------------------------
// Chat endpoint — streams SSE events to the browser while running the
// tool-use loop against the Claude API.
// ---------------------------------------------------------------------------

app.post("/api/chat", async (req, res) => {
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

app.listen(PORT, () => {
  console.log(`RuneScribe is listening on http://localhost:${PORT}`);
  console.log(`Model: ${MODEL}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set — chat requests will fail until it is.");
  }
});
