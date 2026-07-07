/* Constellation pickers — clicking SKILLING / COMBAT / QUESTS on the star
   chart opens an in-UI grid to choose a skill, boss or quest. Selecting one
   asks the Wise Old Man about it. Depends on window.WOM (app.js).

   Each config: { title, sub, cols, items: [{ name, icon, img?, prompt }] }
   `img` is an OSRS Wiki file (Special:FilePath); `icon` is the emoji fallback. */

(function () {
  const CONFIGS = {
    // ---- Skills: 23 skills in the in-game skills-tab order ----
    skills: {
      title: "CHOOSE A SKILL",
      sub: "Pick a skill and the old man will chart the best way to train it.",
      cols: 3,
      items: [
        ["Attack", "⚔️", "Attack_icon"], ["Hitpoints", "❤️", "Hitpoints_icon"], ["Mining", "⛏️", "Mining_icon"],
        ["Strength", "💪", "Strength_icon"], ["Agility", "🏃", "Agility_icon"], ["Smithing", "🔨", "Smithing_icon"],
        ["Defence", "🛡️", "Defence_icon"], ["Herblore", "⚗️", "Herblore_icon"], ["Fishing", "🎣", "Fishing_icon"],
        ["Ranged", "🏹", "Ranged_icon"], ["Thieving", "🗝️", "Thieving_icon"], ["Cooking", "🍳", "Cooking_icon"],
        ["Prayer", "🙏", "Prayer_icon"], ["Crafting", "🧵", "Crafting_icon"], ["Firemaking", "🔥", "Firemaking_icon"],
        ["Magic", "🔮", "Magic_icon"], ["Fletching", "🪶", "Fletching_icon"], ["Woodcutting", "🪓", "Woodcutting_icon"],
        ["Runecraft", "🌀", "Runecraft_icon"], ["Slayer", "💀", "Slayer_icon"], ["Farming", "🌿", "Farming_icon"],
        ["Construction", "🏠", "Construction_icon"], ["Hunter", "🦡", "Hunter_icon"],
      ].map(([name, icon, img]) => ({
        name, icon, img,
        prompt:
          `What are the best ways to train ${name} in Old School RuneScape right now? ` +
          `Give me efficient methods with rough XP/hour at low, mid and high levels, ` +
          `the fastest route to 99, and any ironman-friendly or AFK options. Keep it practical.`,
      })),
    },

    // ---- Bosses: iconic PvM targets, icon = a signature drop.
    // reqs = *recommended* stats, used to badge readiness when an account
    // is loaded (not hard requirements). ----
    bosses: {
      title: "CHOOSE A BOSS",
      sub: "Pick a boss and the old man will give you the strategy, gear and requirements.",
      cols: 3,
      items: [
        ["Zulrah", "🐍", "Tanzanite_fang", { Ranged: 75, Magic: 75 }],
        ["Vorkath", "🐲", "Dragonbone_necklace", { Ranged: 75, Defence: 70 }],
        ["Barrows", "⚰️", "Dharok's_greataxe", { Attack: 70, Magic: 60 }],
        ["General Graardor", "🐗", "Bandos_chestplate", { Attack: 70, Strength: 70, Defence: 70 }],
        ["K'ril Tsutsaroth", "😈", "Staff_of_the_dead", { Attack: 70, Strength: 70, Defence: 70 }],
        ["Commander Zilyana", "🕊️", "Saradomin_sword", { Ranged: 75, Defence: 70 }],
        ["Kree'arra", "🦅", "Armadyl_crossbow", { Ranged: 75, Defence: 70 }],
        ["Kraken", "🦑", "Trident_of_the_seas", { Slayer: 87, Magic: 75 }],
        ["Cerberus", "🐕", "Primordial_boots", { Slayer: 91, Attack: 75 }],
        ["Alchemical Hydra", "🐉", "Brimstone_ring", { Slayer: 95, Ranged: 75 }],
        ["Corporeal Beast", "👾", "Spirit_shield", { Attack: 75, Strength: 80 }],
        ["The Nightmare", "🌙", "Nightmare_staff", { Attack: 75, Strength: 80, Defence: 75 }],
        ["Nex", "❄️", "Zaryte_crossbow", { Ranged: 85, Defence: 80 }],
        ["Chambers of Xeric", "🗿", "Twisted_bow", { Attack: 80, Strength: 80, Ranged: 80, Magic: 80 }],
        ["Theatre of Blood", "🩸", "Scythe_of_vitur", { Attack: 85, Strength: 85, Ranged: 85, Defence: 80 }],
        ["Tombs of Amascut", "🏛️", "Tumeken's_shadow", { Ranged: 75, Magic: 75 }],
        ["The Inferno", "🌋", "Infernal_cape", { Ranged: 90, Prayer: 74 }],
        ["Fight Caves (Jad)", "🔥", "Fire_cape", { Ranged: 70, Prayer: 43 }],
      ].map(([name, icon, img, reqs]) => ({
        name, icon, img, reqs,
        prompt:
          `How do I take on ${name} in Old School RuneScape? Cover the requirements ` +
          `(quests, stats), recommended and budget gear, inventory and prayers, and the ` +
          `core strategy and mechanics I need to know. Note ironman considerations.`,
      })),
    },

    // Quests live in their own searchable, wiki-backed flow (see openQuests).
  };

  const panel = document.getElementById("picker");
  const titleEl = document.getElementById("picker-title");
  const subEl = document.getElementById("picker-sub");
  const grid = document.getElementById("picker-grid");
  const detailEl = document.getElementById("picker-detail");
  const questsWrap = document.getElementById("picker-quests");
  const qSearch = document.getElementById("picker-qsearch");
  const qList = document.getElementById("picker-qlist");

  const wikiImg = (name) =>
    `https://oldschool.runescape.wiki/w/Special:FilePath/${encodeURIComponent(name + ".png")}`;
  const wikiUrl = (page) => `https://oldschool.runescape.wiki/w/${encodeURIComponent(String(page))}`;
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // ---- curated skill guides (lazy-loaded, cached) ----
  const dataCache = {};
  function loadData(key) {
    if (dataCache[key]) return dataCache[key];
    dataCache[key] = fetch("skills-data.json").then((r) => r.json()).catch(() => ({}));
    return dataCache[key];
  }

  // ---- account context (set by Ironman Path, shared via window.WOM) ----
  const account = () => (window.WOM && window.WOM.account) || null;
  const lvl = (skill) => {
    const a = account();
    return a && a.skills[skill] ? a.skills[skill].level : null;
  };
  // Does a level fall inside a method's range string like "58–99" / "1–40"?
  function rangeHas(range, level) {
    if (level == null) return false;
    const m = String(range).match(/(\d+)\s*[–-]\s*(\d+)/);
    if (!m) return false;
    return level >= +m[1] && level <= +m[2];
  }

  // For bosses: first recommended stat the player is under, or null if ready.
  function firstGap(reqs) {
    if (!reqs) return null;
    for (const [skill, need] of Object.entries(reqs)) {
      const have = lvl(skill);
      if (have != null && have < need) return { skill, have, need };
    }
    return null;
  }

  function accountLine(item, key) {
    const a = account();
    if (!a) return "";
    if (key === "skills") {
      const have = lvl(item.name);
      return have != null ? ` For context, I'm ${a.player} and my current ${item.name} level is ${have}.` : "";
    }
    if (key === "bosses" && item.reqs) {
      const mine = Object.keys(item.reqs)
        .map((s) => `${s} ${lvl(s) ?? "?"}`)
        .join(", ");
      return ` For context, I'm ${a.player} — my relevant stats: ${mine}. Tailor the advice to those levels.`;
    }
    return "";
  }

  function render(cfg, key) {
    titleEl.textContent = cfg.title;
    const a = account();
    subEl.textContent = cfg.sub + (a && key !== "quests" ? ` (levels from ${a.player})` : "");
    grid.style.gridTemplateColumns = `repeat(${cfg.cols || 3}, 1fr)`;
    grid.innerHTML = "";
    for (const item of cfg.items) {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "picker-tile";
      tile.title = item.name;

      const ic = document.createElement("span");
      ic.className = "picker-icon";
      if (item.img) {
        const img = document.createElement("img");
        img.className = "picker-img";
        img.alt = "";
        img.src = wikiImg(item.img);
        img.addEventListener("error", () => { ic.textContent = item.icon; });
        ic.appendChild(img);
      } else {
        ic.textContent = item.icon;
      }

      const label = document.createElement("span");
      label.className = "picker-label";
      label.textContent = item.name;
      tile.append(ic, label);

      // Personalised badges when an account is loaded.
      if (key === "skills") {
        const have = lvl(item.name);
        if (have != null) {
          const b = document.createElement("span");
          b.className = "picker-badge lv" + (have >= 99 ? " maxed" : "");
          b.textContent = have >= 99 ? "99 ✦" : "Lv " + have;
          tile.appendChild(b);
        }
      } else if (key === "bosses" && account() && item.reqs) {
        const gap = firstGap(item.reqs);
        const b = document.createElement("span");
        b.className = "picker-badge " + (gap ? "gap" : "ready");
        b.textContent = gap ? `${gap.skill} ${gap.have}/${gap.need}` : "✓ ready";
        tile.appendChild(b);
      }

      tile.addEventListener("click", () => {
        // Skills & quests open a reference panel; bosses go straight to chat.
        if (key === "skills") showDetail(key, item);
        else { close(); if (window.WOM) window.WOM.ask(item.prompt + accountLine(item, key)); }
      });
      grid.appendChild(tile);
    }
  }

  // -------------------------------------------------------------------------
  // Reference detail (skills / quests) — the real payoff over a chat box.
  // -------------------------------------------------------------------------
  function showDetail(key, item) {
    titleEl.textContent = item.name.toUpperCase();
    subEl.textContent = "";
    grid.hidden = true;
    detailEl.hidden = false;
    detailEl.innerHTML = `<div class="pd-loading">consulting the archives…</div>`;
    loadData(key).then((db) => {
      detailEl.innerHTML = skillDetail(item, db[item.name]);
      wireDetail(key, item);
    });
  }

  const iconHtml = (item) =>
    item.img
      ? `<img class="pd-icon-img" src="${esc(wikiImg(item.img))}" alt="" data-fallback="${esc(item.icon)}">`
      : esc(item.icon);

  function skillDetail(item, s) {
    const have = lvl(item.name);
    const levelBadge = have != null ? `<span class="pd-lvl">${have >= 99 ? "99 ✦" : "Lv " + have}</span>` : "";
    if (!s) return backBtn() + `<div class="pd-head"><span class="pd-icon">${iconHtml(item)}</span><h3>${esc(item.name)}</h3>${levelBadge}</div><p class="pd-dim">No curated guide yet — ask the sage below.</p>` + skillActions(item);

    const rows = (s.methods || []).map((m) => {
      const here = rangeHas(m.range, have);
      return `<tr class="${here ? "pd-here" : ""}">
        <td class="pd-range">${esc(m.range)}${here ? ' <span class="pd-you">you</span>' : ""}</td>
        <td class="pd-method"><b>${esc(m.name)}</b><span class="pd-mnote">${esc(m.note)}</span></td>
        <td class="pd-xph">${esc(m.xph)}</td>
      </tr>`;
    }).join("");

    return backBtn() +
      `<div class="pd-head"><span class="pd-icon">${iconHtml(item)}</span>
        <div><h3>${esc(item.name)}</h3><p class="pd-blurb">${esc(s.blurb || "")}</p></div>${levelBadge}</div>
      <div class="pd-section-t">Training methods <span class="pd-approx">rates approximate</span></div>
      <table class="pd-methods"><thead><tr><th>Level</th><th>Method</th><th>XP/hr</th></tr></thead><tbody>${rows}</tbody></table>
      ${s.fastest ? `<div class="pd-callout"><b>Fastest:</b> ${esc(s.fastest)}</div>` : ""}
      ${s.unlocks && s.unlocks.length ? `<div class="pd-section-t">Notable unlocks</div><ul class="pd-unlocks">${s.unlocks.map((u) => `<li>${esc(u)}</li>`).join("")}</ul>` : ""}
      ${skillActions(item, s)}`;
  }

  function skillActions(item, s) {
    return `<div class="pd-actions">
      <button class="pd-btn primary" data-ask type="button">Ask the sage for a training plan</button>
      ${s && s.wiki ? `<a class="pd-btn" href="${esc(wikiUrl(s.wiki))}" target="_blank" rel="noopener">Wiki ↗</a>` : ""}
    </div>`;
  }

  const backBtn = () => `<button class="pd-back" data-back type="button">← all</button>`;

  function wireDetail(key, item) {
    // Sprite fallback (CSP forbids inline onerror handlers).
    const iconImg = detailEl.querySelector(".pd-icon-img");
    if (iconImg) iconImg.addEventListener("error", () => {
      iconImg.replaceWith(document.createTextNode(iconImg.dataset.fallback || ""));
    });
    const back = detailEl.querySelector("[data-back]");
    if (back) back.addEventListener("click", () => {
      detailEl.hidden = true;
      grid.hidden = false;
      const cfg = CONFIGS[key];
      titleEl.textContent = cfg.title;
      const a = account();
      subEl.textContent = cfg.sub + (a && key !== "quests" ? ` (levels from ${a.player})` : "");
    });
    const ask = detailEl.querySelector("[data-ask]");
    if (ask) ask.addEventListener("click", () => {
      close();
      if (window.WOM) window.WOM.ask(item.prompt + accountLine(item, key));
    });
  }

  // -------------------------------------------------------------------------
  // Quests — the full list lives on the OSRS Wiki, so it's a searchable list
  // with details fetched live per quest (account-aware skill checks included).
  // -------------------------------------------------------------------------
  let questNames = null;
  let questPromise = null;

  function openQuests() {
    titleEl.textContent = "CHOOSE A QUEST";
    const a = account();
    subEl.textContent = "Every OSRS quest, live from the wiki" + (a ? ` — requirements checked against ${a.player}.` : ". Link your account to check requirements against your stats.");
    grid.hidden = true;
    detailEl.hidden = true;
    questsWrap.hidden = false;
    if (!questPromise) {
      qList.innerHTML = `<div class="pd-loading">fetching the quest list…</div>`;
      questPromise = fetch("/api/quests").then((r) => r.json()).then((b) => {
        if (!b.quests) throw new Error(b.error || "unavailable");
        questNames = b.quests;
      }).catch((e) => { questPromise = null; qList.innerHTML = `<div class="pd-dim">Couldn't load the quest list — ${esc(e.message)}. Try again shortly.</div>`; });
    }
    questPromise && questPromise.then(() => { if (questNames) renderQuestList(qSearch.value); });
    setTimeout(() => qSearch.focus(), 60);
  }

  function renderQuestList(filter) {
    if (!questNames) return;
    const f = (filter || "").trim().toLowerCase();
    const list = questNames.filter((n) => !f || n.toLowerCase().includes(f)).slice(0, 300);
    qList.innerHTML = list.length
      ? list.map((n) => `<button class="picker-qrow" type="button" data-quest="${esc(n)}">${esc(n)}</button>`).join("")
      : `<div class="pd-dim">No quest matches “${esc(f)}”.</div>`;
    qList.querySelectorAll("[data-quest]").forEach((b) =>
      b.addEventListener("click", () => showQuestDetail(b.dataset.quest)));
  }
  qSearch.addEventListener("input", () => renderQuestList(qSearch.value));

  function showQuestDetail(name) {
    titleEl.textContent = name.toUpperCase();
    subEl.textContent = "";
    questsWrap.hidden = true;
    detailEl.hidden = false;
    detailEl.innerHTML = `<div class="pd-loading">reading the wiki…</div>`;
    fetch(`/api/quest?name=${encodeURIComponent(name)}`).then((r) => r.json()).then((b) => {
      if (!b.quest) throw new Error(b.error || "not found");
      detailEl.innerHTML = wikiQuestDetail(b.quest);
      wireQuestDetail(b.quest);
    }).catch((e) => {
      detailEl.innerHTML = questBackBtn() + `<p class="pd-dim">Couldn't load “${esc(name)}” — ${esc(e.message)}.</p>`;
      const bb = detailEl.querySelector("[data-qback]");
      if (bb) bb.addEventListener("click", backToQuestList);
    });
  }

  function wikiQuestDetail(q) {
    const chips = [
      q.difficulty ? `<span class="pd-chip">${esc(q.difficulty)}</span>` : "",
      q.length ? `<span class="pd-chip">${esc(q.length)}</span>` : "",
      q.members ? `<span class="pd-chip">Members</span>` : `<span class="pd-chip">F2P</span>`,
    ].join("");

    const reqs = q.skills || {};
    const keys = Object.keys(reqs).sort((a, b) => reqs[b] - reqs[a]);
    const a = account();
    let unmet = 0;
    const reqRows = keys.map((sk) => {
      const need = reqs[sk], have = lvl(sk);
      const met = have != null && have >= need;
      if (a && have != null && !met) unmet++;
      const state = have == null ? "unknown" : met ? "met" : "short";
      const mark = have == null ? "" : met ? "✓" : `${have}/${need}`;
      return `<span class="pd-req ${state}">${esc(sk)} ${need}${mark ? ` <b>${mark}</b>` : ""}</span>`;
    }).join("");
    let verdict = "";
    if (a && keys.length) {
      verdict = unmet === 0
        ? `<div class="pd-verdict ok">✓ You meet the skill requirements, ${esc(a.player)}.</div>`
        : `<div class="pd-verdict no">You're short on ${unmet} skill${unmet === 1 ? "" : "s"} — see the red requirements.</div>`;
    }

    return questBackBtn() +
      `<div class="pd-head"><span class="pd-icon">📜</span>
        <div><h3>${esc(q.name)}</h3><div class="pd-chips">${chips}</div></div></div>
      ${keys.length ? `<div class="pd-section-t">Skill requirements</div><div class="pd-reqs">${reqRows}</div>${verdict}` : ""}
      ${q.requirements && q.requirements.length ? `<div class="pd-section-t">Requirements</div><ul class="pd-rewards">${q.requirements.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
      ${q.items && q.items.length ? `<div class="pd-section-t">Bring</div><ul class="pd-rewards">${q.items.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
      ${q.rewards && q.rewards.length ? `<div class="pd-section-t">Rewards</div><ul class="pd-rewards">${q.rewards.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
      <div class="pd-callout">Data pulled live from the OSRS Wiki. Open it for the full walkthrough, maps and exact steps.</div>
      <div class="pd-actions">
        <button class="pd-btn primary" data-qask type="button">Ask the sage for a walkthrough</button>
        <a class="pd-btn" href="${esc(wikiUrl(q.wiki || q.name))}" target="_blank" rel="noopener">Wiki ↗</a>
      </div>`;
  }

  const questBackBtn = () => `<button class="pd-back" data-qback type="button">← all quests</button>`;
  function backToQuestList() {
    detailEl.hidden = true;
    questsWrap.hidden = false;
    titleEl.textContent = "CHOOSE A QUEST";
    const a = account();
    subEl.textContent = "Every OSRS quest, live from the wiki" + (a ? ` — requirements checked against ${a.player}.` : ".");
  }
  function wireQuestDetail(q) {
    const back = detailEl.querySelector("[data-qback]");
    if (back) back.addEventListener("click", backToQuestList);
    const ask = detailEl.querySelector("[data-qask]");
    if (ask) ask.addEventListener("click", () => {
      close();
      const a = account();
      const ctx = a ? ` For context, I'm ${a.player}.` : "";
      if (window.WOM) window.WOM.ask(
        `Give me a walkthrough overview of the ${q.name} quest in Old School RuneScape: what to prepare, the key steps, and any tricky parts. Note the rewards and why it matters.${ctx}`);
    });
  }

  function open(key) {
    if (key === "quests") { openQuests(); panel.hidden = false; return; }
    const cfg = CONFIGS[key];
    if (!cfg) return;
    detailEl.hidden = true;
    questsWrap.hidden = true;
    grid.hidden = false;
    render(cfg, key);
    if (key === "skills") loadData(key); // warm the cache
    panel.hidden = false;
  }
  function close() { panel.hidden = true; }

  panel.addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-picker-dismiss")) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) close();
  });

  // app.js calls this when a constellation with a `picker` key is clicked.
  window.openPicker = open;
})();
