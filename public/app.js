/* The Wise Old Man — a living star chart.
   Canvas constellation scene + streaming chat drawer. */

// ===========================================================================
// Config
// ===========================================================================

// The sage's domains. Angles in degrees: -90 is straight up.
const CLUSTERS = [
  {
    name: "QUESTS", sub: "guides · order · requirements", angle: -135,
    prompt: "Which quests should every new member rush first, and why?",
  },
  {
    name: "COMBAT", sub: "bossing · slayer · gear", angle: -45,
    prompt: "I'm a mid-level account (base 70s). Give me a gear and quest roadmap to kill Vorkath.",
  },
  {
    name: "SKILLING", sub: "methods · xp rates", angle: 180,
    prompt: "What are the most efficient training methods right now for Agility, Runecraft and Slayer?",
  },
  {
    name: "EXCHANGE", sub: "live prices · flips", angle: 0, accent: true,
    prompt: "What's the current Grand Exchange price of a Twisted bow, and is it worth buying for CoX?",
  },
  {
    name: "HISCORES", sub: "players · ranks · kc", angle: 135,
    prompt: "Look up the player Lynx Titan on the hiscores and tell me something impressive about their account.",
  },
  {
    name: "LORE", sub: "wiki · history · trivia", angle: 45,
    prompt: "Tell me the story of the Wise Old Man and the Draynor bank robbery — and what it left behind in-game.",
  },
];

const TOOL_LABELS = {
  get_player_stats: (i) => `scrying the hiscores · ${i.player ?? "…"}`,
  get_ge_price: (i) => `consulting the exchange · ${i.item_name ?? "…"}`,
  search_wiki: (i) => `leafing the archives · ${i.query ?? "…"}`,
};

const THINKING_LINES = [
  "the old man strokes his beard…",
  "the old man consults his tomes…",
  "the old man peers into the stars…",
  "the old man mutters an incantation…",
];

// ===========================================================================
// DOM handles
// ===========================================================================

const canvas = document.getElementById("scene");
const ctx = canvas.getContext("2d");
const labelsRoot = document.getElementById("labels");
const drawer = document.getElementById("drawer");
const drawerClose = document.getElementById("drawer-close");
const chatLog = document.getElementById("chat-log");
const form = document.getElementById("chat-form");
const input = document.getElementById("chat-input");
const statusBar = document.getElementById("status-bar");
const statusText = document.getElementById("status-text");
const coreStatusText = document.getElementById("core-status-text");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ===========================================================================
// Star chart
// ===========================================================================

// Deterministic RNG so the chart is organic but stable for the session.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x05f5c9);

const rad = (deg) => (deg * Math.PI) / 180;

// All coordinates are in "R units" relative to the chart center, where
// R = min(viewport) * 0.36. They scale with the window on resize.
const nodes = [];   // {x, y, r, bright, phase, speed}
const edges = [];   // {a, b}
const hubs = [];    // {x, y, accent}
const dust = [];    // faint background stars, in screen fractions {fx, fy, ...}
const nebula = [];  // center particles {ang, dist, size, hue, speed, phase}

