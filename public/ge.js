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
  let chartType = "line";  // line | candles
  let screener = null;     // { mostTraded, bestFlips }
  let clockTimer = null;

  const toastsEl = document.getElementById("ge-toasts");
  const typesEl = document.getElementById("ge-types");

  // Persistent watchlist + alerts (this device).
  const LS = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  let watch = LS.get("wom.ge.watch", []);    // [{ id, name }]
  let alerts = LS.get("wom.ge.alerts", []);  // [{ id, name, field, op, value, armed }]
  let port = LS.get("wom.ge.port", { open: [], closed: [] }); // portfolio (this device)
  if (!port || typeof port !== "object") port = { open: [], closed: [] };
  port.open = Array.isArray(port.open) ? port.open : [];
  port.closed = Array.isArray(port.closed) ? port.closed : [];
  const savePort = () => LS.set("wom.ge.port", port);
  const isWatched = (id) => watch.some((w) => w.id === id);

  // GE sell tax, mirrored from the server: 2% floored, capped 5m, none <100gp.
  const sellTax = (p) => (!p || p < 100 ? 0 : Math.min(Math.floor(p * 0.02), 5_000_000));
  const netSell = (p) => (p == null ? null : p - sellTax(p));

  // ---- server-side alert mirror + push -------------------------------------
  // Alerts also live on the server, where a central poller keeps evaluating
  // them with every tab closed: missed fires greet you on return, and (when
  // permitted) arrive as a browser push.
  const deviceId = (() => {
    let d = LS.get("wom.ge.device", null);
    if (!d) { d = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)); LS.set("wom.ge.device", d); }
    return d;
  })();
  let pushOffered = false;

  async function syncAlerts() {
    try {
      const r = await fetch("/api/ge/alerts/sync", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device: deviceId, alerts }),
      });
      const body = await r.json();
      if (!r.ok) return;
      // Adopt the merged armed-state (a fire on either side sticks).
      if (Array.isArray(body.alerts) && body.alerts.length === alerts.length) {
        alerts = body.alerts;
        LS.set("wom.ge.alerts", alerts);
      }
      showMissedFires(body.fired || []);
      if (body.push && !pushOffered) { pushOffered = true; trySubscribePush(); }
    } catch { /* offline / server old — local poller still covers the tab */ }
  }

  function showMissedFires(fired) {
    const ackTs = LS.get("wom.ge.alertAck", 0);
    const fresh = fired.filter((f) => {
      if (f.at <= ackTs) return false;
      const seenAt = localFires.get(`${f.id}:${f.field}:${f.op}:${f.value}`);
      return !(seenAt && Math.abs(f.at - seenAt) < 10 * 60_000);
    });
    for (const f of fresh.slice(-6)) toast(`🔔 while you were away — ${f.text}`);
    // Ack everything we've seen (deduped fires included) so it isn't replayed.
    const seen = fired.filter((f) => f.at > ackTs);
    if (!seen.length) return;
    const upTo = Math.max(...seen.map((f) => f.at));
    LS.set("wom.ge.alertAck", upTo);
    fetch("/api/ge/alerts/ack", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device: deviceId, upTo }),
    }).catch(() => {});
  }

  async function trySubscribePush() {
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
      if (!window.Notification || Notification.permission !== "granted") return;
      const { key } = await fetch("/api/push/key").then((r) => r.json());
      if (!key) return;
      const reg = await navigator.serviceWorker.register("sw.js");
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
      await fetch("/api/ge/alerts/subscribe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device: deviceId, subscription: sub.toJSON() }),
      });
    } catch { /* push is a bonus — never break alerts over it */ }
  }

  function urlBase64ToUint8Array(base64) {
    const pad = "=".repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  // ---- formatting ----
  // Coerce to a finite number so upstream data can never inject strings
  // through the formatters into HTML.
  function fmt(v) {
    const n = Number(v);
    if (v == null || !Number.isFinite(n)) return "—";
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + "b";
    if (a >= 1e6) return (n / 1e6).toFixed(2) + "m";
    if (a >= 1e4) return (n / 1e3).toFixed(1) + "k";
    return n.toLocaleString("en-GB");
  }
  const gp = (v) => {
    const n = Number(v);
    return v == null || !Number.isFinite(n) ? "—" : n.toLocaleString("en-GB");
  };
  const pct = (v) => {
    const n = Number(v);
    return v == null || !Number.isFinite(n) ? "—" : (n * 100).toFixed(1) + "%";
  };

  // ---- open / close ----
  function open() {
    panel.hidden = false;
    if (!clockTimer) { tickClock(); clockTimer = setInterval(tickClock, 1000); }
    loadScreener();
    startPoller();
    syncAlerts(); // mirror to the server + collect fires missed while away
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
      `<div class="ge-quote-head">` +
        `<span class="ge-quote-name">${escapeHtml(q.name)}</span>` +
        `<span class="ge-quote-tag">${q.members ? "Members" : "F2P"}${q.limit ? " · buy limit " + gp(q.limit) : ""}</span>` +
        `<span class="ge-quote-acts">` +
          `<button id="ge-pin" class="ge-icon-btn" type="button" title="Add to watchlist">${isWatched(q.id) ? "★" : "☆"}</button>` +
          `<button id="ge-alert" class="ge-icon-btn" type="button" title="Set a price alert">🔔</button>` +
          `<button id="ge-pos" class="ge-icon-btn" type="button" title="Log a buy in your portfolio">⊕</button>` +
        `</span>` +
      `</div>` +
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
      `<div id="ge-alert-form" class="ge-alert-form" hidden></div>` +
      `<div id="ge-pos-form" class="ge-alert-form" hidden></div>` +
      (q.examine ? `<div class="ge-examine">“${escapeHtml(q.examine)}”</div>` : "");

    document.getElementById("ge-pin").addEventListener("click", () => toggleWatch(q));
    document.getElementById("ge-alert").addEventListener("click", () => toggleAlertForm(q));
    document.getElementById("ge-pos").addEventListener("click", () => togglePosForm(q));
  }

  // ---- portfolio: log a buy ----
  function togglePosForm(q) {
    const form = document.getElementById("ge-pos-form");
    if (!form) return;
    if (!form.hidden) { form.hidden = true; return; }
    form.innerHTML =
      `<input id="ge-pos-qty" type="number" min="1" step="1" value="1" title="Quantity" />` +
      `<span class="ge-pos-x">×</span>` +
      `<input id="ge-pos-price" type="number" min="1" placeholder="buy price (gp)" value="${q.high ?? ""}" />` +
      `<button id="ge-pos-add" type="button" class="ge-mini-btn">Log buy</button>`;
    form.hidden = false;
    document.getElementById("ge-pos-add").addEventListener("click", () => {
      const qty = Math.floor(Number(document.getElementById("ge-pos-qty").value));
      const buy = Math.floor(Number(document.getElementById("ge-pos-price").value));
      if (!Number.isFinite(qty) || qty < 1 || !Number.isFinite(buy) || buy < 1) return;
      port.open = [{ id: q.id, name: q.name, qty, buy, at: Date.now() }, ...port.open].slice(0, 30);
      savePort();
      form.hidden = true;
      toast(`Logged — ${fmt(qty)}× ${q.name} @ ${gp(buy)} gp`);
      if (screen === "port") renderScreen();
    });
  }

  function toggleWatch(q) {
    if (isWatched(q.id)) watch = watch.filter((w) => w.id !== q.id);
    else watch = [{ id: q.id, name: q.name }, ...watch].slice(0, 50);
    LS.set("wom.ge.watch", watch);
    const pin = document.getElementById("ge-pin");
    if (pin) pin.textContent = isWatched(q.id) ? "★" : "☆";
    if (screen === "watch") renderScreen();
  }

  // ---- alert form ----
  function toggleAlertForm(q) {
    const form = document.getElementById("ge-alert-form");
    if (!form) return;
    if (!form.hidden) { form.hidden = true; return; }
    form.innerHTML =
      `<select id="ge-al-field">` +
        `<option value="buy">Instant-buy price</option>` +
        `<option value="sell">Instant-sell price</option>` +
        `<option value="margin">Margin (after tax)</option>` +
      `</select>` +
      `<select id="ge-al-op"><option value="lte">falls to ≤</option><option value="gte">rises to ≥</option></select>` +
      `<input id="ge-al-val" type="number" placeholder="gp" />` +
      `<button id="ge-al-set" type="button" class="ge-mini-btn">Set alert</button>`;
    form.hidden = false;
    document.getElementById("ge-al-set").addEventListener("click", () => {
      const field = document.getElementById("ge-al-field").value;
      const op = document.getElementById("ge-al-op").value;
      const value = Number(document.getElementById("ge-al-val").value);
      if (!Number.isFinite(value)) return;
      alerts = [{ id: q.id, name: q.name, field, op, value, armed: true }, ...alerts].slice(0, 50);
      LS.set("wom.ge.alerts", alerts);
      form.hidden = true;
      if (window.Notification && Notification.permission === "default") {
        Notification.requestPermission().then(() => trySubscribePush()).catch(() => {});
      }
      toast(`Alert set — ${q.name} ${op === "lte" ? "≤" : "≥"} ${gp(value)}`);
      startPoller();
      syncAlerts();
    });
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

  typesEl.addEventListener("click", (e) => {
    const b = e.target.closest(".ge-type");
    if (!b) return;
    typesEl.querySelectorAll(".ge-type").forEach((t) => t.classList.toggle("active", t === b));
    chartType = b.dataset.type;
    drawChart();
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
    const li = series.length - 1;

    if (chartType === "candles") {
      // Each interval as a range bar (avgLow→avgHigh), coloured by direction
      // vs the previous interval's avgHigh. (The feed gives averages, not OHLC.)
      const cw = Math.max(2, plotW / series.length - 2);
      let prev = null;
      series.forEach((p, i) => {
        const hi = p.avgHighPrice, lo = p.avgLowPrice;
        if (hi == null || lo == null) return;
        const rising = prev == null ? true : hi >= prev;
        prev = hi;
        const color = rising ? "#6bbf6b" : "#e0655a";
        const top = y(hi), bot = y(lo);
        // wick
        ctx.strokeStyle = color; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x(i), top); ctx.lineTo(x(i), bot); ctx.stroke();
        // body
        ctx.fillStyle = color;
        ctx.fillRect(x(i) - cw / 2, top, cw, Math.max(1, bot - top));
      });
    } else {
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
      if (lastV != null) {
        ctx.fillStyle = up ? "#6bbf6b" : "#e0655a";
        ctx.beginPath(); ctx.arc(x(li), y(lastV), 3, 0, Math.PI * 2); ctx.fill();
      }
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
    if (screen === "watch") return renderWatch();
    if (screen === "port") return renderPort();
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

  function renderWatch() {
    screenEl.innerHTML = "";
    if (!watch.length && !alerts.length) {
      screenEl.innerHTML = `<div class="ge-screen-loading">Star ☆ an item to watch it, or set a 🔔 price alert.</div>`;
      return;
    }
    for (const w of watch) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "ge-row";
      el.innerHTML =
        `<span class="ge-row-name">${escapeHtml(w.name)}</span>` +
        `<span class="ge-row-metric" data-price>…</span>` +
        `<span class="ge-row-x" title="Unwatch">✕</span>`;
      el.addEventListener("click", (e) => {
        if (e.target.classList.contains("ge-row-x")) {
          watch = watch.filter((x) => x.id !== w.id); LS.set("wom.ge.watch", watch); renderWatch();
        } else { searchEl.value = w.name; loadItem(w.id); }
      });
      screenEl.appendChild(el);
      // fill live price lazily
      fetch(`/api/ge/item?id=${w.id}`).then((r) => r.json()).then((q) => {
        const m = el.querySelector("[data-price]");
        if (m && q && q.high != null) {
          m.textContent = fmt(q.high);
          m.classList.toggle("up", q.marginAfterTax > 0);
        }
      }).catch(() => {});
    }
    if (alerts.length) {
      const hd = document.createElement("div");
      hd.className = "ge-watch-divider";
      hd.textContent = "ALERTS";
      screenEl.appendChild(hd);
      alerts.forEach((a, i) => {
        const el = document.createElement("div");
        el.className = "ge-row ge-alert-row";
        el.innerHTML =
          `<span class="ge-row-name">${escapeHtml(a.name)}</span>` +
          `<span class="ge-row-metric">${a.field === "buy" ? "buy" : a.field === "sell" ? "sell" : "margin"} ${a.op === "lte" ? "≤" : "≥"} ${fmt(a.value)}</span>` +
          `<span class="ge-row-x" title="Remove alert">✕</span>`;
        el.querySelector(".ge-row-x").addEventListener("click", () => {
          alerts.splice(i, 1); LS.set("wom.ge.alerts", alerts); syncAlerts(); renderWatch();
        });
        screenEl.appendChild(el);
      });
    }
  }

  // ---- portfolio tab ----
  async function renderPort() {
    screenEl.innerHTML = "";
    if (!port.open.length && !port.closed.length) {
      screenEl.innerHTML = `<div class="ge-screen-loading">Log a buy with ⊕ on any quote — track your flips and realised profit here.</div>`;
      return;
    }

    // Live prices for open positions (batch, cached server-side).
    let quotes = {};
    if (port.open.length) {
      screenEl.innerHTML = `<div class="ge-screen-loading">pricing your positions…</div>`;
      try {
        const ids = [...new Set(port.open.map((p) => p.id))].join(",");
        const body = await fetch(`/api/ge/quotes?ids=${ids}`).then((r) => r.json());
        quotes = body.quotes || {};
      } catch { /* rows will show — for price */ }
      screenEl.innerHTML = "";
    }

    const realised = port.closed.reduce((n, c) => n + c.profit, 0);
    let invested = 0, unrealised = 0, priced = 0;
    for (const p of port.open) {
      invested += p.qty * p.buy;
      const low = Number(quotes[p.id]?.low);
      if (Number.isFinite(low)) { unrealised += p.qty * (netSell(low) - p.buy); priced++; }
    }
    const plCls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
    const sum = document.createElement("div");
    sum.className = "ge-port-summary";
    sum.innerHTML =
      `<div class="ge-cell"><span class="ge-cell-l">Invested (open)</span><span class="ge-cell-v">${fmt(invested)} gp</span></div>` +
      `<div class="ge-cell"><span class="ge-cell-l">Unrealised (after tax)</span><span class="ge-cell-v ${plCls(unrealised)}">${priced ? (unrealised >= 0 ? "+" : "") + fmt(unrealised) + " gp" : "—"}</span></div>` +
      `<div class="ge-cell"><span class="ge-cell-l">Realised profit</span><span class="ge-cell-v ${plCls(realised)}">${(realised >= 0 ? "+" : "") + fmt(realised)} gp</span></div>`;
    screenEl.appendChild(sum);

    if (port.open.length) {
      const hd = document.createElement("div");
      hd.className = "ge-watch-divider";
      hd.textContent = "OPEN POSITIONS";
      screenEl.appendChild(hd);
    }
    port.open.forEach((p, idx) => {
      const low = Number(quotes[p.id]?.low);
      const pl = Number.isFinite(low) ? p.qty * (netSell(low) - p.buy) : null;
      const el = document.createElement("div");
      el.className = "ge-row ge-port-row";
      el.innerHTML =
        `<span class="ge-row-name" data-load>${escapeHtml(p.name)}</span>` +
        `<span class="ge-port-lot">${fmt(p.qty)}× @ ${fmt(p.buy)}</span>` +
        `<span class="ge-row-metric ${pl == null ? "" : plCls(pl)}">${pl == null ? "—" : (pl >= 0 ? "+" : "") + fmt(pl)}</span>` +
        `<button class="ge-mini-btn" data-sell type="button">Sell</button>` +
        `<span class="ge-row-x" title="Remove without selling">✕</span>`;
      el.querySelector("[data-load]").addEventListener("click", () => { searchEl.value = p.name; loadItem(p.id); });
      el.querySelector(".ge-row-x").addEventListener("click", () => {
        port.open.splice(idx, 1); savePort(); renderPort();
      });
      el.querySelector("[data-sell]").addEventListener("click", () => {
        const f = document.createElement("div");
        f.className = "ge-alert-form ge-sell-form";
        f.innerHTML =
          `<input type="number" min="1" value="${Number.isFinite(low) ? low : p.buy}" title="Sell price (gp each)" />` +
          `<button class="ge-mini-btn" data-ok type="button">Confirm sell</button>` +
          `<button class="ge-mini-btn" data-no type="button">✕</button>`;
        el.after(f);
        const input = f.querySelector("input");
        f.querySelector("[data-no]").addEventListener("click", () => f.remove());
        f.querySelector("[data-ok]").addEventListener("click", () => {
          const sell = Math.floor(Number(input.value));
          if (!Number.isFinite(sell) || sell < 1) return;
          const profit = p.qty * (netSell(sell) - p.buy);
          port.closed = [{ ...p, sell, closedAt: Date.now(), profit }, ...port.closed].slice(0, 100);
          port.open.splice(idx, 1);
          savePort();
          toast(`Sold ${fmt(p.qty)}× ${p.name} @ ${gp(sell)} — ${profit >= 0 ? "+" : ""}${fmt(profit)} gp after tax`);
          renderPort();
        });
      });
      screenEl.appendChild(el);
    });

    if (port.closed.length) {
      const hd = document.createElement("div");
      hd.className = "ge-watch-divider";
      hd.innerHTML = `REALISED <span class="ge-port-clear" title="Clear realised history">clear</span>`;
      hd.querySelector(".ge-port-clear").addEventListener("click", () => {
        port.closed = []; savePort(); renderPort();
      });
      screenEl.appendChild(hd);
      for (const c of port.closed.slice(0, 30)) {
        const el = document.createElement("div");
        el.className = "ge-row ge-port-row closed";
        el.innerHTML =
          `<span class="ge-row-name">${escapeHtml(c.name)}</span>` +
          `<span class="ge-port-lot">${fmt(c.qty)}× ${fmt(c.buy)}→${fmt(c.sell)}</span>` +
          `<span class="ge-row-metric ${plCls(c.profit)}">${(c.profit >= 0 ? "+" : "") + fmt(c.profit)}</span>`;
        screenEl.appendChild(el);
      }
    }
  }

  // ---- alerts poller ----
  let pollTimer = null;
  function startPoller() {
    if (pollTimer || !alerts.length) return;
    pollTimer = setInterval(checkAlerts, 60_000);
    checkAlerts();
  }
  function alertMet(a, q) {
    const actual = a.field === "buy" ? q.high : a.field === "sell" ? q.low : q.marginAfterTax;
    if (actual == null) return false;
    return a.op === "lte" ? actual <= a.value : actual >= a.value;
  }
  async function checkAlerts() {
    if (!alerts.length) { clearInterval(pollTimer); pollTimer = null; return; }
    const ids = [...new Set(alerts.map((a) => a.id))];
    const quotes = {};
    await Promise.all(ids.map((id) =>
      fetch(`/api/ge/item?id=${id}`).then((r) => r.json()).then((q) => { quotes[id] = q; }).catch(() => {})));
    let changed = false;
    for (const a of alerts) {
      const q = quotes[a.id];
      if (!q) continue;
      const met = alertMet(a, q);
      if (met && a.armed) {
        a.armed = false; changed = true;
        fireAlert(a, q);
      } else if (!met && !a.armed) {
        a.armed = true; changed = true; // re-arm once condition clears
      }
    }
    if (changed) { LS.set("wom.ge.alerts", alerts); syncAlerts(); }
  }
  // Signatures of alerts fired locally, so the server's recap of the same
  // fire (its poller runs on its own minute) isn't re-toasted as "missed".
  const localFires = new Map();
  function fireAlert(a, q) {
    const actual = a.field === "buy" ? q.high : a.field === "sell" ? q.low : q.marginAfterTax;
    const msg = `${a.name}: ${a.field} is ${gp(actual)} gp (${a.op === "lte" ? "≤" : "≥"} ${gp(a.value)})`;
    localFires.set(`${a.id}:${a.field}:${a.op}:${a.value}`, Date.now());
    toast("🔔 " + msg);
    try {
      if (window.Notification && Notification.permission === "granted") {
        new Notification("RuneScribe — GE alert", { body: msg });
      }
    } catch {}
  }

  function toast(text) {
    const t = document.createElement("div");
    t.className = "ge-toast";
    t.textContent = text;
    toastsEl.appendChild(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 300); }, 7000);
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

  // Keep persisted alerts live across reloads while the page is open.
  if (alerts.length) startPoller();

  window.openGeTerminal = open;
})();
