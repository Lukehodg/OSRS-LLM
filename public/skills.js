/* Skills picker — opened by clicking the SKILLING constellation.
   Shows all 23 OSRS skills (in the in-game skills-tab order) with their
   real skill icons; picking one asks the sage for a training guide.
   Depends on window.WOM (app.js). */

(function () {
  // In-game skills-tab order (read top-to-bottom, 3 per row).
  // img = OSRS Wiki icon file (Special:FilePath), icon = emoji fallback.
  const SKILLS = [
    { name: "Attack", icon: "⚔️", img: "Attack_icon" },
    { name: "Hitpoints", icon: "❤️", img: "Hitpoints_icon" },
    { name: "Mining", icon: "⛏️", img: "Mining_icon" },
    { name: "Strength", icon: "💪", img: "Strength_icon" },
    { name: "Agility", icon: "🏃", img: "Agility_icon" },
    { name: "Smithing", icon: "🔨", img: "Smithing_icon" },
    { name: "Defence", icon: "🛡️", img: "Defence_icon" },
    { name: "Herblore", icon: "⚗️", img: "Herblore_icon" },
    { name: "Fishing", icon: "🎣", img: "Fishing_icon" },
    { name: "Ranged", icon: "🏹", img: "Ranged_icon" },
    { name: "Thieving", icon: "🗝️", img: "Thieving_icon" },
    { name: "Cooking", icon: "🍳", img: "Cooking_icon" },
    { name: "Prayer", icon: "🙏", img: "Prayer_icon" },
    { name: "Crafting", icon: "🧵", img: "Crafting_icon" },
    { name: "Firemaking", icon: "🔥", img: "Firemaking_icon" },
    { name: "Magic", icon: "🔮", img: "Magic_icon" },
    { name: "Fletching", icon: "🪶", img: "Fletching_icon" },
    { name: "Woodcutting", icon: "🪓", img: "Woodcutting_icon" },
    { name: "Runecraft", icon: "🌀", img: "Runecraft_icon" },
    { name: "Slayer", icon: "💀", img: "Slayer_icon" },
    { name: "Farming", icon: "🌿", img: "Farming_icon" },
    { name: "Construction", icon: "🏠", img: "Construction_icon" },
    { name: "Hunter", icon: "🦡", img: "Hunter_icon" },
  ];

  const panel = document.getElementById("skills");
  const grid = document.getElementById("skills-grid");
  const wikiImg = (name) =>
    `https://oldschool.runescape.wiki/w/Special:FilePath/${encodeURIComponent(name + ".png")}`;

  let built = false;
  function build() {
    if (built) return;
    for (const sk of SKILLS) {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "skill-tile";
      tile.title = `Training guide for ${sk.name}`;

      const ic = document.createElement("span");
      ic.className = "skill-icon";
      const img = document.createElement("img");
      img.className = "skill-img";
      img.alt = "";
      img.src = wikiImg(sk.img);
      img.addEventListener("error", () => { ic.textContent = sk.icon; });
      ic.appendChild(img);

      const label = document.createElement("span");
      label.className = "skill-label";
      label.textContent = sk.name;

      tile.append(ic, label);
      tile.addEventListener("click", () => pick(sk.name));
      grid.appendChild(tile);
    }
    built = true;
  }

  function pick(name) {
    close();
    const prompt =
      `What are the best ways to train ${name} in Old School RuneScape right now? ` +
      `Give me efficient methods with rough XP/hour at low, mid and high levels, ` +
      `the fastest route to 99, and any ironman-friendly or AFK options. Keep it practical.`;
    if (window.WOM) window.WOM.ask(prompt);
  }

  function open() {
    build();
    panel.hidden = false;
  }
  function close() { panel.hidden = true; }

  panel.addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-skills-dismiss")) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) close();
  });

  // Exposed so app.js can open it when the SKILLING constellation is clicked.
  window.openSkillsPicker = open;
})();
