/* Clan Hall — register clans (Discord / Wise Old Man linked), browse them,
   and run events: Boss of the Week, Skill of the Week, Bingo. */

(function () {
  const panel = document.getElementById("clans");
  const tabs = document.querySelectorAll(".clans-tab");
  const panes = {
    browse: document.getElementById("clans-browse"),
    register: document.getElementById("clans-register"),
    manage: document.getElementById("clans-manage"),
  };
  const regStatus = document.getElementById("clan-reg-status");

  // Clan keys owned by this device: { clanId: token }
  const keys = (() => { try { return JSON.parse(localStorage.getItem("wom.clan.keys")) || {}; } catch { return {}; } })();
  const saveKeys = () => { try { localStorage.setItem("wom.clan.keys", JSON.stringify(keys)); } catch {} };

  let clanList = [];

  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fmtLeft = (ms) => {
    const d = Math.floor(ms / 86_400_000), h = Math.floor((ms % 86_400_000) / 3_600_000);
    return d > 0 ? `${d}d ${h}h left` : h > 0 ? `${h}h left` : "ending soon";
  };
  const EVENT_META = {
    botw: { icon: "⚔️", label: "Boss of the Week" },
    sotw: { icon: "📈", label: "Skill of the Week" },
    bingo: { icon: "🎲", label: "Bingo" },
  };

  // ---- open/close + tabs ----
  function open() { panel.hidden = false; setTab("browse"); loadClans(); }
  function close() { panel.hidden = true; }
  panel.addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-clans-dismiss")) return close();
    const b = e.target.closest("[data-bingo]");
    if (b && window.openBingo) {
      const [cid, eid] = b.dataset.bingo.split(":");
      close();
      window.openBingo(cid, eid);
    }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) close(); });

  function setTab(name) {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    for (const [k, el] of Object.entries(panes)) el.hidden = k !== name;
    if (name === "manage") renderManage();
  }
  tabs.forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));

  // ---- browse ----
  async function loadClans() {
    panes.browse.innerHTML = `<div class="clans-loading">consulting the registry…</div>`;
    try {
      const r = await fetch("/api/clans");
      const body = await r.json();
      clanList = body.clans || [];
      renderBrowse();
    } catch {
      panes.browse.innerHTML = `<div class="clans-err">The clan registry is unreachable.</div>`;
    }
  }

  function eventCard(ev, clan, manage) {
    const meta = EVENT_META[ev.type] || { icon: "📅", label: ev.type };
    const live = ev.endsAt > Date.now();
    let body = "";
    if (ev.type === "bingo" && ev.board) {
      const cells = ev.board.map((t, i) => {
        const name = typeof t === "string" ? t : t.name;
        const claim = ev.claims && ev.claims[i];
        const st = i === 12 ? "free" : claim ? (claim.verified ? "verified" : "claimed") : "";
        return `<div class="bingo-mini-cell ${st}" title="${esc(name)}"></div>`;
      }).join("");
      const done = ev.claims ? Object.keys(ev.claims).length + 1 : 1;
      body = `<div class="bingo-mini-row">
        <div class="bingo-mini">${cells}</div>
        <div class="bingo-mini-info">
          <div class="bingo-mini-count"><b>${done}</b>/25 tiles</div>
          ${ev.aiBoard ? `<div class="clans-note">✦ conjured by the sage</div>` : ""}
          <button class="clans-btn primary" data-bingo="${clan.id}:${ev.id}" type="button">Open board ⌁</button>
        </div>
      </div>`;
    }
    return `<div class="event${live ? "" : " over"}">
      <div class="event-head">
        <span class="event-type">${meta.icon} ${meta.label}${ev.target ? ` — <b>${esc(ev.target)}</b>` : ""}</span>
        <span class="event-when">${live ? fmtLeft(ev.endsAt - Date.now()) : "finished"}</span>
        ${manage ? `<button class="event-x" data-del="${clan.id}:${ev.id}" title="Remove event">✕</button>` : ""}
      </div>${body}</div>`;
  }

  function clanCard(clan, manage) {
    const links =
      (clan.discord ? `<a href="${esc(clan.discord)}" target="_blank" rel="noopener">Discord ↗</a>` : "") +
      (clan.wom ? `<a href="https://wiseoldman.net/groups/${clan.wom.id}" target="_blank" rel="noopener">WOM: ${esc(clan.wom.name)}${clan.wom.memberCount ? ` (${clan.wom.memberCount})` : ""} ↗</a>` : "");
    const live = (clan.events || []).filter((e) => e.endsAt > Date.now());
    return `<div class="clan">
      <div class="clan-head">
        <span class="clan-name">${esc(clan.name)}</span>
        <span class="clan-links">${links || `<span class="clans-note">no links</span>`}</span>
      </div>
      ${clan.description ? `<div class="clan-desc">${esc(clan.description)}</div>` : ""}
      ${live.length
        ? live.map((ev) => eventCard(ev, clan, manage)).join("")
        : `<div class="clans-note">no active events</div>`}
    </div>`;
  }

  function renderBrowse() {
    if (!clanList.length) {
      panes.browse.innerHTML = `<div class="clans-loading">No clans registered yet — be the first.</div>`;
      return;
    }
    panes.browse.innerHTML = clanList.map((c) => clanCard(c, false)).join("");
  }

  // ---- register ----
  panes.register.addEventListener("submit", async (e) => {
    e.preventDefault();
    regStatus.textContent = "registering…";
    regStatus.className = "clans-status";
    try {
      const r = await fetch("/api/clans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: document.getElementById("clan-name").value,
          description: document.getElementById("clan-desc").value,
          discord: document.getElementById("clan-discord").value.trim(),
          webhook: document.getElementById("clan-webhook").value.trim(),
          womGroupId: document.getElementById("clan-wom").value || undefined,
        }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "registration failed");
      keys[body.clan.id] = body.token;
      saveKeys();
      regStatus.className = "clans-status ok";
      regStatus.textContent = `“${body.clan.name}” registered — clan key saved on this device.`;
      panes.register.reset();
      await loadClans();
      setTab("manage");
    } catch (err) {
      regStatus.className = "clans-status err";
      regStatus.textContent = err.message;
    }
  });

  // ---- manage ----
  function renderManage() {
    const mine = clanList.filter((c) => keys[c.id]);
    if (!mine.length) {
      panes.manage.innerHTML =
        `<div class="clans-loading">No clan key on this device. Register a clan (or re-register) to manage events.</div>`;
      return;
    }
    panes.manage.innerHTML = mine.map((clan) => `
      <div class="clan manage" data-clan="${clan.id}">
        <div class="clan-head">
          <span class="clan-name">${esc(clan.name)}</span>
          <span class="clan-hook${clan.hasWebhook ? " on" : ""}">${clan.hasWebhook ? "📣 announcements on" : "📣 no webhook"}</span>
        </div>
        <details class="clan-hook-set">
          <summary>${clan.hasWebhook ? "Change or remove the Discord webhook" : "Announce events to Discord (add a webhook)"}</summary>
          <form class="hook-form" data-hook="${clan.id}">
            <input name="webhook" type="url" maxlength="200" placeholder="https://discord.com/api/webhooks/… (empty = off)" spellcheck="false" />
            <button class="clans-btn" type="submit">Save</button>
          </form>
        </details>
        <form class="event-form" data-clan="${clan.id}">
          <select name="type">
            <option value="botw">⚔️ Boss of the Week</option>
            <option value="sotw">📈 Skill of the Week</option>
            <option value="bingo">🎲 Bingo (board is generated)</option>
          </select>
          <input name="target" type="text" maxlength="60" placeholder="boss / skill name" />
          <input name="theme" type="text" maxlength="160" placeholder="bingo theme (optional)" hidden />
          <input name="teams" type="text" maxlength="200" placeholder="teams — e.g. Bandos, Zamorak (optional)" hidden />
          <select name="days">
            <option value="7">1 week</option><option value="3">3 days</option><option value="14">2 weeks</option>
          </select>
          <button class="clans-btn primary" type="submit">Create</button>
        </form>
        <div class="clans-status" data-status="${clan.id}"></div>
        ${(clan.events || []).map((ev) => eventCard(ev, clan, true)).join("") || `<div class="clans-note">no events yet</div>`}
      </div>`).join("");

    // per-form behaviour
    panes.manage.querySelectorAll(".event-form").forEach((form) => {
      const typeSel = form.querySelector("[name=type]");
      const target = form.querySelector("[name=target]");
      const theme = form.querySelector("[name=theme]");
      const teams = form.querySelector("[name=teams]");
      const sync = () => {
        const bingo = typeSel.value === "bingo";
        target.hidden = bingo;
        theme.hidden = !bingo;
        teams.hidden = !bingo;
      };
      typeSel.addEventListener("change", sync);
      sync();
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const clanId = form.dataset.clan;
        const status = panes.manage.querySelector(`[data-status="${clanId}"]`);
        status.className = "clans-status";
        status.textContent = typeSel.value === "bingo" ? "conjuring a board…" : "creating…";
        try {
          const r = await fetch(`/api/clans/${clanId}/events`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Clan-Token": keys[clanId] },
            body: JSON.stringify({
              type: typeSel.value,
              target: target.value,
              theme: theme.value,
              teams: teams.value,
              days: form.querySelector("[name=days]").value,
            }),
          });
          const body = await r.json();
          if (!r.ok) throw new Error(body.error || "failed");
          status.className = "clans-status ok";
          status.textContent = "event created.";
          await loadClans();
          renderManage();
        } catch (err) {
          status.className = "clans-status err";
          status.textContent = err.message;
        }
      });
    });

    // webhook set/clear
    panes.manage.querySelectorAll(".hook-form").forEach((form) => {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const clanId = form.dataset.hook;
        const status = panes.manage.querySelector(`[data-status="${clanId}"]`);
        status.className = "clans-status";
        status.textContent = "saving webhook…";
        try {
          const r = await fetch(`/api/clans/${clanId}/webhook`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Clan-Token": keys[clanId] },
            body: JSON.stringify({ webhook: form.webhook.value.trim() }),
          });
          const body = await r.json();
          if (!r.ok) throw new Error(body.error || "failed");
          status.className = "clans-status ok";
          status.textContent = body.hasWebhook ? "webhook saved — announcements on." : "webhook removed.";
          await loadClans();
          renderManage();
        } catch (err) {
          status.className = "clans-status err";
          status.textContent = err.message;
        }
      });
    });

    // deletes
    panes.manage.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const [clanId, eventId] = btn.dataset.del.split(":");
        await fetch(`/api/clans/${clanId}/events/${eventId}`, {
          method: "DELETE",
          headers: { "X-Clan-Token": keys[clanId] },
        }).catch(() => {});
        await loadClans();
        renderManage();
      });
    });
  }

  document.getElementById("clans") && (window.openClans = open);
})();
