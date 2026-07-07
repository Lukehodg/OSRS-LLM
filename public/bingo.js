/* Bingo HQ — full-screen clan bingo board in the star-chart theme.
   Tiles carry points + wiki sprites; players claim tiles, the clan
   key-holder verifies. Stats strip, tile detail, bingo lines, activity
   feed and a contributor leaderboard. Opened from the Clan Hall. */

(function () {
  const root = document.getElementById("bingo");
  if (!root) return;

  const titleEl = document.getElementById("bhq-title");
  const subEl = document.getElementById("bhq-sub");
  const clockEl = document.getElementById("bhq-clock");
  const filtersEl = document.getElementById("bhq-filters");
  const statsEl = document.getElementById("bhq-stats");
  const boardEl = document.getElementById("bhq-board");
  const detailEl = document.getElementById("bhq-detail");
  const linesEl = document.getElementById("bhq-lines");
  const lbEl = document.getElementById("bhq-lb");
  const feedEl = document.getElementById("bhq-feed");
  const teamsPanel = document.getElementById("bhq-teams-panel");
  const teamsEl = document.getElementById("bhq-teams");
  const rosterPanel = document.getElementById("bhq-roster-panel");
  const rosterEl = document.getElementById("bhq-roster");

  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const keys = () => { try { return JSON.parse(localStorage.getItem("wom.clan.keys")) || {}; } catch { return {}; } };

  let clanId = null, eventId = null, clan = null, ev = null;
  let selected = null, filter = "all";
  let clockTimer = null, pollTimer = null;
  let drawnLines = new Set(); // constellations already drawn (skip re-animation)
  let boardRevealed = false;  // stagger the tile reveal only on open
  let firstSky = true;        // don't throw a party for lines finished before we opened

  // ---- open / close --------------------------------------------------------
  window.openBingo = async function (cid, eid) {
    clanId = cid; eventId = eid; selected = null; filter = "all";
    drawnLines = new Set();
    boardRevealed = false;
    firstSky = true;
    setFilterUI();
    root.hidden = false;
    boardEl.innerHTML = `<div class="bhq-loading">unrolling the board…</div>`;
    await refresh();
    clearInterval(clockTimer); clockTimer = setInterval(tickClock, 1000);
    clearInterval(pollTimer); pollTimer = setInterval(() => refresh(true), 45_000);
  };
  function close() {
    root.hidden = true;
    clearInterval(clockTimer); clearInterval(pollTimer);
  }
  root.addEventListener("click", (e) => { if (e.target.hasAttribute("data-bhq-dismiss")) close(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || root.hidden) return;
    // The draft overlay swallows Escape first, so a mid-draft cancel doesn't
    // also close the whole board.
    if (draft && !document.getElementById("bhq-draft").hidden) { closeDraft(); return; }
    close();
  });

  async function refresh(quiet) {
    try {
      const r = await fetch(`/api/clans/${clanId}`);
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "clan not found");
      clan = body.clan;
      ev = (clan.events || []).find((e) => e.id === eventId);
      if (!ev || !ev.board) throw new Error("This bingo event no longer exists.");
      render();
    } catch (err) {
      if (!quiet) boardEl.innerHTML = `<div class="bhq-loading">${esc(err.message)}</div>`;
    }
  }

  // ---- model helpers -------------------------------------------------------
  // Old boards stored plain strings; normalise every cell to an object.
  const cellOf = (i) => {
    const c = ev.board[i];
    if (typeof c === "string") return { name: c, pts: 100, img: null, free: i === 12 };
    return { name: c.name, pts: Number(c.pts) || 100, img: c.img || null, free: Boolean(c.free) || i === 12 };
  };
  const claimOf = (i) => (ev.claims && ev.claims[i]) || null;

  // Which team a player was assigned to, or null if unassigned / no draw yet.
  function teamForPlayer(player) {
    if (!ev.members || !player) return null;
    const lc = player.toLowerCase();
    for (const t of ev.teams) if ((ev.members[t] || []).some((p) => p.toLowerCase() === lc)) return t;
    return null;
  }

  // Team bingo: stable colour per team (by its position in the event's list).
  const TEAM_HUES = ["#d9c07a", "#8fd48f", "#7fb8d8", "#e0857a", "#c39bd3", "#f0b27a", "#a3d9c9", "#d8d87f"];
  const teamColor = (name) => {
    const i = (ev.teams || []).indexOf(name);
    return TEAM_HUES[i >= 0 ? i % TEAM_HUES.length : 0];
  };
  const statusOf = (i) => cellOf(i).free ? "free" : claimOf(i) ? (claimOf(i).verified ? "verified" : "claimed") : "open";
  const isDone = (i) => statusOf(i) !== "open";
  const isManager = () => Boolean(keys()[clanId]);
  const live = () => ev.endsAt > Date.now();

  const LINES = (() => {
    const rows = [0, 1, 2, 3, 4].map((r) => ({ name: `Row ${r + 1}`, cells: [0, 1, 2, 3, 4].map((c) => r * 5 + c) }));
    const cols = [0, 1, 2, 3, 4].map((c) => ({ name: `Column ${c + 1}`, cells: [0, 1, 2, 3, 4].map((r) => r * 5 + c) }));
    return rows.concat(cols, [
      { name: "Diagonal ↘", cells: [0, 6, 12, 18, 24] },
      { name: "Diagonal ↗", cells: [20, 16, 12, 8, 4] },
      { name: "Four corners", cells: [0, 4, 20, 24] },
      { name: "Blackout", cells: Array.from({ length: 25 }, (_, i) => i) },
    ]);
  })();

  const wikiImg = (name) =>
    `https://oldschool.runescape.wiki/w/Special:FilePath/${encodeURIComponent(name + ".png")}`;

  // Point tiers, coloured like drop-rarity broadcasts.
  const tierOf = (pts) =>
    pts >= 450 ? "legendary" : pts >= 350 ? "epic" : pts >= 250 ? "rare" : pts >= 150 ? "uncommon" : "common";
  const TIER_COLORS = {
    common: "#cfc6ad", uncommon: "#8ade7f", rare: "#74b9f0", epic: "#c793f2", legendary: "#ffab52",
  };

  // Proof screenshots: inline thumbnail for hosts the CSP allows, link otherwise.
  const PROOF_IMG_HOSTS = ["cdn.discordapp.com", "media.discordapp.net", "i.imgur.com"];
  function proofHtml(proof) {
    if (!proof) return "";
    let host = "";
    try { host = new URL(proof).hostname; } catch { return ""; }
    const inline = PROOF_IMG_HOSTS.includes(host);
    return `<a class="bhq-proof" href="${esc(proof)}" target="_blank" rel="noopener noreferrer">${
      inline ? `<img src="${esc(proof)}" alt="proof screenshot" loading="lazy">` : `<span class="bhq-proof-link">view proof ↗</span>`
    }</a>`;
  }

  const ago = (t) => {
    const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  function tickClock() {
    if (!ev) return;
    const ms = ev.endsAt - Date.now();
    if (ms <= 0) { clockEl.textContent = "event finished"; clockEl.classList.add("over"); return; }
    clockEl.classList.remove("over");
    const d = Math.floor(ms / 86_400_000), h = Math.floor((ms % 86_400_000) / 3_600_000),
          m = Math.floor((ms % 3_600_000) / 60_000), s = Math.floor((ms % 60_000) / 1000);
    clockEl.textContent = (d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m ${s}s`) + " remaining";
  }

  // ---- filters --------------------------------------------------------------
  filtersEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-filter]");
    if (!b) return;
    filter = b.dataset.filter;
    setFilterUI();
    if (ev) renderBoard();
  });
  function setFilterUI() {
    filtersEl.querySelectorAll("[data-filter]").forEach((b) => {
      b.classList.toggle("active", b.dataset.filter === filter);
      if (!ev) return;
      const f = b.dataset.filter;
      const n = f === "all" ? 25
        : Array.from({ length: 25 }, (_, i) => i).filter((i) =>
            f === "verified" ? (statusOf(i) === "verified" || statusOf(i) === "free") : statusOf(i) === f).length;
      b.innerHTML = `${f} <b>${n}</b>`;
    });
  }
  const matchesFilter = (i) => filter === "all" || statusOf(i) === filter ||
    (filter === "verified" && statusOf(i) === "free");

  // ---- render ---------------------------------------------------------------
  function render() {
    titleEl.textContent = `${clan.name} — Bingo`.toUpperCase();
    const styleLabel = { "pvm-high": "high-level PvM", "pvm-mid": "mid-level PvM", "pvm-low": "low-level PvM" }[ev.style];
    subEl.textContent = [ev.theme ? `“${ev.theme}”` : "", styleLabel].filter(Boolean).join(" · ")
      || (ev.aiBoard ? "board conjured by the sage" : "");
    tickClock();
    setFilterUI();
    renderStats();
    renderBoard();
    renderDetail();
    renderLines();
    renderRoster();
    renderTeams();
    renderLeaderboard();
    renderFeed();
  }

  // ---- roster + team assignment -------------------------------------------
  function renderRoster() {
    if (!ev.teams) { rosterPanel.hidden = true; return; }
    rosterPanel.hidden = false;
    const roster = ev.roster || [];
    const assigned = ev.members || null;
    const teamOf = (p) => {
      if (!assigned) return null;
      for (const t of ev.teams) if ((assigned[t] || []).some((x) => x.toLowerCase() === p.toLowerCase())) return t;
      return null;
    };
    const mgr = isManager();
    const acct = window.WOM && window.WOM.account;
    const mine = acct && roster.some((r) => r.player.toLowerCase() === acct.player.toLowerCase());

    let html = "";
    if (!roster.length) {
      html += `<div class="bhq-dim">No signups yet. Players join here, then the organiser splits them into teams.</div>`;
    } else {
      html += `<div class="bhq-roster-list">` + roster.map((r) => {
        const t = teamOf(r.player);
        const dot = t ? `<span class="bhq-team-dot" data-team="${esc(t)}"></span>` : `<span class="bhq-roster-wait">·</span>`;
        const rm = mgr ? `<span class="bhq-roster-x" data-drop="${esc(r.player)}" title="Remove">✕</span>` : "";
        return `<div class="bhq-roster-row">${dot}<span class="bhq-roster-name">${esc(r.player)}</span>${t ? `<span class="bhq-roster-team">${esc(t)}</span>` : ""}${rm}</div>`;
      }).join("") + `</div>`;
    }

    // Sign-up control (only while unassigned and the event is live)
    if (live() && !assigned) {
      html += mine
        ? `<div class="bhq-roster-note">✓ You're on the roster — wait for the draw.</div>`
        : `<form class="bhq-roster-form" id="bhq-roster-form">
             <input name="player" type="text" maxlength="20" placeholder="your RSN" spellcheck="false" value="${esc(acct ? acct.player : "")}" />
             <button class="clans-btn primary" type="submit">Sign up</button>
           </form>`;
    }

    // Organiser controls
    if (mgr && live()) {
      html += `<div class="bhq-roster-actions">
        <button class="clans-btn" id="bhq-roster-random" type="button" ${roster.length ? "" : "disabled"}>🎲 Randomise teams</button>
        <button class="clans-btn primary" id="bhq-roster-draft" type="button" ${roster.length ? "" : "disabled"}>⚔ Draft teams</button>
      </div>${assigned ? `<div class="bhq-roster-note">Teams are set — redraw any time.</div>` : ""}`;
    }
    html += `<div class="bhq-roster-status" id="bhq-roster-status"></div>`;
    rosterEl.innerHTML = html;

    rosterEl.querySelectorAll(".bhq-team-dot[data-team]").forEach((d) => { d.style.background = teamColor(d.dataset.team); });

    const status = rosterEl.querySelector("#bhq-roster-status");
    const form = rosterEl.querySelector("#bhq-roster-form");
    if (form) form.addEventListener("submit", (e) => {
      e.preventDefault();
      const player = form.player.value.trim();
      if (player) rosterAct("join", { player }, status);
    });
    rosterEl.querySelectorAll("[data-drop]").forEach((b) =>
      b.addEventListener("click", () => rosterAct("drop", { player: b.dataset.drop }, status)));
    const rnd = rosterEl.querySelector("#bhq-roster-random");
    if (rnd) rnd.addEventListener("click", () => {
      if (ev.members && !confirm("Redraw teams at random? This replaces the current lineup.")) return;
      rosterAct("random", {}, status);
    });
    const drf = rosterEl.querySelector("#bhq-roster-draft");
    if (drf) drf.addEventListener("click", openDraft);
  }

  async function rosterAct(kind, payload, status) {
    if (status) { status.className = "bhq-roster-status"; status.textContent = "…"; }
    const token = keys()[clanId];
    try {
      let r;
      if (kind === "join") {
        r = await fetch(`/api/clans/${clanId}/events/${eventId}/join`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        });
      } else if (kind === "drop") {
        r = await fetch(`/api/clans/${clanId}/events/${eventId}/roster/${encodeURIComponent(payload.player)}`, {
          method: "DELETE", headers: { "X-Clan-Token": token },
        });
      } else { // random
        r = await fetch(`/api/clans/${clanId}/events/${eventId}/teams`, {
          method: "POST", headers: { "Content-Type": "application/json", "X-Clan-Token": token },
          body: JSON.stringify({ mode: "random" }),
        });
      }
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "that didn't work");
      ev = body.event;
      render();
    } catch (err) {
      if (status) { status.className = "bhq-roster-status err"; status.textContent = err.message; }
    }
  }

  function renderTeams() {
    if (!ev.teams || !ev.teams.length) { teamsPanel.hidden = true; return; }
    teamsPanel.hidden = false;
    const rows = ev.teams.map((t) => {
      let pts = 0, tiles = 0;
      for (const [i, c] of Object.entries(ev.claims || {})) {
        if (c.team !== t) continue;
        pts += cellOf(Number(i)).pts;
        tiles += 1;
      }
      const teamHas = (i) => i === 12 || (claimOf(i) && claimOf(i).team === t);
      const lines = LINES.filter((l) => l.cells.every(teamHas)).length;
      return { t, pts, tiles, lines };
    }).sort((a, b) => b.pts - a.pts);
    teamsEl.innerHTML = rows.map((r, n) =>
      `<div class="bhq-lb-row"><span class="bhq-lb-rank">#${n + 1}</span>
       <span class="bhq-team-dot"></span>
       <span class="bhq-lb-name">${esc(r.t)}</span>
       <span class="bhq-lb-sub">${r.tiles} tile${r.tiles === 1 ? "" : "s"}${r.lines ? ` · ${r.lines} line${r.lines === 1 ? "" : "s"}` : ""}</span>
       <b>${r.pts.toLocaleString()}</b></div>`).join("");
    // Dot colours via CSSOM (CSP blocks inline style attributes).
    teamsEl.querySelectorAll(".bhq-team-dot").forEach((dot, n) => {
      dot.style.background = teamColor(rows[n].t);
    });
  }

  function renderStats() {
    const claims = Object.keys(ev.claims || {});
    const doneCount = claims.length + 1; // + free centre
    const pts = claims.reduce((n, i) => n + cellOf(Number(i)).pts, 0) + cellOf(12).pts;
    const maxPts = ev.board.reduce((n, _, i) => n + cellOf(i).pts, 0);
    const verified = claims.filter((i) => ev.claims[i].verified).length;
    const linesDone = LINES.filter((l) => l.cells.every(isDone)).length;
    const pc = Math.round((doneCount / 25) * 100);
    statsEl.innerHTML = `
      <div class="bhq-read">
        <span class="bhq-read-v">${pts.toLocaleString()}</span>
        <span class="bhq-read-k">points · of ${maxPts.toLocaleString()}</span>
      </div>
      <div class="bhq-read grow">
        <span class="bhq-track"><span class="bhq-track-fill"></span></span>
        <span class="bhq-read-k">${doneCount} of 25 tiles charted · ${pc}%</span>
      </div>
      <div class="bhq-read">
        <span class="bhq-read-v">${verified}</span>
        <span class="bhq-read-k">verified</span>
      </div>
      <div class="bhq-read">
        <span class="bhq-read-v">${linesDone}<small>/${LINES.length}</small></span>
        <span class="bhq-read-k">constellations</span>
      </div>`;
    // Width via CSSOM — the CSP (rightly) blocks inline style attributes.
    statsEl.querySelector(".bhq-track-fill").style.width = `${pc}%`;
  }

  function renderBoard() {
    boardEl.innerHTML = "";
    const reveal = !boardRevealed;
    for (let i = 0; i < 25; i++) {
      const cell = cellOf(i);
      const st = statusOf(i);
      const el = document.createElement("button");
      el.type = "button";
      el.className = `bhq-tile ${st} t-${tierOf(cell.pts)}${selected === i ? " selected" : ""}${matchesFilter(i) ? "" : " dimmed"}${reveal ? " in" : ""}`;
      if (reveal) el.style.animationDelay = `${i * 22}ms`;
      el.title = cell.name;

      const icon = document.createElement("span");
      icon.className = "bhq-tile-icon";
      if (cell.free) icon.textContent = "★";
      else if (cell.img) {
        const img = document.createElement("img");
        img.alt = ""; img.loading = "lazy";
        img.src = wikiImg(cell.img);
        img.addEventListener("error", () => { icon.textContent = "✦"; });
        icon.appendChild(img);
      } else icon.textContent = "✦";

      const name = document.createElement("span");
      name.className = "bhq-tile-name";
      name.textContent = cell.free ? "FREE TILE" : cell.name;

      const pts = document.createElement("span");
      pts.className = `bhq-tile-pts p-${tierOf(cell.pts)}`;
      pts.textContent = `${cell.pts} pts`;

      const badge = document.createElement("span");
      badge.className = "bhq-tile-badge";
      badge.textContent = st === "verified" ? "◆" : st === "claimed" ? "✓" : st === "free" ? "★" : "";

      el.append(icon, name, pts, badge);
      const claim = claimOf(i);
      if (ev.teams && claim && claim.team) {
        const tag = document.createElement("span");
        tag.className = "bhq-tile-team";
        tag.textContent = claim.team;
        tag.style.color = teamColor(claim.team);
        tag.style.borderColor = teamColor(claim.team);
        el.appendChild(tag);
      }
      el.addEventListener("click", () => { selected = selected === i ? null : i; renderBoard(); renderDetail(); });
      boardEl.appendChild(el);
    }
    boardRevealed = true;
    // Chart the sky once tiles have laid out (staggered reveal delays the
    // first paint, so give the constellation pass a beat).
    if (reveal) setTimeout(drawSky, 25 * 22 + 250);
    else requestAnimationFrame(drawSky);
  }

  // ---- the sky: completed bingo lines drawn as constellations ------------
  // Each finished line becomes a star-line joining its five tiles; the four
  // corners close into a diamond. Blackout is the whole sky, so no line.
  function drawSky() {
    const svg = document.getElementById("bhq-sky");
    if (!svg || !ev || root.hidden) return;
    const stage = svg.parentElement;
    const W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H) return;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const tiles = boardEl.querySelectorAll(".bhq-tile");
    if (tiles.length !== 25) { svg.innerHTML = ""; return; }
    const sr = stage.getBoundingClientRect();
    const centers = [...tiles].map((t) => {
      const r = t.getBoundingClientRect();
      return { x: r.left - sr.left + r.width / 2, y: r.top - sr.top + r.height / 2 };
    });
    let html = "";
    const freshNames = [];
    for (const l of LINES) {
      if (l.cells.length > 5 || !l.cells.every(isDone)) continue;
      const pts = l.cells.map((i) => centers[i]);
      const d = pts.map((p, n) => `${n ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ") +
        (l.name === "Four corners" ? " Z" : "");
      const fresh = !drawnLines.has(l.name);
      if (fresh) freshNames.push(l.name);
      drawnLines.add(l.name);
      html += `<path d="${d}" pathLength="1" class="bhq-sky-line${fresh ? " fresh" : ""}"/>`;
      for (const p of pts) {
        html += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.4" class="bhq-sky-star${fresh ? " fresh" : ""}"/>`;
      }
    }
    svg.innerHTML = html;
    // A line finished while we watched — celebrate it.
    if (!firstSky && freshNames.length) bingoBanner(freshNames[0]);
    firstSky = false;
  }
  let skyResizeTimer = null;
  window.addEventListener("resize", () => {
    if (root.hidden) return;
    clearTimeout(skyResizeTimer);
    skyResizeTimer = setTimeout(drawSky, 150);
  });

  // ---- celebrations --------------------------------------------------------
  const SPARK_GLYPHS = ["✦", "★", "✧", "✶"];
  const SPARK_COLORS = ["#f2df9f", "#8ade7f", "#74b9f0", "#c793f2", "#ffab52"];

  // A shower of stars from a tile — fired when a claim lands.
  function burstAtTile(i) {
    const stage = document.querySelector(".bhq-stage");
    const tile = boardEl.querySelectorAll(".bhq-tile")[i];
    if (!stage || !tile) return;
    const sr = stage.getBoundingClientRect(), tr = tile.getBoundingClientRect();
    const cx = tr.left - sr.left + tr.width / 2, cy = tr.top - sr.top + tr.height / 2;
    for (let n = 0; n < 14; n++) {
      const s = document.createElement("span");
      s.className = "bhq-spark";
      s.textContent = SPARK_GLYPHS[n % SPARK_GLYPHS.length];
      const ang = (n / 14) * Math.PI * 2 + Math.random() * 0.5;
      const dist = 46 + Math.random() * 60;
      s.style.left = `${cx}px`;
      s.style.top = `${cy}px`;
      s.style.color = SPARK_COLORS[n % SPARK_COLORS.length];
      s.style.setProperty("--dx", `${Math.cos(ang) * dist}px`);
      s.style.setProperty("--dy", `${Math.sin(ang) * dist - 18}px`);
      s.style.setProperty("--rot", `${(Math.random() - 0.5) * 320}deg`);
      stage.appendChild(s);
      setTimeout(() => s.remove(), 1000);
    }
  }

  // The big moment: a line is complete.
  function bingoBanner(lineName) {
    const stage = document.querySelector(".bhq-stage");
    if (!stage || stage.querySelector(".bhq-banner")) return;
    const b = document.createElement("div");
    b.className = "bhq-banner";
    b.innerHTML = `<span class="bhq-banner-word">✦ BINGO ✦</span><span class="bhq-banner-line">${esc(lineName)} complete</span>`;
    stage.appendChild(b);
    // rain stars along the whole stage
    const sr = stage.getBoundingClientRect();
    for (let n = 0; n < 26; n++) {
      const s = document.createElement("span");
      s.className = "bhq-spark";
      s.textContent = SPARK_GLYPHS[n % SPARK_GLYPHS.length];
      s.style.left = `${Math.random() * sr.width}px`;
      s.style.top = `${Math.random() * sr.height * 0.6}px`;
      s.style.color = SPARK_COLORS[n % SPARK_COLORS.length];
      s.style.setProperty("--dx", `${(Math.random() - 0.5) * 60}px`);
      s.style.setProperty("--dy", `${40 + Math.random() * 90}px`);
      s.style.setProperty("--rot", `${(Math.random() - 0.5) * 400}deg`);
      s.style.animationDelay = `${Math.random() * 400}ms`;
      stage.appendChild(s);
      setTimeout(() => s.remove(), 1700);
    }
    setTimeout(() => b.remove(), 2600);
  }

  // ---- snake draft ---------------------------------------------------------
  const draftEl = document.getElementById("bhq-draft");
  const draftPoolEl = document.getElementById("bhq-draft-pool");
  const draftTeamsEl = document.getElementById("bhq-draft-teams");
  const draftTurnEl = document.getElementById("bhq-draft-turn");
  let draft = null; // { pool:[], picks:{team:[]}, order:[teamIdx...], step }

  function draftOrder(nTeams, nPlayers) {
    const order = [];
    let round = 0;
    while (order.length < nPlayers) {
      const seq = round % 2 === 0 ? [...Array(nTeams).keys()] : [...Array(nTeams).keys()].reverse();
      for (const t of seq) { if (order.length < nPlayers) order.push(t); }
      round++;
    }
    return order;
  }

  function openDraft() {
    const players = (ev.roster || []).map((r) => r.player);
    if (!players.length) return;
    draft = {
      pool: players.slice(),
      picks: Object.fromEntries(ev.teams.map((t) => [t, []])),
      order: draftOrder(ev.teams.length, players.length),
      step: 0,
    };
    draftEl.hidden = false;
    renderDraft();
  }
  function closeDraft() { draftEl.hidden = true; draft = null; }

  function currentTeam() { return draft.order[draft.step] != null ? ev.teams[draft.order[draft.step]] : null; }

  function renderDraft() {
    const team = currentTeam();
    draftTurnEl.innerHTML = team
      ? `On the clock: <b>${esc(team)}</b> <span class="bhq-draft-clock-dot"></span>`
      : `Draft complete — lock it in.`;
    if (team) { const dot = draftTurnEl.querySelector(".bhq-draft-clock-dot"); if (dot) dot.style.background = teamColor(team); }

    draftPoolEl.innerHTML = draft.pool.length
      ? draft.pool.map((p) => `<button class="bhq-draft-pick" type="button" data-pick="${esc(p)}"${team ? "" : " disabled"}>${esc(p)}</button>`).join("")
      : `<div class="bhq-dim">Everyone's been picked.</div>`;
    draftPoolEl.querySelectorAll("[data-pick]").forEach((b) =>
      b.addEventListener("click", () => pickPlayer(b.dataset.pick)));

    draftTeamsEl.innerHTML = ev.teams.map((t) => {
      const onClock = t === team;
      return `<div class="bhq-draft-team${onClock ? " on" : ""}" data-col="${esc(t)}">
        <div class="bhq-draft-team-head"><span class="bhq-team-dot" data-team="${esc(t)}"></span>${esc(t)}<span class="bhq-draft-count">${draft.picks[t].length}</span></div>
        <div class="bhq-draft-team-list">${draft.picks[t].map((p) => `<span class="bhq-draft-chip">${esc(p)}</span>`).join("") || `<span class="bhq-dim">—</span>`}</div>
      </div>`;
    }).join("");
    draftTeamsEl.querySelectorAll(".bhq-team-dot[data-team]").forEach((d) => { d.style.background = teamColor(d.dataset.team); });
  }

  function pickPlayer(player) {
    const team = currentTeam();
    if (!team) return;
    const idx = draft.pool.findIndex((p) => p === player);
    if (idx < 0) return;
    draft.pool.splice(idx, 1);
    draft.picks[team].push(player);
    draft.step++;
    renderDraft();
  }

  function autofillDraft() {
    while (currentTeam() && draft.pool.length) {
      const i = Math.floor(Math.random() * draft.pool.length);
      pickPlayer(draft.pool[i]);
    }
  }

  async function commitDraft() {
    const status = rosterEl.querySelector("#bhq-roster-status");
    try {
      const r = await fetch(`/api/clans/${clanId}/events/${eventId}/teams`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Clan-Token": keys()[clanId] },
        body: JSON.stringify({ assignments: draft.picks }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "couldn't save teams");
      ev = body.event;
      closeDraft();
      render();
    } catch (err) {
      if (status) { status.className = "bhq-roster-status err"; status.textContent = err.message; }
      closeDraft();
    }
  }

  document.getElementById("bhq-draft-close").addEventListener("click", closeDraft);
  document.getElementById("bhq-draft-auto").addEventListener("click", autofillDraft);
  document.getElementById("bhq-draft-commit").addEventListener("click", commitDraft);

  function renderDetail() {
    if (selected == null) {
      detailEl.innerHTML = `<div class="bhq-panel-title">TILE DETAIL</div>
        <div class="bhq-dim">Pick a tile from the sky — claim it for your points, or verify a clanmate's catch.</div>`;
      return;
    }
    const i = selected, cell = cellOf(i), claim = claimOf(i), st = statusOf(i);
    const stLabel = { open: "available", claimed: "claimed — awaiting verification", verified: "verified ◆", free: "free tile ★" }[st];
    let html = `<div class="bhq-panel-title">TILE DETAIL</div>
      <div class="bhq-d-head">
        <span class="bhq-d-icon">${cell.img ? `<img src="${esc(wikiImg(cell.img))}" alt="">` : (cell.free ? "★" : "✦")}</span>
        <div><div class="bhq-d-name">${esc(cell.name)}</div>
        <div class="bhq-d-meta"><b>${cell.pts} pts</b> · <span class="bhq-st ${st}">${stLabel}</span></div></div>
      </div>`;

    if (claim) {
      html += `<div class="bhq-d-claim">
        <div>Claimed by <b>${esc(claim.player)}</b>${claim.team ? ` for <b>${esc(claim.team)}</b>` : ""} · ${ago(claim.at)}</div>
        ${claim.note ? `<div class="bhq-dim">“${esc(claim.note)}”</div>` : ""}
        ${proofHtml(claim.proof)}
        ${claim.verified ? `<div class="bhq-verified">◆ verified by the clan leader</div>` : (claim.proof ? "" : `<div class="bhq-dim">no proof attached — drop a screenshot link when claiming</div>`)}
      </div>`;
      if (isManager()) {
        html += `<div class="bhq-d-actions">
          <button class="clans-btn primary" data-act="verify" type="button">${claim.verified ? "Unverify" : "◆ Verify claim"}</button>
          <button class="clans-btn ghost" data-act="unclaim" type="button">Remove claim</button>
        </div>`;
      }
    } else if (cell.free) {
      html += `<div class="bhq-dim">The centre is everyone's — it counts toward every line.</div>`;
    } else if (live()) {
      const acct = window.WOM && window.WOM.account;
      const lastTeam = (() => { try { return localStorage.getItem("wom.bingo.team") || ""; } catch { return ""; } })();
      // Once teams are assigned, a player claims for their own team — so lock
      // the select to it if we know who they are.
      const myTeam = acct ? teamForPlayer(acct.player) : null;
      const preset = myTeam || lastTeam;
      const teamSelect = ev.teams
        ? `<select name="team"${myTeam ? " disabled" : ""}>${["<option value=\"\">— pick your team —</option>"]
            .concat(ev.teams.map((t) => `<option value="${esc(t)}"${t === preset ? " selected" : ""}>${esc(t)}</option>`)).join("")}</select>`
        : "";
      html += `<form class="bhq-claim-form" data-act="claim">
        <input name="player" type="text" maxlength="20" placeholder="your RSN" spellcheck="false"
               value="${esc(acct ? acct.player : "")}" />
        ${teamSelect}
        <input name="note" type="text" maxlength="120" placeholder="note — e.g. got it 3rd kill (optional)" />
        <input name="proof" type="url" maxlength="300" placeholder="proof link — Discord/Imgur screenshot URL (optional)" spellcheck="false" />
        <button class="clans-btn primary" type="submit">Claim tile</button>
      </form>`;
    } else {
      html += `<div class="bhq-dim">The event has ended — no more claims.</div>`;
    }
    html += `<div class="bhq-d-status" id="bhq-d-status"></div>`;
    detailEl.innerHTML = html;

    // Sprite fallback (CSP forbids inline handlers).
    const dImg = detailEl.querySelector(".bhq-d-icon img");
    if (dImg) dImg.addEventListener("error", () => { dImg.parentElement.textContent = "✦"; });

    const status = detailEl.querySelector("#bhq-d-status");
    // Proof thumbnails fall back to a plain link if the image won't load.
    const pImg = detailEl.querySelector(".bhq-proof img");
    if (pImg) pImg.addEventListener("error", () => {
      pImg.closest("a").innerHTML = `<span class="bhq-proof-link">view proof ↗</span>`;
    });

    const form = detailEl.querySelector("[data-act=claim]");
    if (form) form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const team = form.team ? form.team.value : "";
      if (team) { try { localStorage.setItem("wom.bingo.team", team); } catch {} }
      await act("claim", {
        tile: i,
        player: form.player.value.trim(),
        team,
        note: form.note.value.trim(),
        proof: form.proof.value.trim(),
      }, status);
    });
    const vBtn = detailEl.querySelector("[data-act=verify]");
    if (vBtn) vBtn.addEventListener("click", () => act("verify", { tile: i }, status));
    const uBtn = detailEl.querySelector("[data-act=unclaim]");
    if (uBtn) uBtn.addEventListener("click", () => act("unclaim", { tile: i }, status));
  }

  async function act(kind, payload, status) {
    status.textContent = "…";
    status.className = "clans-status";
    const token = keys()[clanId];
    try {
      let r;
      if (kind === "claim") {
        r = await fetch(`/api/clans/${clanId}/events/${eventId}/claim`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else if (kind === "verify") {
        r = await fetch(`/api/clans/${clanId}/events/${eventId}/verify`, {
          method: "POST", headers: { "Content-Type": "application/json", "X-Clan-Token": token },
          body: JSON.stringify(payload),
        });
      } else {
        r = await fetch(`/api/clans/${clanId}/events/${eventId}/claim/${payload.tile}`, {
          method: "DELETE", headers: { "X-Clan-Token": token },
        });
      }
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "that didn't work");
      ev = body.event;
      render();
      if (kind === "claim") requestAnimationFrame(() => burstAtTile(payload.tile));
    } catch (err) {
      status.className = "clans-status err";
      status.textContent = err.message;
    }
  }

  function renderLines() {
    linesEl.innerHTML = LINES.map((l) => {
      const done = l.cells.filter(isDone).length;
      const complete = done === l.cells.length;
      return `<div class="bhq-line${complete ? " done" : ""}">
        <span>${complete ? "✦" : "·"} ${esc(l.name)}</span>
        <b>${done}/${l.cells.length}</b></div>`;
    }).join("");
  }

  function renderLeaderboard() {
    const by = {};
    for (const [i, c] of Object.entries(ev.claims || {})) {
      const k = c.player;
      by[k] = by[k] || { pts: 0, tiles: 0, verified: 0 };
      by[k].pts += cellOf(Number(i)).pts;
      by[k].tiles += 1;
      if (c.verified) by[k].verified += 1;
    }
    const rows = Object.entries(by).sort((a, b) => b[1].pts - a[1].pts).slice(0, 8);
    lbEl.innerHTML = rows.length
      ? rows.map(([p, s], n) =>
          `<div class="bhq-lb-row"><span class="bhq-lb-rank">#${n + 1}</span>
           <span class="bhq-lb-name">${esc(p)}</span>
           <span class="bhq-lb-sub">${s.tiles} tile${s.tiles === 1 ? "" : "s"}${s.verified ? ` · ${s.verified}◆` : ""}</span>
           <b>${s.pts.toLocaleString()}</b></div>`).join("")
      : `<div class="bhq-dim">No claims yet — first tile takes the lead.</div>`;
  }

  function renderFeed() {
    const items = (ev.activity || []).slice(-12).reverse();
    feedEl.innerHTML = items.length
      ? items.map((a) => `<div class="bhq-feed-row"><span>${esc(a.text)}</span><small>${ago(a.at)}</small></div>`).join("")
      : `<div class="bhq-dim">Quiet so far. Claims will appear here.</div>`;
  }
})();
