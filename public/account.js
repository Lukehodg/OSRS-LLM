/* Link Account — pulls skills (hiscores) and quests/diaries (RuneLite
   WikiSync plugin via sync.runescape.wiki), plus an optional bank paste
   (RuneLite Bank Memory plugin). Everything lands in window.WOM.account,
   and app.js sends a digest with every chat so answers fit the player. */

(function () {
  const panel = document.getElementById("acct");
  const openBtn = document.getElementById("acct-open");
  const launchLabel = document.getElementById("acct-launch-label");
  const form = document.getElementById("acct-form");
  const rsnEl = document.getElementById("acct-rsn");
  const statusEl = document.getElementById("acct-status");
  const summaryEl = document.getElementById("acct-summary");
  const bankEl = document.getElementById("acct-bank");
  const bankSave = document.getElementById("acct-bank-save");
  const unlinkBtn = document.getElementById("acct-unlink");

  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const account = () => (window.WOM && window.WOM.account) || null;

  function open() {
    panel.hidden = false;
    const a = account();
    if (a) { rsnEl.value = a.player; renderSummary(); }
    setTimeout(() => rsnEl.focus(), 50);
  }
  function close() { panel.hidden = true; }
  openBtn.addEventListener("click", open);
  panel.addEventListener("click", (e) => { if (e.target.hasAttribute("data-acct-dismiss")) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) close(); });

  function refreshLauncher() {
    const a = account();
    launchLabel.innerHTML = a ? `${esc(a.player)}&nbsp;✓` : "Link&nbsp;Account";
    unlinkBtn.hidden = !a;
  }
  refreshLauncher();

  // ---- link flow ----
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = rsnEl.value.trim();
    if (!name) return;
    statusEl.className = "clans-status";
    statusEl.textContent = "scrying the hiscores…";
    summaryEl.hidden = true;

    let skills = null;
    try {
      const r = await fetch(`/api/hiscores?player=${encodeURIComponent(name)}`);
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "hiscores lookup failed");
      skills = body.skills;
    } catch (err) {
      statusEl.className = "clans-status err";
      statusEl.textContent = err.message;
      return;
    }

    statusEl.textContent = "reading your RuneLite WikiSync data…";
    let quests = null, diaries = null, wikiSyncOk = false;
    try {
      const r = await fetch(`/api/runelite/${encodeURIComponent(name)}`);
      const body = await r.json();
      if (r.ok) { quests = body.quests; diaries = body.diaries; wikiSyncOk = true; }
    } catch { /* optional — hiscores alone still links */ }

    window.WOM.setAccount({ player: name, skills, quests, diaries });
    statusEl.className = "clans-status ok";
    statusEl.textContent = wikiSyncOk
      ? "linked — skills, quests and diaries loaded."
      : "linked with skills only — no WikiSync data found (enable the WikiSync plugin in RuneLite and log in once).";
    refreshLauncher();
    renderSummary();
  });

  bankSave.addEventListener("click", () => {
    const a = account();
    if (!a) { statusEl.className = "clans-status err"; statusEl.textContent = "Link your account first."; return; }
    const bank = bankEl.value.trim().slice(0, 4000);
    window.WOM.setAccount({ player: a.player, bank: bank || undefined });
    statusEl.className = "clans-status ok";
    statusEl.textContent = bank ? "bank saved — the sage will consider what you own." : "bank cleared.";
    renderSummary();
  });

  unlinkBtn.addEventListener("click", () => {
    window.WOM.setAccount(null);
    summaryEl.hidden = true;
    rsnEl.value = "";
    bankEl.value = "";
    statusEl.className = "clans-status";
    statusEl.textContent = "unlinked.";
    refreshLauncher();
  });

  // ---- summary ----
  function renderSummary() {
    const a = account();
    if (!a) return;
    const combatSkills = ["Attack", "Strength", "Defence", "Hitpoints", "Ranged", "Magic", "Prayer", "Slayer"];
    const chips = a.skills
      ? combatSkills.map((s) => `<span class="acct-chip">${s.slice(0, 4)} <b>${a.skills[s]?.level ?? "—"}</b></span>`).join("")
      : "";
    const questLine = a.quests
      ? `<div class="acct-line">📜 Quests: <b>${a.quests.complete}/${a.quests.total}</b> complete` +
        (a.quests.inProgress?.length ? ` · in progress: ${esc(a.quests.inProgress.slice(0, 4).join(", "))}${a.quests.inProgress.length > 4 ? "…" : ""}` : "") + `</div>`
      : `<div class="acct-line dim">📜 Quests unknown — WikiSync not found for this name.</div>`;
    const bankLine = a.bank
      ? `<div class="acct-line">🏦 Bank noted (${a.bank.length} chars, stored on this device)</div>`
      : "";
    summaryEl.innerHTML =
      `<div class="acct-line"><b>${esc(a.player)}</b> is linked — every answer is tailored to this account.</div>` +
      `<div class="acct-chips">${chips}</div>` + questLine + bankLine;
    summaryEl.hidden = false;
    if (a.bank) bankEl.value = a.bank;
  }
})();
