/* Ironman Path — personalised progression from live hiscores.
   Loads a player's stats, colours each curated milestone by their real
   levels (obtained / ready / locked), and asks the sage for a tailored plan.
   Depends on window.WOM (app.js). */

(function () {
  const panel = document.getElementById("iron");
  const openBtn = document.getElementById("iron-open");
  const form = document.getElementById("iron-form");
  const rsnEl = document.getElementById("iron-rsn");
  const loadBtn = document.getElementById("iron-load");
  const statusEl = document.getElementById("iron-status");
  const accountEl = document.getElementById("iron-account");
  const statsEl = document.getElementById("iron-stats");
  const boardEl = document.getElementById("iron-board");
  const focusEl = document.getElementById("iron-focus");
  const planBtn = document.getElementById("iron-plan");
  const bankBtn = document.getElementById("iron-bank-btn");
  const bankFile = document.getElementById("iron-bank-file");
  const bankStatus = document.getElementById("iron-bank-status");

  // A few headline skills to show in the account strip.
  const HEADLINE = ["Attack", "Strength", "Defence", "Ranged", "Magic", "Prayer", "Slayer", "Herblore"];

  let data = null;      // milestone dataset
  let dataPromise = null;
  let stats = null;     // { player, skills, activities }
  let rsn = "";
  let acquired = new Set();

  // -------------------------------------------------------------------------
  // Open / close
  // -------------------------------------------------------------------------
  function openPanel() {
    panel.hidden = false;
    loadData();
    // If an account is already linked (via Link Account or a previous load),
    // adopt it here so the adventurer doesn't re-type their name.
    const acc = window.WOM && window.WOM.account;
    if (acc && acc.player) {
      rsnEl.value = acc.player;
      const already = stats && rsn && rsn.toLowerCase() === acc.player.toLowerCase();
      if (!already) {
        if (acc.skills) applyStats({ player: acc.player, skills: acc.skills });
        else load(acc.player);
      }
    } else {
      setTimeout(() => rsnEl.focus(), 50);
    }
  }
  function closePanel() { panel.hidden = true; }

  openBtn.addEventListener("click", openPanel);
  panel.addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-iron-dismiss")) closePanel();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) closePanel();
  });

  function loadData() {
    if (!dataPromise) {
      dataPromise = fetch("ironman-data.json")
        .then((r) => r.json())
        .then((d) => { data = d; })
        .catch(() => { dataPromise = null; });
    }
    return dataPromise;
  }

  // -------------------------------------------------------------------------
  // Progress persistence — local cache + server sync keyed by RSN, so a
  // player's obtained milestones follow them across devices once linked.
  // -------------------------------------------------------------------------
  const storeKey = (name) => `wom.iron.${name.toLowerCase()}`;
  const progUrl = (name) => `/api/progress/${encodeURIComponent(name)}/ironman`;

  function loadAcquired(name) {
    try {
      const raw = localStorage.getItem(storeKey(name));
      acquired = new Set(raw ? JSON.parse(raw) : []);
    } catch { acquired = new Set(); }
  }
  function saveAcquiredLocal() {
    try { localStorage.setItem(storeKey(rsn), JSON.stringify([...acquired])); } catch {}
  }

  let pushTimer = null;
  function saveAcquired() {
    saveAcquiredLocal();
    // Debounced push to the server so progress survives on other devices.
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      fetch(progUrl(rsn), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { ids: [...acquired] } }),
      }).catch(() => { /* offline — local cache still holds it */ });
    }, 400);
  }

  // Reconcile with the server after a load: the server is authoritative once
  // it has anything saved; otherwise migrate this device's local progress up.
  async function syncProgress() {
    const name = rsn;
    try {
      const r = await fetch(progUrl(name));
      if (!r.ok) return;
      const body = await r.json();
      const serverIds = body.data && Array.isArray(body.data.ids) ? body.data.ids : null;
      if (serverIds && serverIds.length) {
        if (name !== rsn) return; // a newer load superseded us
        acquired = new Set(serverIds);
        saveAcquiredLocal();
        render();
      } else if (acquired.size) {
        saveAcquired(); // server empty — push what this device has
      }
    } catch { /* offline — keep local */ }
  }

  // -------------------------------------------------------------------------
  // Status logic
  // -------------------------------------------------------------------------
  const lvl = (skill) => {
    const v = Number(stats && stats.skills[skill] ? stats.skills[skill].level : 1);
    return Number.isFinite(v) ? v : 1;
  };

  // Returns { status: 'done'|'ready'|'locked', gaps: [{skill, need, have}] }
  function evaluate(item) {
    if (acquired.has(item.id)) return { status: "done", gaps: [] };
    const reqs = (item.req && item.req.skills) || {};
    const gaps = [];
    for (const [skill, need] of Object.entries(reqs)) {
      const have = lvl(skill);
      if (have < need) gaps.push({ skill, need, have });
    }
    return { status: gaps.length ? "locked" : "ready", gaps };
  }

  function combatLevel(s) {
    const g = (n) => (s.skills[n] ? s.skills[n].level : 1);
    const base = 0.25 * (g("Defence") + g("Hitpoints") + Math.floor(g("Prayer") / 2));
    const melee = 0.325 * (g("Attack") + g("Strength"));
    const range = 0.325 * Math.floor((3 * g("Ranged")) / 2);
    const mage = 0.325 * Math.floor((3 * g("Magic")) / 2);
    return Math.floor(base + Math.max(melee, range, mage));
  }

  // -------------------------------------------------------------------------
  // Load account
  // -------------------------------------------------------------------------
  async function load(name) {
    statusEl.hidden = false;
    statusEl.className = "iron-status";
    statusEl.textContent = "Scrying the hiscores…";
    accountEl.hidden = true;
    loadBtn.disabled = true;

    let body;
    try {
      const res = await fetch(`/api/hiscores?player=${encodeURIComponent(name)}`);
      body = await res.json();
      if (!res.ok) throw new Error(body.error || "Lookup failed.");
    } catch (err) {
      statusEl.className = "iron-status error";
      statusEl.textContent = err.message || "Couldn't find that account on the hiscores.";
      loadBtn.disabled = false;
      return;
    }
    await applyStats(body, name);
  }

  // Populate the board from a stats object ({ player, skills }), whether that
  // came from a fresh hiscores lookup or an already-linked account.
  async function applyStats(source, fallbackName) {
    stats = source;
    rsn = source.player || fallbackName || rsn;
    loadAcquired(rsn);
    // Share the account with the rest of the app (skill/boss pickers).
    if (window.WOM && window.WOM.setAccount) {
      window.WOM.setAccount({ player: rsn, skills: stats.skills });
    }
    await loadData();
    statusEl.hidden = true;
    loadBtn.disabled = false;
    render();
    syncProgress(); // reconcile obtained milestones with the server
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = rsnEl.value.trim();
    if (name) load(name);
  });

  // Total level straight from the hiscores' authoritative "Overall" entry.
  // (Summing every skill would double-count, since "Overall" is itself the
  // total — and this stays correct however many skills the game has.)
  function totalLevel() {
    const s = stats && stats.skills;
    if (!s) return 0;
    const overall = Number(s.Overall && s.Overall.level);
    if (Number.isFinite(overall) && overall > 0) return overall;
    return Object.entries(s).reduce((n, [k, v]) => (k === "Overall" ? n : n + (Number(v.level) || 1)), 0);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  function render() {
    // Account strip
    const cb = combatLevel(stats);
    const total = totalLevel();
    const chips = [
      `<div class="stat big"><span>${cb}</span><small>combat</small></div>`,
      `<div class="stat big"><span>${total}</span><small>total</small></div>`,
    ].concat(
      HEADLINE.map(
        (sk) => `<div class="stat"><span>${lvl(sk)}</span><small>${sk.slice(0, 4).toLowerCase()}</small></div>`
      )
    );
    statsEl.innerHTML =
      `<div class="iron-name">${escapeHtml(rsn)}</div><div class="stat-row">${chips.join("")}</div>`;

    // Board
    boardEl.innerHTML = "";
    for (const track of data.tracks) {
      const col = document.createElement("div");
      col.className = "track";

      const items = track.items
        .map((it) => ({ it, ev: evaluate(it) }))
        .sort((a, b) => rank(a.ev.status) - rank(b.ev.status));
      const readyCount = items.filter((x) => x.ev.status === "ready").length;

      col.innerHTML =
        `<div class="track-head"><span class="track-icon">${track.icon}</span>` +
        `<span class="track-name">${escapeHtml(track.name)}</span>` +
        (readyCount ? `<span class="track-badge">${readyCount} ready</span>` : "") +
        `</div><div class="track-blurb">${escapeHtml(track.blurb)}</div>`;

      for (const { it, ev } of items) {
        col.appendChild(nodeEl(it, ev));
      }
      boardEl.appendChild(col);
    }

    accountEl.hidden = false;
  }

  const rank = (s) => (s === "ready" ? 0 : s === "locked" ? 1 : 2);

  // OSRS Wiki item sprite; Special:FilePath resolves the name to the file.
  const wikiImg = (name) =>
    `https://oldschool.runescape.wiki/w/Special:FilePath/${encodeURIComponent(name + ".png")}`;

  function iconEl(item) {
    const span = document.createElement("span");
    span.className = "node-icon";
    if (item.img) {
      const img = document.createElement("img");
      img.className = "item-img";
      img.alt = "";
      img.src = wikiImg(item.img);
      // If the sprite 404s or is blocked, fall back to the emoji.
      img.addEventListener("error", () => { span.textContent = item.icon; });
      span.appendChild(img);
    } else {
      span.textContent = item.icon;
    }
    return span;
  }

  function nodeEl(item, ev) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `node ${ev.status}`;
    const reqText =
      ev.status === "locked"
        ? ev.gaps.map((g) => `${g.skill} ${g.have}/${g.need}`).join(" · ")
        : item.req && item.req.note
          ? item.req.note
          : reqSummary(item);

    const main = document.createElement("span");
    main.className = "node-main";
    main.innerHTML =
      `<span class="node-name">${escapeHtml(item.name)}</span>` +
      `<span class="node-req">${escapeHtml(reqText)}</span>`;

    const tick = document.createElement("span");
    tick.className = "node-tick";
    tick.setAttribute("aria-hidden", "true");

    el.append(iconEl(item), main, tick);
    el.title = item.why || "";
    el.addEventListener("click", () => {
      if (acquired.has(item.id)) acquired.delete(item.id);
      else acquired.add(item.id);
      saveAcquired();
      render();
    });
    return el;
  }

  function reqSummary(item) {
    const reqs = (item.req && item.req.skills) || {};
    const keys = Object.entries(reqs);
    if (!keys.length) return item.req && item.req.note ? item.req.note : "no level requirement";
    return keys.map(([s, n]) => `${s} ${n}`).join(" · ");
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // -------------------------------------------------------------------------
  // Personalised plan
  // -------------------------------------------------------------------------
  function buildSummary() {
    const cb = combatLevel(stats);
    const total = totalLevel();
    const order = [
      "Attack", "Strength", "Defence", "Hitpoints", "Ranged", "Magic", "Prayer",
      "Slayer", "Herblore", "Farming", "Runecraft", "Construction", "Agility",
      "Thieving", "Crafting", "Fishing", "Cooking", "Mining", "Smithing",
      "Woodcutting", "Firemaking", "Fletching", "Hunter",
    ];
    const levels = order.map((s) => `${s} ${lvl(s)}`).join(", ");

    const done = [];
    const ready = [];
    const locked = [];
    for (const track of data.tracks) {
      for (const it of track.items) {
        const ev = evaluate(it);
        if (ev.status === "done") done.push(it.name);
        else if (ev.status === "ready") ready.push(`${it.name} (${track.name})`);
        else locked.push(`${it.name} — needs ${ev.gaps.map((g) => `${g.skill} ${g.need}`).join(", ")}`);
      }
    }

    const focus = focusEl.value.trim();
    return [
      `Ironman account "${rsn}". Combat level ${cb}, total level ${total}.`,
      `Levels: ${levels}.`,
      done.length ? `Milestones already obtained: ${done.join("; ")}.` : `No milestones marked obtained yet.`,
      ready.length ? `Ready now (requirements met, not yet obtained): ${ready.join("; ")}.` : `Nothing is marked ready.`,
      locked.length ? `Locked milestones and gating: ${locked.join("; ")}.` : ``,
      focus ? `The player's focus: "${focus}".` : `No specific focus — give an overall next-steps plan.`,
      `Build my personalised ironman progression plan.`,
    ].filter(Boolean).join("\n\n");
  }

  planBtn.addEventListener("click", () => {
    if (!stats || !data || (window.WOM && window.WOM.busy)) return;
    const summary = buildSummary();
    const focus = focusEl.value.trim();
    const note = focus ? `⚔️ Ironman plan — ${rsn} (${focus})` : `⚔️ Ironman plan — ${rsn}`;
    closePanel();
    window.WOM.stream("/api/ironman/plan", { summary }, note,
      "The old man couldn't chart your path just now.");
  });

  // Keep the plan button in step with the sage being busy.
  setInterval(() => {
    planBtn.disabled = !stats || (window.WOM && window.WOM.busy);
  }, 500);

  // -------------------------------------------------------------------------
  // Analyse bank — read a screenshot and auto-tick the milestones you own.
  // A full bank export is one very tall, narrow image; if we squashed it into
  // a single frame the item icons would be a few pixels wide and unreadable.
  // So we keep it near native width and slice it into legible top-to-bottom
  // strips, sending them together (the vision endpoint reads them as one bank).
  // -------------------------------------------------------------------------
  const BANK_MAX_WIDTH = 1400;   // cap width; icons stay ~native otherwise
  const BANK_STRIP_H = 1500;     // target strip height (keeps the long edge legible)
  const BANK_MAX_TILES = 8;      // matches the server cap; bounds vision cost
  const BANK_OVERLAP = 48;       // strip overlap so a row split at a seam still appears whole
  const BANK_JPEG_QUALITY = 0.82;

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file didn't look like an image.")); };
      img.src = url;
    });
  }

  // Slice a bank image into legible JPEG strips. Returns an array of data URLs.
  async function fileToTiles(file) {
    const img = await loadImage(file);
    let w = img.naturalWidth, h = img.naturalHeight;
    const wScale = Math.min(1, BANK_MAX_WIDTH / w);
    w = Math.max(1, Math.round(w * wScale));
    h = Math.max(1, Math.round(h * wScale));
    // If it's taller than we can cover in BANK_MAX_TILES strips, scale down to fit
    // (icons shrink a little, but the whole bank is still covered).
    const maxH = BANK_STRIP_H * BANK_MAX_TILES;
    if (h > maxH) { const f = maxH / h; w = Math.max(1, Math.round(w * f)); h = maxH; }

    const full = document.createElement("canvas");
    full.width = w; full.height = h;
    full.getContext("2d").drawImage(img, 0, 0, w, h);

    if (h <= BANK_STRIP_H) return [full.toDataURL("image/jpeg", BANK_JPEG_QUALITY)];

    const strips = Math.min(BANK_MAX_TILES, Math.ceil(h / BANK_STRIP_H));
    const stripH = Math.ceil(h / strips);
    const tiles = [];
    for (let i = 0; i < strips; i++) {
      const sy = Math.max(0, i * stripH - (i ? BANK_OVERLAP : 0));
      const sh = Math.min(h - sy, stripH + BANK_OVERLAP);
      const c = document.createElement("canvas");
      c.width = w; c.height = sh;
      c.getContext("2d").drawImage(full, 0, sy, w, sh, 0, 0, w, sh);
      tiles.push(c.toDataURL("image/jpeg", BANK_JPEG_QUALITY));
    }
    return tiles;
  }

  // Every milestone as { id, name } for the matcher.
  function milestoneList() {
    const out = [];
    for (const track of data.tracks) for (const it of track.items) out.push({ id: it.id, name: it.name });
    return out;
  }

  function setBankStatus(text, kind) {
    bankStatus.hidden = false;
    bankStatus.className = "iron-status" + (kind ? ` ${kind}` : "");
    bankStatus.textContent = text;
  }

  bankBtn.addEventListener("click", () => {
    if (!stats || !data) return;
    bankFile.click();
  });

  bankFile.addEventListener("change", async () => {
    const file = bankFile.files && bankFile.files[0];
    bankFile.value = ""; // allow re-picking the same file later
    if (!file || !stats || !data) return;

    bankBtn.disabled = true;
    setBankStatus("Preparing your bank…");
    let tiles;
    try {
      tiles = await fileToTiles(file);
    } catch (err) {
      setBankStatus(err.message || "Couldn't read that image.", "error");
      bankBtn.disabled = false;
      return;
    }

    try {
      setBankStatus(tiles.length > 1 ? `Reading your bank in ${tiles.length} sections…` : "Reading your bank…");
      const res = await fetch("/api/ironman/bank-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images: tiles, items: milestoneList() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "The scan failed.");

      const found = Array.isArray(body.found) ? body.found : [];
      const known = new Set(milestoneList().map((m) => m.id));
      const added = [];
      for (const id of found) {
        if (known.has(id) && !acquired.has(id)) { acquired.add(id); added.push(id); }
      }
      if (added.length) { saveAcquired(); render(); }

      const total = found.filter((id) => known.has(id)).length;
      setBankStatus(
        total === 0
          ? "No milestone items spotted in that bank. A sharper, full-resolution screenshot reads best."
          : `Spotted ${total} milestone item${total === 1 ? "" : "s"}${added.length ? ` — marked ${added.length} newly obtained` : " (already ticked)"}. Tap any tile to adjust.`,
        total === 0 ? "" : "ok"
      );
    } catch (err) {
      setBankStatus(err.message || "Something went wrong reading your bank.", "error");
    } finally {
      bankBtn.disabled = false;
    }
  });
})();