function generateChart() {
  for (const c of CLUSTERS) {
    const baseAngle = rad(c.angle);
    const hubDist = 0.42 + rand() * 0.07;
    const hx = Math.cos(baseAngle) * hubDist;
    const hy = Math.sin(baseAngle) * hubDist;
    hubs.push({ x: hx, y: hy, accent: !!c.accent });

    const hubIndex = nodes.push({
      x: hx, y: hy, r: 2.6, bright: 0.9, phase: rand() * 7, speed: 0.4 + rand() * 0.4,
    }) - 1;

    const branches = 4 + Math.floor(rand() * 3);
    for (let b = 0; b < branches; b++) {
      let dir = baseAngle + rad((rand() - 0.5) * 105);
      let px = hx, py = hy;
      let prev = hubIndex;
      const steps = 2 + Math.floor(rand() * 4);
      for (let s = 0; s < steps; s++) {
        dir += rad((rand() - 0.5) * 55);
        const len = 0.055 + rand() * 0.075;
        px += Math.cos(dir) * len;
        py += Math.sin(dir) * len;
        const idx = nodes.push({
          x: px, y: py,
          r: 1 + rand() * (s === steps - 1 ? 2.4 : 1.6),
          bright: 0.5 + rand() * 0.5,
          phase: rand() * 7,
          speed: 0.5 + rand() * 1.1,
        }) - 1;
        edges.push({ a: prev, b: idx });
        prev = idx;
        // occasional short side-twig
        if (rand() < 0.3) {
          const tdir = dir + rad((rand() - 0.5) * 120);
          const tx = px + Math.cos(tdir) * (0.04 + rand() * 0.05);
          const ty = py + Math.sin(tdir) * (0.04 + rand() * 0.05);
          const tIdx = nodes.push({
            x: tx, y: ty, r: 0.9 + rand() * 1.3,
            bright: 0.4 + rand() * 0.4, phase: rand() * 7, speed: 0.6 + rand() * 1.2,
          }) - 1;
          edges.push({ a: idx, b: tIdx });
        }
      }
    }
  }

  for (let i = 0; i < 110; i++) {
    dust.push({
      fx: Math.random(), fy: Math.random(),
      r: 0.4 + Math.random() * 1.1,
      bright: 0.08 + Math.random() * 0.2,
      phase: Math.random() * 7,
      speed: 0.15 + Math.random() * 0.5,
    });
  }

  for (let i = 0; i < 170; i++) {
    // gaussian-ish radial cloud
    const dist = Math.abs((rand() + rand() + rand()) / 3 - 0.5) * 0.34 + 0.012;
    nebula.push({
      ang: rand() * Math.PI * 2,
      dist,
      size: 0.5 + rand() * 1.8,
      hue: 44 + rand() * 14,
      speed: (0.05 + rand() * 0.25) * (rand() < 0.5 ? 1 : -1),
      phase: rand() * 7,
    });
  }
}

// ---- Layout ----
let W = 0, H = 0, DPR = 1, CX = 0, CY = 0, R = 0;

function layout() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  CX = W / 2;
  CY = H * 0.45;
  R = Math.min(W, H) * 0.36;
  placeLabels();
  if (reducedMotion) drawFrame(0);
}

// ---- Labels ----
function placeLabels() {
  for (const c of CLUSTERS) {
    if (!c.el) continue;
    const a = rad(c.angle);
    const lr = R * (Math.abs(Math.sin(a)) > 0.9 ? 1.28 : 1.24);
    let x = CX + Math.cos(a) * lr;
    let y = CY + Math.sin(a) * lr * 0.92;
    x = Math.max(80, Math.min(W - 80, x));
    y = Math.max(46, Math.min(H - 110, y));
    c.el.style.left = x + "px";
    c.el.style.top = y + "px";
  }
}

function buildLabels() {
  for (const c of CLUSTERS) {
    const btn = document.createElement("button");
    btn.className = "constellation-label";
    btn.type = "button";
    btn.innerHTML =
      `<span class="label-name">${c.name}</span>` +
      `<span class="label-sub">${c.sub}</span>`;
    btn.addEventListener("click", () => sendMessage(c.prompt));
    labelsRoot.appendChild(btn);
    c.el = btn;
  }
}

// ---- Animation state ----
// The nebula reacts to what the sage is doing.
const glow = { intensity: 0.85, speed: 1, warmth: 0 }; // current (lerped)
const GLOW_TARGETS = {
  idle: { intensity: 0.85, speed: 1.0, warmth: 0 },
  busy: { intensity: 1.5, speed: 2.6, warmth: 0.15 },
  scry: { intensity: 1.8, speed: 3.4, warmth: 1 },
};

