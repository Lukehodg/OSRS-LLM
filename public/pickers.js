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

    // ---- Bosses: iconic PvM targets, icon = a signature drop ----
    bosses: {
      title: "CHOOSE A BOSS",
      sub: "Pick a boss and the old man will give you the strategy, gear and requirements.",
      cols: 3,
      items: [
        ["Zulrah", "🐍", "Tanzanite_fang"], ["Vorkath", "🐲", "Dragonbone_necklace"], ["Barrows", "⚰️", "Dharok's_greataxe"],
        ["General Graardor", "🐗", "Bandos_chestplate"], ["K'ril Tsutsaroth", "😈", "Staff_of_the_dead"], ["Commander Zilyana", "🕊️", "Saradomin_sword"],
        ["Kree'arra", "🦅", "Armadyl_crossbow"], ["Kraken", "🦑", "Trident_of_the_seas"], ["Cerberus", "🐕", "Primordial_boots"],
        ["Alchemical Hydra", "🐉", "Brimstone_ring"], ["Corporeal Beast", "👾", "Spirit_shield"], ["The Nightmare", "🌙", "Nightmare_staff"],
        ["Nex", "❄️", "Zaryte_crossbow"], ["Chambers of Xeric", "🗿", "Twisted_bow"], ["Theatre of Blood", "🩸", "Scythe_of_vitur"],
        ["Tombs of Amascut", "🏛️", "Tumeken's_shadow"], ["The Inferno", "🌋", "Infernal_cape"], ["Fight Caves (Jad)", "🔥", "Fire_cape"],
      ].map(([name, icon, img]) => ({
        name, icon, img,
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

  function render(cfg) {
    titleEl.textContent = cfg.title;
    subEl.textContent = cfg.sub;
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
      tile.addEventListener("click", () => {
        close();
        if (window.WOM) window.WOM.ask(item.prompt);
      });
      grid.appendChild(tile);
    }
  }

  function open(key) {
    const cfg = CONFIGS[key];
    if (!cfg) return;
    render(cfg);
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
