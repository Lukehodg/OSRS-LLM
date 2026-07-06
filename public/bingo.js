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

  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const keys = () => { try { return JSON.parse(localStorage.getItem("wom.clan.keys")) || {}; } catch { return {}; } };

  let clanId = null, eventId = null, clan = null, ev = null;
  let selected = null, filter = "all";
  let clockTimer = null, pollTimer = null;
  let drawnLines = new Set(); // constellations already drawn (skip re-animation)
  let boardRevealed = false;  // stagger the tile reveal only on open

  // ---- open / close --------------------------------------------------------
  window.openBingo = async function (cid, eid) {
    clanId = cid; eventId = eid; selected = null; filter = "all";
    drawnLines = new Set();
    boardRevealed = false;
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
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !root.hidden) close(); });

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
    filtersEl.querySelectorAll("[data-filter]").forEach((b) =>
      b.classList.toggle("active", b.dataset.filter === filter));
  }
  const matchesFilter = (i) => filter === "all" || statusOf(i) === filter ||
    (filter === "verified" && statusOf(i) === "free");

  // ---- render ---------------------------------------------------------------
  function render() {
    titleEl.textContent = `${clan.name} — Bingo`.toUpperCase();
    subEl.textContent = ev.theme ? `“${ev.theme}”` : (ev.aiBoard ? "board conjured by the sage" : "");
    tickClock();
    renderStats();
    renderBoard();
    renderDetail();
    renderLines();
    renderTeams();
    renderLeaderboard();
    renderFeed();
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
      el.className = `bhq-tile ${st}${selected === i ? " selected" : ""}${matchesFilter(i) ? "" : " dimmed"}${reveal ? " in" : ""}`;
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
      pts.className = "bhq-tile-pts";
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
    for (const l of LINES) {
      if (l.cells.length > 5 || !l.cells.every(isDone)) continue;
      const pts = l.cells.map((i) => centers[i]);
      const d = pts.map((p, n) => `${n ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ") +
        (l.name === "Four corners" ? " Z" : "");
      const fresh = !drawnLines.has(l.name);
      drawnLines.add(l.name);
      html += `<path d="${d}" pathLength="1" class="bhq-sky-line${fresh ? " fresh" : ""}"/>`;
      for (const p of pts) {
        html += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.4" class="bhq-sky-star${fresh ? " fresh" : ""}"/>`;
      }
    }
    svg.innerHTML = html;
  }
  let skyResizeTimer = null;
  window.addEventListener("resize", () => {
    if (root.hidden) return;
    clearTimeout(skyResizeTimer);
    skyResizeTimer = setTimeout(drawSky, 150);
  });

  function renderDetail() {
    if (selected == null) {
      detailEl.innerHTML = `<div class="bhq-panel-title">TILE DETAIL</div>
        <div class="bhq-dim">Select a tile to see its points, claim it, or verify a claim.</div>`;
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
      const teamSelect = ev.teams
        ? `<select name="team">${["<option value=\"\">— pick your team —</option>"]
            .concat(ev.teams.map((t) => `<option value="${esc(t)}"${t === lastTeam ? " selected" : ""}>${esc(t)}</option>`)).join("")}</select>`
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