function drawFrame(t) {
  ctx.clearRect(0, 0, W, H);
  const sec = t / 1000;

  // Background dust
  for (const d of dust) {
    const a = d.bright * (0.6 + 0.4 * Math.sin(sec * d.speed + d.phase));
    ctx.fillStyle = `rgba(239, 232, 211, ${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(d.fx * W, d.fy * H, d.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Constellation edges
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(228, 216, 184, 0.13)";
  ctx.beginPath();
  for (const e of edges) {
    const a = nodes[e.a], b = nodes[e.b];
    ctx.moveTo(CX + a.x * R, CY + a.y * R);
    ctx.lineTo(CX + b.x * R, CY + b.y * R);
  }
  ctx.stroke();

  // Constellation nodes
  for (const n of nodes) {
    const tw = 0.55 + 0.45 * Math.sin(sec * n.speed + n.phase);
    const alpha = Math.min(1, n.bright * tw);
    const x = CX + n.x * R, y = CY + n.y * R;
    if (n.r > 2.2) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, n.r * 4);
      g.addColorStop(0, `rgba(242, 231, 200, ${(alpha * 0.5).toFixed(3)})`);
      g.addColorStop(1, "rgba(242, 231, 200, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, n.r * 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = `rgba(243, 236, 214, ${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, n.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Hub rings
  for (const h of hubs) {
    const x = CX + h.x * R, y = CY + h.y * R;
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = h.accent
      ? "rgba(213, 71, 63, 0.75)"
      : "rgba(228, 216, 184, 0.45)";
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = h.accent ? "rgba(230, 110, 100, 0.9)" : "rgba(243, 236, 214, 0.8)";
    ctx.beginPath();
    ctx.arc(x, y, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Lerp glow toward the current core state
  const target = GLOW_TARGETS[document.body.dataset.core] || GLOW_TARGETS.idle;
  glow.intensity += (target.intensity - glow.intensity) * 0.04;
  glow.speed += (target.speed - glow.speed) * 0.04;
  glow.warmth += (target.warmth - glow.warmth) * 0.04;

  // Central halo
  const haloR = R * 0.30 * (1 + 0.05 * Math.sin(sec * 0.9));
  const halo = ctx.createRadialGradient(CX, CY, 0, CX, CY, haloR);
  halo.addColorStop(0, `rgba(240, 214, 140, ${(0.14 * glow.intensity).toFixed(3)})`);
  halo.addColorStop(1, "rgba(240, 214, 140, 0)");
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(CX, CY, haloR, 0, Math.PI * 2);
  ctx.fill();

  // Nebula particles around the sage
  for (const p of nebula) {
    const ang = p.ang + sec * p.speed * glow.speed * 0.35;
    const wob = 1 + 0.08 * Math.sin(sec * 0.7 + p.phase);
    const x = CX + Math.cos(ang) * p.dist * R * wob;
    const y = CY + Math.sin(ang) * p.dist * R * wob * 0.92;
    const tw = 0.45 + 0.55 * Math.sin(sec * (p.speed * 6) * glow.speed * 0.4 + p.phase);
    const alpha = Math.min(1, tw * glow.intensity * (1.15 - p.dist * 2.4));
    if (alpha <= 0.02) continue;
    const hue = p.hue - glow.warmth * 16; // warms toward ember when scrying
    ctx.fillStyle = `hsla(${hue.toFixed(0)}, 78%, ${(72 - glow.warmth * 8).toFixed(0)}%, ${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
}

function loop(t) {
  drawFrame(t);
  requestAnimationFrame(loop);
}

// ===========================================================================
// Chat
// ===========================================================================

const history = [];
let busy = false;

// Keep the conversation bounded so token spend per request stays sane.
// We trim from the front but never start on an assistant turn.
const MAX_TURNS = 24;
function trimHistory() {
  while (history.length > MAX_TURNS) history.shift();
  while (history.length && history[0].role !== "user") history.shift();
}

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
  let list = null;
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

    if (h) { closeList(); out.push(`<h3>${renderInline(h[2])}</h3>`); }
    else if (ul) {
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${renderInline(ul[1])}</li>`);
    } else if (ol) {
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${renderInline(ol[1])}</li>`);
    } else if (line.trim() === "") closeList();
    else { closeList(); out.push(`<p>${renderInline(line)}</p>`); }
  }
  closeList();
  if (code) out.push("</code></pre>");
  return out.join("\n");
}

function scrollToBottom() { chatLog.scrollTop = chatLog.scrollHeight; }

function openDrawer() { drawer.hidden = false; }
function closeDrawer() { drawer.hidden = true; }

function addMessage(role, tag) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = `<div class="msg-tag">${tag}</div><div class="msg-body"></div>`;
  chatLog.appendChild(div);
  return div;
}

function addUserMessage(text) {
  const div = addMessage("user", "Adventurer");
  div.querySelector(".msg-body").textContent = text;
  scrollToBottom();
}

function addAssistantMessage() {
  const div = addMessage("assistant", "Wise Old Man");
  div.classList.add("streaming");
  return div;
}

function addScryLine(label) {
  const div = document.createElement("div");
  div.className = "scry-line";
  div.innerHTML = `<span class="scry-dot" aria-hidden="true"></span><span>${escapeHtml(label)}</span>`;
  chatLog.appendChild(div);
  scrollToBottom();
  return div;
}

function addErrorLine(text) {
  const div = document.createElement("div");
  div.className = "error-line";
  div.textContent = text;
  chatLog.appendChild(div);
  scrollToBottom();
}

function setCore(state, label) {
  document.body.dataset.core = state; // idle | busy | scry
  coreStatusText.textContent = label;
}

function setBusy(state) {
  busy = state;
  input.disabled = state;
  CLUSTERS.forEach((c) => c.el && (c.el.disabled = state));
  statusBar.hidden = !state;
  if (state) {
    statusText.textContent =
      THINKING_LINES[Math.floor(Math.random() * THINKING_LINES.length)];
    setCore("busy", "pondering");
  } else {
    setCore("idle", "standing by");
    input.focus();
  }
}

// Read an SSE response and render it into the conversation drawer.
// Shared by text chat (/api/chat) and the PvM coach (/api/analyse).
async function consumeStream(res) {
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `The server answered with ${res.status}.`);
  }

  let msg = null;
  let body = null;
  let assistantText = "";
  const pending = [];
  const finishMessage = () => { if (msg) msg.classList.remove("streaming"); };

  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const chunks = buffer.split("\n\n");
      buffer = chunks.pop();

      for (const chunk of chunks) {
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        let event;
        try { event = JSON.parse(dataLine.slice(6)); } catch { continue; }

        if (event.type === "text") {
          if (!msg) {
            msg = addAssistantMessage();
            body = msg.querySelector(".msg-body");
            setCore("busy", "speaking");
          }
          assistantText += event.text;
          body.innerHTML = renderMarkdown(assistantText);
          scrollToBottom();
        } else if (event.type === "tool_start") {
          finishMessage();
          if (assistantText.trim()) history.push({ role: "assistant", content: assistantText });
          msg = null; body = null; assistantText = "";

          const label = (TOOL_LABELS[event.name] || (() => event.name))(event.input || {});
          pending.push(addScryLine(label));
          statusText.textContent = label + "…";
          setCore("scry", "scrying");
        } else if (event.type === "tool_end") {
          const line = pending.shift();
          if (line) line.classList.add(event.ok ? "done" : "failed");
          if (pending.length === 0) setCore("busy", "pondering");
          statusText.textContent =
            THINKING_LINES[Math.floor(Math.random() * THINKING_LINES.length)];
        } else if (event.type === "error") {
          addErrorLine(event.error);
        }
      }
    }
  } finally {
    finishMessage();
    if (assistantText.trim()) history.push({ role: "assistant", content: assistantText });
    scrollToBottom();
  }
}

async function sendMessage(text) {
  if (busy || !text.trim()) return;
  const userText = text.trim();

  openDrawer();
  addUserMessage(userText);
  history.push({ role: "user", content: userText });
  trimHistory();
  setBusy(true);

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });
    await consumeStream(res);
  } catch (err) {
    addErrorLine(err.message || "The link to the old man's study was lost.");
  } finally {
    setBusy(false);
  }
}

// Public hooks for feature modules (coach.js, ironman.js).
window.WOM = {
  get busy() { return busy; },
  openDrawer,
  setBusy,
  setCore,
  // POST `body` to `url`, render the streamed reply into the drawer, and fold
  // a short text note into the conversation so text follow-ups have context.
  async stream(url, body, note, errorFallback) {
    if (busy) return;
    openDrawer();
    addUserMessage(note);
    history.push({ role: "user", content: note });
    trimHistory();
    setBusy(true);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await consumeStream(res);
    } catch (err) {
      addErrorLine(err.message || errorFallback || "The link to the old man's study was lost.");
    } finally {
      setBusy(false);
    }
  },
  analyseFrames(frames, note, mode) {
    return this.stream(
      "/api/analyse",
      { frames, note, mode },
      note,
      "The old man couldn't make out your screen, adventurer."
    );
  },
};

// ===========================================================================
// Wiring
// ===========================================================================

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = "";
  sendMessage(text);
});

drawerClose.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !drawer.hidden) closeDrawer();
});

buildLabels();
generateChart();
layout();
window.addEventListener("resize", layout);
if (!reducedMotion) requestAnimationFrame(loop);

input.focus();
