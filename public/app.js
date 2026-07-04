/* RuneScribe chat client — streams SSE from /api/chat and renders
   the Wise Old Man's replies as OSRS-style dialogue boxes. */

const chatLog = document.getElementById("chat-log");
const form = document.getElementById("chat-form");
const input = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const statusBar = document.getElementById("status-bar");
const statusText = document.getElementById("status-text");
const scryLog = document.getElementById("scry-log");

// Conversation history sent to the server: plain-text turns only.
const history = [];
let busy = false;

const TOOL_LABELS = {
  get_player_stats: (i) => `Scrying the hiscores for “${i.player ?? "…"}”`,
  get_ge_price: (i) => `Consulting the Grand Exchange about “${i.item_name ?? "…"}”`,
  search_wiki: (i) => `Leafing through the Wiki for “${i.query ?? "…"}”`,
};

const THINKING_LINES = [
  "The Wise Old Man strokes his beard…",
  "The Wise Old Man consults his tomes…",
  "The Wise Old Man peers into his scrying orb…",
  "The Wise Old Man mutters an incantation…",
];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInline(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

// A deliberately small markdown renderer: paragraphs, headings, lists,
// fenced code, bold/italic/inline-code/links. Input is escaped first.
function renderMarkdown(text) {
  const lines = escapeHtml(text).split("\n");
  const out = [];
  let list = null; // "ul" | "ol" | null
  let code = false;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");

    if (/^```/.test(line)) {
      closeList();
      out.push(code ? "</code></pre>" : "<pre><code>");
      code = !code;
      continue;
    }
    if (code) { out.push(line); continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);

    if (h) {
      closeList();
      out.push(`<h3>${renderInline(h[2])}</h3>`);
    } else if (ul) {
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${renderInline(ul[1])}</li>`);
    } else if (ol) {
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${renderInline(ol[1])}</li>`);
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      out.push(`<p>${renderInline(line)}</p>`);
    }
  }
  closeList();
  if (code) out.push("</code></pre>");
  return out.join("\n");
}

function scrollToBottom() {
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addPlayerLine(text) {
  const div = document.createElement("div");
  div.className = "chat-line";
  div.innerHTML = `<span class="speaker">You:</span> ${escapeHtml(text)}`;
  chatLog.appendChild(div);
  scrollToBottom();
}

function addDialogue() {
  const div = document.createElement("div");
  div.className = "dialogue streaming";
  div.innerHTML =
    '<div class="dialogue-name">Wise Old Man</div><div class="dialogue-body"></div>';
  chatLog.appendChild(div);
  return div;
}

function addScryLine(text) {
  const div = document.createElement("div");
  div.className = "scry-line";
  div.textContent = text;
  chatLog.appendChild(div);
  scrollToBottom();
}

function addErrorLine(text) {
  const div = document.createElement("div");
  div.className = "error-line";
  div.textContent = text;
  chatLog.appendChild(div);
  scrollToBottom();
}

function addScryEntry(text) {
  const empty = scryLog.querySelector(".scry-empty");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = "scry-entry";
  div.innerHTML = `<span class="scry-what">${escapeHtml(text)}</span>`;
  scryLog.appendChild(div);
  scryLog.scrollTop = scryLog.scrollHeight;
  return div;
}

function setBusy(state) {
  busy = state;
  sendBtn.disabled = state;
  input.disabled = state;
  document.querySelectorAll(".quick").forEach((b) => (b.disabled = state));
  statusBar.hidden = !state;
  if (state) {
    statusText.textContent =
      THINKING_LINES[Math.floor(Math.random() * THINKING_LINES.length)];
  } else {
    input.focus();
  }
}

// ---------------------------------------------------------------------------
// Streaming chat
// ---------------------------------------------------------------------------

async function sendMessage(text) {
  if (busy || !text.trim()) return;
  const userText = text.trim();

  addPlayerLine(userText);
  history.push({ role: "user", content: userText });
  setBusy(true);

  let dialogue = null;
  let body = null;
  let assistantText = "";
  const pendingScries = [];

  const finishDialogue = () => {
    if (dialogue) dialogue.classList.remove("streaming");
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `The server answered with ${res.status}.`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const chunks = buffer.split("\n\n");
      buffer = chunks.pop(); // keep the trailing partial chunk

      for (const chunk of chunks) {
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        let event;
        try { event = JSON.parse(dataLine.slice(6)); } catch { continue; }

        if (event.type === "text") {
          if (!dialogue) {
            dialogue = addDialogue();
            body = dialogue.querySelector(".dialogue-body");
          }
          assistantText += event.text;
          body.innerHTML = renderMarkdown(assistantText);
          scrollToBottom();
        } else if (event.type === "tool_start") {
          // Starting a tool means the current dialogue block (if any) is done
          // narrating for now; a fresh one opens when text resumes.
          finishDialogue();
          if (assistantText.trim()) history.push({ role: "assistant", content: assistantText });
          dialogue = null; body = null; assistantText = "";

          const label = (TOOL_LABELS[event.name] || (() => `Casting ${event.name}`))(
            event.input || {}
          );
          addScryLine(label + "…");
          pendingScries.push(addScryEntry(label));
          statusText.textContent = label + "…";
        } else if (event.type === "tool_end") {
          const entry = pendingScries.shift();
          if (entry) entry.classList.add(event.ok ? "done" : "failed");
          statusText.textContent =
            THINKING_LINES[Math.floor(Math.random() * THINKING_LINES.length)];
        } else if (event.type === "error") {
          addErrorLine(event.error);
        }
      }
    }
  } catch (err) {
    addErrorLine(err.message || "The connection to the old man's study was lost.");
  } finally {
    finishDialogue();
    if (assistantText.trim()) history.push({ role: "assistant", content: assistantText });
    setBusy(false);
    scrollToBottom();
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = "";
  sendMessage(text);
});

document.querySelectorAll(".quick").forEach((btn) => {
  btn.addEventListener("click", () => sendMessage(btn.dataset.prompt));
});

input.focus();
