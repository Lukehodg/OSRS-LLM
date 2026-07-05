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
    setTimeout(() => rsnEl.focus(), 50);
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
  // Progress persistence (per RSN, on this device)
  // -------------------------------------------------------------------------
  const storeKey = (name) => `wom.iron.${name.toLowerCase()}`;
  function loadAcquired(name) {
    try {
      const raw = localStorage.getItem(storeKey(name));
      acquired = new Set(raw ? JSON.parse(raw) : []);
    } catch { acquired = new Set(); }
  }
  function saveAcquired() {
    try { localStorage.setItem(storeKey(rsn), JSON.stringify([...acquired])); } catch {}
  }

  // -------------------------------------------------------------------------
  // Status logic
  // -------------------------------------------------------------------------
  const lvl = (skill) => (stats && stats.skills[skill] ? stats.skills[skill].level : 1);

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

    try {
      const res = await fetch(`/api/hiscores?player=${encodeURIComponent(name)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Lookup failed.");
      stats = body;
      rsn = body.player || name;
    } catch (err) {
      statusEl.className = "iron-status error";
      statusEl.textContent = err.message || "Couldn't find that account on the hiscores.";
      loadBtn.disabled = false;
      return;
    }

    loadAcquired(rsn);
    // Share the account with the rest of the app (skill/boss pickers).
    if (window.WOM && window.WOM.setAccount) {
      window.WOM.setAccount({ player: rsn, skills: stats.skills });
    }
    await loadData();
    statusEl.hidden = true;
    loadBtn.disabled = false;
    render();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = rsnEl.value.trim();
    if (name) load(name);
  });

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  function render() {
    // Account strip
    const cb = combatLevel(stats);
    const total = Object.values(stats.skills).reduce((n, s) => n + (s.level || 1), 0);
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
    const total = Object.values(stats.skills).reduce((n, s) => n + (s.level || 1), 0);
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
})();
