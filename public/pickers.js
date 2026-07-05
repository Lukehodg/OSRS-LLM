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

    // ---- Quests: high-impact quests/series, icon = a key reward ----
    quests: {
      title: "CHOOSE A QUEST",
      sub: "Pick a quest and the old man will give requirements, a walkthrough overview and rewards.",
      cols: 2,
      items: [
        ["Recipe for Disaster", "🧤", "Barrows_gloves"],
        ["Monkey Madness I", "🐵", "Dragon_scimitar"],
        ["Monkey Madness II", "🐒", "Ballista"],
        ["Dragon Slayer II", "🐉", "Ava's_assembler"],
        ["Desert Treasure I", "❄️", "Ancient_staff"],
        ["Desert Treasure II", "🩸", "Virtus_mask"],
        ["Song of the Elves", "🧝", "Crystal_halberd"],
        ["The Fremennik Isles", "⛑️", "Helm_of_neitiznot"],
        ["Sins of the Father", "🧛", "Blisterwood_flail"],
        ["Lunar Diplomacy", "🌙", "Lunar_staff"],
        ["Legends' Quest", "🗺️", "Cape_of_legends"],
        ["A Kingdom Divided", "👑", "Quest_point_cape"],
      ].map(([name, icon, img]) => ({
        name, icon, img,
        prompt:
          `Give me an overview of the ${name} quest in Old School RuneScape: the skill and ` +
          `quest requirements, what to prepare, a high-level walkthrough of the steps, and ` +
          `the rewards and unlocks. Note why it matters for progression.`,
      })),
    },
  };

  const panel = document.getElementById("picker");
  const titleEl = document.getElementById("picker-title");
  const subEl = document.getElementById("picker-sub");
  const grid = document.getElementById("picker-grid");

  const wikiImg = (name) =>
    `https://oldschool.runescape.wiki/w/Special:FilePath/${encodeURIComponent(name + ".png")}`;

  // ---- account context (set by Ironman Path, shared via window.WOM) ----
  const account = () => (window.WOM && window.WOM.account) || null;
  const lvl = (skill) => {
    const a = account();
    return a && a.skills[skill] ? a.skills[skill].level : null;
  };

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
        close();
        if (window.WOM) window.WOM.ask(item.prompt + accountLine(item, key));
      });
      grid.appendChild(tile);
    }
  }

  function open(key) {
    const cfg = CONFIGS[key];
    if (!cfg) return;
    render(cfg, key);
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
