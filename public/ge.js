/* GE Terminal — a Bloomberg-style Grand Exchange market view.
   Ticker search, live quote, price/volume chart, screeners, and AI
   market analysis / price forecast. Depends on window.WOM (app.js). */

(function () {
  const panel = document.getElementById("ge");
  const searchEl = document.getElementById("ge-search");
  const resultsEl = document.getElementById("ge-results");
  const clockEl = document.getElementById("ge-clock");
  const quoteEl = document.getElementById("ge-quote");
  const canvas = document.getElementById("ge-chart");
  const chartMsg = document.getElementById("ge-chart-msg");
  const chartTitle = document.getElementById("ge-chart-title");
  const tabsEl = document.getElementById("ge-tabs");
  const analyseBtn = document.getElementById("ge-analyse");
  const forecastBtn = document.getElementById("ge-forecast");
  const railTabs = document.querySelectorAll(".ge-rail-tab");
  const screenEl = document.getElementById("ge-screen");
  const ctx = canvas.getContext("2d");

  let current = null;      // current item quote
  let series = [];         // current timeseries points
  let step = "1h";
  let screener = null;     // { mostTraded, bestFlips }
  let clockTimer = null;

  // ---- formatting ----
  function fmt(n) {
    if (n == null) return "—";
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + "b";
    if (a >= 1e6) return (n / 1e6).toFixed(2) + "m";
    if (a >= 1e4) return (n / 1e3).toFixed(1) + "k";
    return n.toLocaleString("en-GB");
  }
  const gp = (n) => (n == null ? "—" : n.toLocaleString("en-GB"));
  const pct = (n) => (n == null ? "—" : (n * 100).toFixed(1) + "%");

  // ---- open / close ----
  function open() {
    panel.hidden = false;
    if (!clockTimer) { tickClock(); clockTimer = setInterval(tickClock, 1000); }
    loadScreener();
    setTimeout(() => searchEl.focus(), 60);
    requestAnimationFrame(drawChart);
  }
  function close() { panel.hidden = true; }
  function tickClock() { clockEl.textContent = new Date().toLocaleTimeString("en-GB", { hour12: false }) + " GMT"; }

  panel.addEventListener("click", (e) => { if (e.target.hasAttribute("data-ge-dismiss")) close(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) { if (!resultsEl.hidden) hideResults(); else close(); }
  });
  window.addEventListener("resize", () => { if (!panel.hidden) drawChart(); });

  // ---- search ----
  let searchTimer = null;
  searchEl.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = searchEl.value.trim();
    if (q.length < 2) return hideResults();
    searchTimer = setTimeout(() => runSearch(q), 180);
  });
  searchEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = resultsEl.querySelector(".ge-result");
      if (first) first.click();
    }
  });
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !e.target.closest(".ge-search-wrap")) hideResults();
  });

  async function runSearch(q) {
    try {
      const r = await fetch(`/api/ge/search?q=${encodeURIComponent(q)}`);
      const body = await r.json();
      const items = body.results || [];
      if (!items.length) return hideResults();
      resultsEl.innerHTML = "";
      for (const it of items) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "ge-result";
        row.innerHTML = `<span>${escapeHtml(it.name)}</span>` +
          `<span class="ge-result-tag">${it.members ? "P2P" : "F2P"}${it.limit ? " · lim " + fmt(it.limit) : ""}</span>`;
        row.addEventListener("click", () => { hideResults(); searchEl.value = it.name; loadItem(it.id); });
        resultsEl.appendChild(row);
      }
      resultsEl.hidden = false;
    } catch { hideResults(); }
  }
  function hideResults() { resultsEl.hidden = true; resultsEl.innerHTML = ""; }

  // ---- load an item ----
  async function loadItem(id) {
    quoteEl.classList.remove("ge-empty-panel");
    quoteEl.innerHTML = `<div class="ge-loading">loading quote…</div>`;
    chartMsg.textContent = "loading chart…";
    try {
      const r = await fetch(`/api/ge/item?id=${id}`);
      const q = await r.json();
      if (!r.ok) throw new Error(q.error || "failed");
      current = q;
      renderQuote(q);
      analyseBtn.disabled = false;
      forecastBtn.disabled = false;
    } catch (err) {
      quoteEl.innerHTML = `<div class="ge-err">${escapeHtml(err.message || "Couldn't load that item.")}</div>`;
      return;
    }
    loadSeries();
  }

  function renderQuote(q) {
    chartTitle.textContent = `${q.name.toUpperCase()} — PRICE HISTORY`;
    const spreadCls = q.marginAfterTax > 0 ? "up" : q.marginAfterTax < 0 ? "down" : "";
    const cell = (label, val, cls = "") => `<div class="ge-cell"><span class="ge-cell-l">${label}</span><span class="ge-cell-v ${cls}">${val}</span></div>`;
    quoteEl.innerHTML =
      `<div class="ge-quote-head"><span class="ge-quote-name">${escapeHtml(q.name)}</span>` +
      `<span class="ge-quote-tag">${q.members ? "Members" : "F2P"}${q.limit ? " · buy limit " + gp(q.limit) : ""}</span></div>` +
      `<div class="ge-grid">` +
      cell("Instant buy", gp(q.high) + " gp", "buy") +
      cell("Instant sell", gp(q.low) + " gp", "sell") +
      cell("Margin (after 2% tax)", gp(q.marginAfterTax) + " gp", spreadCls) +
      cell("ROI", pct(q.roi), spreadCls) +
      cell("GE tax on sell", gp(q.tax) + " gp") +
      cell("Volume (1h)", fmt(q.volume1h)) +
      cell("Profit / limit", q.potentialProfit != null ? fmt(q.potentialProfit) + " gp" : "—", spreadCls) +
      cell("High alch", gp(q.highalch) + " gp") +
      `</div>` +
      (q.examine ? `<div class="ge-examine">“${escapeHtml(q.examine)}”</div>` : "");
  }

  // ---- timeseries + chart ----
  async function loadSeries() {
    if (!current) return;
    chartMsg.textContent = "loading chart…";
    try {
      const r = await fetch(`/api/ge/timeseries?id=${current.id}&timestep=${step}`);
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "failed");
      series = (body.data || []).filter((p) => p.avgHighPrice != null || p.avgLowPrice != null);
      chartMsg.textContent = series.length ? "" : "no chart data for this timeframe.";
    } catch (err) {
      series = [];
      chartMsg.textContent = err.message || "chart unavailable.";
    }
    drawChart();
  }

  tabsEl.addEventListener("click", (e) => {
    const b = e.target.closest(".ge-tab");
    if (!b) return;
    tabsEl.querySelectorAll(".ge-tab").forEach((t) => t.classList.toggle("active", t === b));
    step = b.dataset.step;
    loadSeries();
  });

  function drawChart() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth || 600, h = canvas.clientHeight || 300;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!series.length) return;

    const padL = 8, padR = 58, padT = 12, padB = 34;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const volH = plotH * 0.22;
    const priceH = plotH - volH - 8;

    const highs = series.map((p) => p.avgHighPrice).filter((v) => v != null);
    const lows = series.map((p) => p.avgLowPrice).filter((v) => v != null);
    const all = highs.concat(lows);
    let min = Math.min(...all), max = Math.max(...all);
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.08; min -= pad; max += pad;
    const maxVol = Math.max(1, ...series.map((p) => (p.highPriceVolume || 0) + (p.lowPriceVolume || 0)));

    const x = (i) => padL + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
    const y = (v) => padT + priceH - ((v - min) / (max - min)) * priceH;
    const vy = (v) => padT + priceH + 8 + volH - (v / maxVol) * volH;

    // grid + right-axis price labels
    ctx.font = "10px 'IBM Plex Mono', monospace";
    ctx.textBaseline = "middle";
    for (let g = 0; g <= 4; g++) {
      const val = min + (g / 4) * (max - min);
      const gy = y(val);
      ctx.strokeStyle = "rgba(217,192,122,0.08)";
      ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(padL + plotW, gy); ctx.stroke();
      ctx.fillStyle = "rgba(169,159,131,0.8)";
      ctx.textAlign = "left";
      ctx.fillText(fmt(Math.round(val)), padL + plotW + 6, gy);
    }

    // volume bars
    ctx.fillStyle = "rgba(95,160,200,0.28)";
    const bw = Math.max(1, plotW / series.length - 1);
    series.forEach((p, i) => {
      const vol = (p.highPriceVolume || 0) + (p.lowPriceVolume || 0);
      const by = vy(vol), bh = padT + priceH + 8 + volH - by;
      ctx.fillRect(x(i) - bw / 2, by, bw, Math.max(0, bh));
    });

    // trend colour: last vs first high
    const firstV = highs[0], lastV = highs[highs.length - 1];
    const up = lastV >= firstV;
    const line = (key, color, width) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
      let started = false;
      series.forEach((p, i) => {
        if (p[key] == null) return;
        const px = x(i), py = y(p[key]);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      });
      ctx.stroke();
    };
    line("avgLowPrice", "rgba(169,159,131,0.5)", 1.2);          // instant-sell (dim)
    line("avgHighPrice", up ? "#6bbf6b" : "#e0655a", 1.8);       // instant-buy (trend colour)

    // last price marker
    const li = series.length - 1;
    if (lastV != null) {
      ctx.fillStyle = up ? "#6bbf6b" : "#e0655a";
      ctx.beginPath(); ctx.arc(x(li), y(lastV), 3, 0, Math.PI * 2); ctx.fill();
    }

    // time axis labels (first / mid / last)
    ctx.fillStyle = "rgba(169,159,131,0.8)";
    ctx.textAlign = "center";
    const tlabel = (ts) => {
      const d = new Date(ts * 1000);
      return step === "5m" || step === "1h"
        ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
        : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    };
    [0, Math.floor(li / 2), li].forEach((i) => {
      if (series[i]) ctx.fillText(tlabel(series[i].timestamp), x(i), h - 10);
    });
  }

  // ---- screeners ----
  let screen = "mostTraded";
  railTabs.forEach((t) => t.addEventListener("click", () => {
    railTabs.forEach((x) => x.classList.toggle("active", x === t));
    screen = t.dataset.screen;
    renderScreen();
  }));

  async function loadScreener() {
    if (screener) return renderScreen();
    screenEl.innerHTML = `<div class="ge-screen-loading">scanning ~4,000 items…</div>`;
    try {
      const r = await fetch("/api/ge/screener");
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "failed");
      screener = body;
      renderScreen();
    } catch (err) {
      screenEl.innerHTML = `<div class="ge-err">${escapeHtml(err.message || "Screener unavailable.")}</div>`;
    }
  }

  function renderScreen() {
    if (!screener) return;
    const rows = screener[screen] || [];
    screenEl.innerHTML = "";
    rows.forEach((row, i) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "ge-row";
      const metric = screen === "mostTraded"
        ? `${fmt(row.volume)} vol`
        : `+${fmt(row.potentialProfit)}/lim`;
      const metricCls = screen === "bestFlips" ? "up" : "";
      el.innerHTML =
        `<span class="ge-row-rank">${i + 1}</span>` +
        `<span class="ge-row-name">${escapeHtml(row.name)}</span>` +
        `<span class="ge-row-metric ${metricCls}">${metric}</span>`;
      el.addEventListener("click", () => { searchEl.value = row.name; loadItem(row.id); });
      screenEl.appendChild(el);
    });
  }

  // ---- AI analysis / forecast ----
  function seriesStats() {
    if (!series.length) return "No historical series available.";
    const highs = series.map((p) => p.avgHighPrice).filter((v) => v != null);
    if (!highs.length) return "No historical series available.";
    const first = highs[0], last = highs[highs.length - 1];
    const min = Math.min(...highs), max = Math.max(...highs);
    const change = first ? (last - first) / first : 0;
    const avgVol = Math.round(series.reduce((n, p) => n + (p.highPriceVolume || 0) + (p.lowPriceVolume || 0), 0) / series.length);
    return `Over the last ${series.length} points at ${step} intervals: start ${gp(first)} → now ${gp(last)} (${pct(change)}), range ${gp(min)}–${gp(max)}, average volume/interval ${fmt(avgVol)}.`;
  }

  function buildSummary() {
    const q = current;
    return [
      `Grand Exchange item: ${q.name}${q.members ? " (members)" : " (F2P)"}.`,
      `Instant-buy ${gp(q.high)} gp, instant-sell ${gp(q.low)} gp. Buy limit ${gp(q.limit)}. High alch ${gp(q.highalch)} gp.`,
      `Margin after 2% GE tax: ${gp(q.marginAfterTax)} gp (ROI ${pct(q.roi)}); tax on a sell ${gp(q.tax)} gp; profit per buy-limit cycle ${q.potentialProfit != null ? gp(q.potentialProfit) + " gp" : "n/a"}.`,
      `Recent 1h traded volume: ${fmt(q.volume1h)}.`,
      `Price trend (${step}): ${seriesStats()}`,
    ].join("\n");
  }

  function runAI(mode) {
    if (!current || (window.WOM && window.WOM.busy)) return;
    const note = mode === "forecast"
      ? `📈 AI price forecast — ${current.name}`
      : `💹 Market analysis — ${current.name}`;
    close();
    window.WOM.stream("/api/ge/analyse", { summary: buildSummary(), mode }, note,
      "The old man couldn't read the market just now.");
  }
  analyseBtn.addEventListener("click", () => runAI("analyse"));
  forecastBtn.addEventListener("click", () => runAI("forecast"));
  setInterval(() => {
    const busy = window.WOM && window.WOM.busy;
    analyseBtn.disabled = !current || busy;
    forecastBtn.disabled = !current || busy;
  }, 500);

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  window.openGeTerminal = open;
})();
