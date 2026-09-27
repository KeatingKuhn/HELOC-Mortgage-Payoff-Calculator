/* Page logic: read the form, run the engine, render the answer. */
(function () {
  "use strict";

  const E = window.PayoffEngine;

  // Example numbers shown on first visit. Spending includes tax & insurance.
  const DEFAULTS = {
    balance: 300000,
    rate: 6.75,
    yearsLeft: 28,
    homeValue: 450000,
    income: 8000,
    spending: 4500,
    payment: "",
    payStrategy: "semimonthly",
    spendTiming: "spread",
    helocRate: 8,
    maxCltv: 80,
    helocLimit: "",
    chunk: "",
    helocAnnualFee: 0,
    aioRate: 7.75,
    aioMaxLtv: 80,
    aioCost: 0,
  };
  const CORE = ["balance", "rate", "yearsLeft", "homeValue", "income", "spending"];
  const MONEY = ["balance", "homeValue", "income", "spending", "payment", "helocLimit", "chunk", "helocAnnualFee", "aioCost"];
  const SELECTS = ["payStrategy", "spendTiming"];
  const STORAGE_KEY = "payoff_v2";

  const METHODS = [
    { key: "standard", name: "Current schedule", sub: "Required payment only", color: "var(--s-std)", dashed: true },
    { key: "extra", name: "Extra payments", sub: "Leftover cash goes to principal", color: "var(--s-extra)" },
    { key: "heloc", name: "HELOC chunking", sub: "“Velocity banking”", color: "var(--s-heloc)", wide: true },
    { key: "aio", name: "All-in-one loan", sub: "First-lien HELOC as your bank account", color: "var(--s-aio)" },
  ];

  const $ = (id) => document.getElementById(id);
  const form = $("form");

  // ── Formatting ──────────────────────────────────────────────────────────
  const money0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const fmt$ = (n) => money0.format(Math.round(n));
  const fmtPct = (n) => `${+n.toFixed(3)}%`;
  function duration(months) {
    const y = Math.floor(months / 12);
    const m = months % 12;
    const parts = [];
    if (y) parts.push(`${y} yr${y === 1 ? "" : "s"}`);
    if (m) parts.push(`${m} mo${m === 1 ? "" : "s"}`);
    return parts.join(" ") || "0 mos";
  }
  function dateAfter(inputs, months) {
    const d = new Date(inputs.startYear, inputs.startMonth + months - 1, 1);
    return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  }
  function moreLess(diff) {
    return diff < 0 ? `${fmt$(-diff)} less` : `${fmt$(diff)} more`;
  }

  // Accepts "$300,000", "300k", "1.2m", "6.5%".
  function parseNum(str) {
    if (str == null) return null;
    const s = String(str).trim().toLowerCase().replace(/[$,%\s]/g, "");
    if (s === "") return null;
    const m = s.match(/^(-?\d*\.?\d+)([km])?$/);
    if (!m) return NaN;
    let n = parseFloat(m[1]);
    if (m[2] === "k") n *= 1e3;
    if (m[2] === "m") n *= 1e6;
    return n;
  }
  function formatField(name, value) {
    if (value === "" || value == null) return "";
    if (MONEY.includes(name)) return Math.round(value).toLocaleString("en-US");
    return String(value);
  }

  // Build DOM without innerHTML for anything data-derived.
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style") el.style.cssText = v;
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const svgNS = "http://www.w3.org/2000/svg";
  function s(tag, attrs) {
    const el = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    return el;
  }

  // ── State: URL hash > saved > defaults ──────────────────────────────────
  function loadState() {
    const state = Object.assign({}, DEFAULTS);
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (saved && typeof saved === "object") Object.assign(state, pickKnown(saved));
    } catch (e) {
      /* storage unavailable */
    }
    const params = new URLSearchParams(location.hash.slice(1));
    for (const key of Object.keys(DEFAULTS)) {
      if (!params.has(key)) continue;
      const raw = params.get(key);
      if (SELECTS.includes(key)) state[key] = raw;
      else {
        const n = parseNum(raw);
        state[key] = n == null || !isFinite(n) ? "" : n;
      }
    }
    return state;
  }
  function pickKnown(obj) {
    const out = {};
    for (const k of Object.keys(DEFAULTS)) if (k in obj) out[k] = obj[k];
    return out;
  }
  function writeForm(state) {
    for (const key of Object.keys(DEFAULTS)) {
      const el = $(key);
      if (!el) continue;
      el.value = SELECTS.includes(key) ? state[key] : formatField(key, state[key]);
    }
  }
  function readForm() {
    const state = {};
    for (const key of Object.keys(DEFAULTS)) {
      const el = $(key);
      if (SELECTS.includes(key)) state[key] = el.value;
      else {
        const n = parseNum(el.value);
        state[key] = n == null ? "" : n;
      }
    }
    return state;
  }
  function saveState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      /* ignore */
    }
    history.replaceState(null, "", "#" + toParams(state));
  }
  function toParams(state) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(state)) if (v !== "" && v != null && !Number.isNaN(v)) p.set(k, v);
    return p.toString();
  }

  // ── Validation ──────────────────────────────────────────────────────────
  function validate(state) {
    const problems = [];
    const label = (k) => document.querySelector(`label[for="${k}"]`).textContent;
    for (const k of CORE) {
      const v = state[k];
      if (Number.isNaN(v)) continue; // reported below
      if (v === "" || !isFinite(v)) problems.push(`Enter your ${label(k).toLowerCase()}.`);
      else if (v < 0 || (k !== "rate" && v === 0 && k !== "spending")) problems.push(`${label(k)} must be more than 0.`);
    }
    for (const k of ["helocRate", "aioRate", "maxCltv", "aioMaxLtv"]) {
      if (state[k] === "" || !isFinite(state[k]) || state[k] < 0) problems.push(`Check the ${label(k).toLowerCase()} setting.`);
    }
    if (state.rate > 25 || state.helocRate > 25 || state.aioRate > 25) problems.push("Interest rates above 25% look like a typo.");
    if (state.yearsLeft > 40) problems.push("Years left should be 40 or less.");
    for (const k of Object.keys(DEFAULTS)) {
      if (typeof state[k] === "number" && Number.isNaN(state[k])) problems.push(`“${$(k).value}” isn't a number (${label(k)}).`);
    }
    return problems;
  }

  function toEngineInput(state) {
    const n = (v, d) => (v === "" || v == null || !isFinite(v) ? d : v);
    return {
      balance: state.balance,
      rate: state.rate,
      yearsLeft: state.yearsLeft,
      homeValue: state.homeValue,
      income: state.income,
      spending: state.spending,
      payment: n(state.payment, null),
      payStrategy: state.payStrategy,
      spendTiming: state.spendTiming,
      helocRate: state.helocRate,
      maxCltv: state.maxCltv,
      helocLimit: n(state.helocLimit, 0),
      chunk: n(state.chunk, 0),
      helocAnnualFee: n(state.helocAnnualFee, 0),
      aioRate: state.aioRate,
      aioMaxLtv: state.aioMaxLtv,
      aioCost: n(state.aioCost, 0),
    };
  }

  // ── Rendering ───────────────────────────────────────────────────────────
  function render() {
    const state = readForm();
    saveState(state);
    const isExample = CORE.every((k) => state[k] === DEFAULTS[k]);
    $("example-note").hidden = !isExample;

    const problems = validate(state);
    const answer = $("answer");
    if (problems.length) {
      $("derived").replaceChildren();
      answer.querySelector(".headline").textContent = "Fill in your numbers to see the comparison";
      $("answer-sub").replaceChildren(h("ul", { class: "plain" }, problems.slice(0, 4).map((p) => h("li", null, p))));
      for (const id of ["answer-warn", "verdict", "stats", "race", "breakdown", "legend", "chart", "chart-note", "by-year", "stress", "rate-note"]) $(id).replaceChildren();
      return;
    }

    const input = toEngineInput(state);
    const r = E.run(input);
    const p = r.inputs;
    renderDerived(p, state);
    renderAnswer(r);
    renderBreakdown(r);
    renderChart(r);
    renderByYear(r);
    renderStress(input, r);
    renderRateNote(p);
  }

  function renderDerived(p, state) {
    const firstInterest = (p.balance * p.rate) / 100 / 12;
    const chip = (k, v, cls) => h("div", { class: "chip" }, h("span", { class: "k" }, k), h("span", { class: "v " + (cls || "") }, v));
    const items = [
      chip(state.payment === "" ? "Principal & interest (calc.)" : "Principal & interest", fmt$(p.payment) + "/mo"),
      chip("Left over each month", fmt$(p.leftover), p.leftover > 0 ? "fuel" : "bad"),
      chip("Equity a HELOC could use", fmt$(E.availableEquity(p))),
    ];
    if (state.payment !== "" && p.payment <= firstInterest) {
      items.push(h("div", { class: "chip note bad" }, `That payment doesn't cover the ${fmt$(firstInterest)} of monthly interest.`));
    } else if (state.payment !== "" && Math.abs(p.payment - p.scheduledPayment) / p.scheduledPayment > 0.05) {
      items.push(h("div", { class: "chip note" }, `Heads up: a ${fmtPct(p.rate)} loan paid off in ${duration(p.termMonths)} needs ${fmt$(p.scheduledPayment)}/mo. Check years left.`));
    }
    $("derived").replaceChildren(...items);
  }

  function verdictFor(method, m, extra, bd, p) {
    const name = method === "heloc" ? "A HELOC" : "An all-in-one loan";
    if (m.unavailable) return null;
    if (m.neverPaysOff) return `${name} never pays the debt off with these numbers.`;
    const diff = m.cost - extra.cost;
    const tol = Math.max(500, extra.cost * 0.01);
    const theirRate = method === "heloc" ? p.helocRate : p.aioRate;
    let why = "";
    if (bd) {
      if (theirRate > p.rate && diff > 0) why = `, mainly because its ${fmtPct(theirRate)} rate is higher than your ${fmtPct(p.rate)} mortgage`;
      else if (theirRate < p.rate && diff < 0) why = `, mainly because its ${fmtPct(theirRate)} rate is lower than your ${fmtPct(p.rate)} mortgage`;
      else if (diff < 0) why = ", because your pay sitting in the account saves a little more than the higher rate costs";
      else if (diff > 0 && bd.fees > 0) why = ", mostly from fees and switching costs";
    }
    if (Math.abs(diff) <= tol) return `${name} comes out about the same as extra payments (${moreLess(diff)}).`;
    return `${name} costs ${moreLess(diff)} than extra payments${why}.`;
  }

  function renderAnswer(r) {
    const p = r.inputs;
    const std = r.standard;
    const extra = r.extra;
    const headline = $("answer").querySelector(".headline");
    const warn = $("answer-warn");
    warn.replaceChildren();

    if (p.leftover <= 0) {
      headline.replaceChildren("No leftover cash, ", h("em", null, "no shortcut."));
      $("answer-sub").textContent =
        `Pay minus spending minus the ${fmt$(p.payment)} mortgage payment is ${fmt$(p.leftover)} a month. ` +
        "Extra payments, a HELOC and an all-in-one loan all need leftover cash to work. With none, a HELOC or all-in-one balance grows instead of shrinking.";
      $("stats").replaceChildren();
    } else {
      headline.replaceChildren("Debt-free by ", h("em", null, dateAfter(p, extra.months)), ".");
      $("answer-sub").textContent =
        `That speed comes from sending your ${fmt$(p.leftover)} a month of leftover cash at the debt. ` +
        "Every route below uses the same money; they differ in cost, flexibility and risk.";
      if (p.leftover < p.income * 0.1) {
        warn.append(
          h("div", { class: "warn" }, h("strong", null, "Thin margin. "), `Your leftover is ${Math.round((p.leftover / p.income) * 100)}% of pay. One surprise expense could push a HELOC or all-in-one balance up instead of down.`)
        );
      }
      renderStats([
        { k: "Time saved", v: std.months - extra.months, f: duration, s: `vs. ${dateAfter(p, std.months)} on schedule`, c: "var(--accent)" },
        { k: "Interest avoided", v: std.cost - extra.cost, f: fmt$, s: "vs. the current schedule", c: "var(--green)" },
        { k: "Your fuel", v: p.leftover, f: (n) => fmt$(n) + "/mo", s: "left over after bills", c: "var(--amber)" },
      ]);
    }
    renderRace(r);

    const lines = [];
    if (p.leftover > 0) {
      for (const k of ["heloc", "aio"]) {
        const v = verdictFor(k, r[k], extra, r[k + "Breakdown"], p);
        if (v) lines.push(v);
      }
      lines.push("Neither one gets you there meaningfully faster. What you'd be paying for, or saving on, is access to your money, not speed.");
    }
    $("verdict").textContent = lines.join(" ");
  }

  // Big numbers count from their previous value to the new one.
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function renderStats(items) {
    const host = $("stats");
    const old = Array.from(host.children).map((el) => Number(el.dataset.value));
    host.replaceChildren(
      ...items.map((it, i) => {
        const v = h("div", { class: "v num" }, it.f(it.v));
        const tile = h("div", { class: "stat", style: `--c:${it.c}`, "data-value": it.v }, h("div", { class: "k" }, it.k), v, h("div", { class: "s" }, it.s));
        const from = isFinite(old[i]) ? old[i] : 0;
        if (!reduceMotion && from !== it.v) countUp(v, from, it.v, it.f);
        return tile;
      })
    );
  }
  function countUp(el, from, to, f) {
    const t0 = performance.now();
    const dur = 700;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = f(Math.round(from + (to - from) * e));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function renderRace(r) {
    const p = r.inputs;
    const extra = r.extra;
    const finite = METHODS.map((m) => r[m.key]).filter((x) => !x.unavailable && !x.neverPaysOff).map((x) => x.months);
    const maxMonths = Math.max(...finite, 1);
    const host = $("race");
    const oldFills = {};
    host.querySelectorAll(".fill").forEach((f) => (oldFills[f.dataset.key] = f.style.width));
    const lanes = METHODS.map((m) => {
      const res = r[m.key];
      const key = h("span", { class: "key" + (m.dashed ? " dashed" : "") + (m.wide ? " wide" : ""), style: `border-color:${m.color}`, "aria-hidden": "true" });
      const who = h("div", { class: "who" }, key, h("div", null, h("b", null, m.name), h("small", null, m.sub)));
      if (res.unavailable) {
        return h("div", { class: "lane", role: "listitem" }, who, h("div", { class: "na" }, unavailableText(m.key, res, r)));
      }
      const pct = res.neverPaysOff ? 100 : (res.months / maxMonths) * 100;
      const fill = h("div", { class: "fill" + (m.dashed ? " dashed" : ""), "data-key": m.key, style: `--c:${m.color};width:${oldFills[m.key] || "0%"}` });
      requestAnimationFrame(() => requestAnimationFrame(() => (fill.style.width = pct.toFixed(2) + "%")));
      const track = h("div", { class: "track", "aria-hidden": "true" }, fill);
      const when = res.neverPaysOff
        ? h("div", { class: "when" }, h("b", { class: "worse" }, "Never"), h("small", null, "balance doesn't fall"))
        : h("div", { class: "when" }, h("b", null, dateAfter(p, res.months)), h("small", null, duration(res.months)));
      let tag;
      if (m.key === "extra") tag = h("span", { class: "tag base" }, "the benchmark");
      else if (res.neverPaysOff || extra.neverPaysOff) tag = null;
      else {
        const diff = res.cost - extra.cost;
        const tol = Math.max(500, extra.cost * 0.01);
        const cls = Math.abs(diff) <= tol ? "same" : diff < 0 ? "better" : "worse";
        tag = h("span", { class: "tag " + cls }, Math.abs(diff) < 1 ? "same as extra payments" : `${moreLess(diff)} than extra payments`);
      }
      const meta = h(
        "div",
        { class: "meta" },
        res.neverPaysOff ? null : h("span", null, "Interest & fees ", h("strong", { class: "num" }, fmt$(res.cost))),
        tag
      );
      return h("div", { class: "lane", role: "listitem" }, who, track, when, meta);
    });
    host.replaceChildren(...lanes);
  }

  function unavailableText(key, res, r) {
    const p = r.inputs;
    if (key === "heloc" && res.reason === "leftover") {
      return "Won't work: there's no leftover cash each month to pay a HELOC back down.";
    }
    if (key === "heloc") {
      const target = p.homeValue * (p.maxCltv / 100) - 10000;
      const idx = r.extra.series.findIndex((b) => b <= target);
      const when = target > 0 && idx > 0 ? ` With extra payments you'd get there around ${dateAfter(p, idx)}.` : "";
      return `Not available yet: at ${fmtPct(p.maxCltv)} combined loan-to-value there's only ${fmt$(res.equity)} of usable equity. You'd need your balance below about ${fmt$(Math.max(0, target))}.${when}`;
    }
    return `Likely not available: lenders typically cap it at ${fmtPct(p.aioMaxLtv)} of home value (${fmt$(res.maxLoan)}), and you'd need ${fmt$(p.balance + p.aioCost)}.`;
  }

  function renderBreakdown(r) {
    const p = r.inputs;
    const cards = [];
    for (const [key, title, rateLabel] of [
      ["heloc", "HELOC chunking", p.helocRate],
      ["aio", "All-in-one loan", p.aioRate],
    ]) {
      const res = r[key];
      const bd = r[key + "Breakdown"];
      const body = [h("h3", null, `${title} @ ${fmtPct(rateLabel)}`)];
      if (!bd) {
        body.push(h("p", { class: "same" }, res.unavailable ? unavailableText(key, res, r) : "Doesn't pay off with these numbers, so there's nothing to compare."));
      } else {
        const row = (label, value, cls, total) => h("div", { class: "bd-row" + (total ? " total" : "") }, h("span", null, label), h("span", { class: "num " + (cls || "") }, value));
        const signed = (n) => (n < 0 ? "−" + fmt$(-n) : "+" + fmt$(n));
        const tone = (n) => (n < -0.5 ? "save" : n > 0.5 ? "cost" : "");
        const rateWord = rateLabel >= p.rate ? "Higher" : "Lower";
        body.push(
          row("Pay sitting against the balance", signed(bd.timing), tone(bd.timing)),
          row(`${rateWord} rate than your ${fmtPct(p.rate)} mortgage`, signed(bd.rateCost), tone(bd.rateCost)),
          row(key === "aio" ? "Switching costs" : "Fees", signed(bd.fees), tone(bd.fees)),
          row("Net vs. extra payments", moreLess(bd.net), tone(bd.net), true)
        );
        const facts =
          key === "heloc"
            ? `${res.chunks} chunks of up to ${fmt$(res.chunkSize)} on a ${fmt$(res.limit)} line. Average HELOC balance: ${fmt$(res.avgLine)}.`
            : `Average balance you pay interest on: ${fmt$(res.avgLine)}.`;
        body.push(h("p", { class: "fine", style: "margin:10px 0 0" }, facts));
      }
      cards.push(h("div", { class: "bd", style: `--c:${key === "heloc" ? "var(--s-heloc)" : "var(--s-aio)"}` }, body));
    }
    $("breakdown").replaceChildren(...cards);
  }

  // ── Chart: total debt over time ─────────────────────────────────────────
  let chartState = null;
  function renderChart(r) {
    const p = r.inputs;
    const series = METHODS.filter((m) => !r[m.key].unavailable).map((m) => ({ m, res: r[m.key], data: r[m.key].series }));
    const legend = $("legend");
    legend.replaceChildren(
      ...series.map(({ m, res }) =>
        h(
          "span",
          null,
          h("span", { class: "key" + (m.dashed ? " dashed" : "") + (m.wide ? " wide" : ""), style: `border-color:${m.color}`, "aria-hidden": "true" }),
          `${m.name}: ${res.neverPaysOff ? "never" : dateAfter(p, res.months)}`
        )
      )
    );

    const host = $("chart");
    const width = Math.max(300, host.clientWidth || 600);
    const small = width < 520;
    const height = small ? 220 : 260;
    const pad = { l: small ? 44 : 56, r: 14, t: 10, b: 28 };
    const maxX = Math.max(...series.map((d) => d.data.length - 1), 12);
    const maxY = Math.max(...series.map((d) => Math.max(...d.data)), 1);
    const yStep = niceStep(maxY / 4);
    const yMax = Math.ceil(maxY / yStep) * yStep;
    const x = (i) => pad.l + (i / maxX) * (width - pad.l - pad.r);
    const y = (v) => pad.t + (1 - v / yMax) * (height - pad.t - pad.b);

    const svg = s("svg", {
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": "Line chart of total debt over time for each method. Use the table below for exact numbers.",
      tabindex: "0",
    });
    for (let v = 0; v <= yMax + 1; v += yStep) {
      svg.append(s("line", { class: "grid-line", x1: pad.l, x2: width - pad.r, y1: y(v), y2: y(v) }));
      const t = s("text", { x: pad.l - 8, y: y(v) + 4, "text-anchor": "end" });
      t.textContent = v === 0 ? "$0" : v >= 1e6 ? `$${+(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1000)}k`;
      svg.append(t);
    }
    const years = maxX / 12;
    const yearStep = years <= 12 ? 1 : years <= 24 ? 2 : 5;
    for (let yr = 0; yr * 12 <= maxX; yr += yearStep) {
      const t = s("text", { x: x(yr * 12), y: height - 8, "text-anchor": "middle" });
      t.textContent = yr === 0 ? "Now" : `${yr}y`;
      svg.append(t);
    }
    svg.append(s("line", { class: "axis", x1: pad.l, x2: width - pad.r, y1: y(0), y2: y(0) }));

    // Extra payments and HELOC often follow nearly the same path. Draw the
    // HELOC as a wide, soft band underneath so both stay visible.
    const order = ["standard", "aio", "heloc", "extra"];
    const drawn = series.slice().sort((a, b) => order.indexOf(a.m.key) - order.indexOf(b.m.key));
    for (const d of drawn) {
      const pts = d.data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
      const wide = d.m.key === "heloc";
      svg.append(
        s("polyline", {
          points: pts,
          fill: "none",
          stroke: d.m.color,
          "stroke-width": wide ? 6 : 2,
          "stroke-opacity": wide ? 0.55 : 1,
          "stroke-linejoin": "round",
          "stroke-linecap": "round",
          "stroke-dasharray": d.m.dashed ? "6 5" : "none",
        })
      );
    }
    const overlaps = [];
    const ex = r.extra;
    for (const k of ["heloc", "aio"]) {
      const o = r[k];
      if (!o.unavailable && !o.neverPaysOff && !ex.neverPaysOff && Math.abs(o.months - ex.months) <= 2) overlaps.push(k === "heloc" ? "HELOC chunking" : "the all-in-one loan");
    }
    $("chart-note").textContent = overlaps.length
      ? `Extra payments and ${overlaps.join(" and ")} follow almost the same path, so their lines overlap.`
      : "";
    for (const d of series) {
      if (d.res.neverPaysOff) continue;
      svg.append(s("circle", { cx: x(d.res.months), cy: y(0), r: 4.5, fill: d.m.color, stroke: "var(--surface)", "stroke-width": 2 }));
    }
    const hair = s("line", { class: "hair", x1: 0, x2: 0, y1: pad.t, y2: y(0), visibility: "hidden" });
    svg.append(hair);
    const hit = s("rect", { x: pad.l, y: pad.t, width: width - pad.l - pad.r, height: height - pad.t - pad.b, fill: "transparent" });
    svg.append(hit);

    const tip = h("div", { class: "tip", hidden: true });
    host.replaceChildren(svg, tip);
    chartState = { x, maxX, series, p, hair, tip, host, width, pad, month: null };

    const moveTo = (month) => {
      month = Math.max(0, Math.min(maxX, month));
      chartState.month = month;
      const hx = x(month);
      hair.setAttribute("x1", hx);
      hair.setAttribute("x2", hx);
      hair.setAttribute("visibility", "visible");
      const title = month === 0 ? "Today" : `${dateAfter(p, month)} · after ${duration(month)}`;
      tip.replaceChildren(
        h("div", { class: "t-title" }, title),
        ...series.map((d) => {
          const v = month < d.data.length ? d.data[month] : d.res.neverPaysOff ? null : 0;
          return h(
            "div",
            { class: "t-row" },
            h("span", { class: "key" + (d.m.dashed ? " dashed" : "") + (d.m.wide ? " wide" : ""), style: `border-color:${d.m.color}` }),
            h("span", null, d.m.name),
            h("strong", null, v == null ? "—" : fmt$(v))
          );
        })
      );
      tip.hidden = false;
      const scale = host.clientWidth / width;
      const left = hx * scale;
      const tw = tip.offsetWidth;
      tip.style.left = `${left + 12 + tw > host.clientWidth ? left - tw - 12 : left + 12}px`;
      tip.style.top = `${pad.t}px`;
    };
    const hide = () => {
      hair.setAttribute("visibility", "hidden");
      tip.hidden = true;
      chartState.month = null;
    };
    svg.addEventListener("pointermove", (e) => {
      const rect = svg.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * width;
      moveTo(Math.round(((px - pad.l) / (width - pad.l - pad.r)) * maxX));
    });
    svg.addEventListener("pointerleave", hide);
    svg.addEventListener("focus", () => moveTo(0));
    svg.addEventListener("blur", hide);
    svg.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 12 : 1;
      if (e.key === "ArrowRight") moveTo((chartState.month ?? 0) + step);
      else if (e.key === "ArrowLeft") moveTo((chartState.month ?? 0) - step);
      else if (e.key === "Escape") hide();
      else return;
      e.preventDefault();
    });
  }
  function niceStep(raw) {
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / pow;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
  }

  function renderByYear(r) {
    const p = r.inputs;
    const cols = METHODS.filter((m) => !r[m.key].unavailable);
    const last = Math.max(...cols.map((m) => r[m.key].series.length - 1));
    const head = h("thead", null, h("tr", null, h("th", { scope: "col" }, "After"), cols.map((m) => h("th", { scope: "col", class: "r" }, m.name))));
    const rows = [];
    for (let mo = 12; mo <= last + 11; mo += 12) {
      const month = Math.min(mo, last);
      rows.push(
        h(
          "tr",
          null,
          h("th", { scope: "row" }, `${Math.ceil(month / 12)} yr${month > 12 ? "s" : ""}`, h("span", { class: "sub" }, dateAfter(p, month))),
          cols.map((m) => {
            const d = r[m.key].series;
            const v = month < d.length ? d[month] : r[m.key].neverPaysOff ? null : 0;
            return h("td", { class: "r" }, v == null ? "—" : fmt$(v));
          })
        )
      );
    }
    $("by-year").replaceChildren(head, h("tbody", null, rows));
  }

  function renderStress(input, base) {
    const st = E.stress(input);
    const p = base.inputs;
    const cols = [
      ["extra", "Extra payments"],
      ["heloc", "HELOC"],
      ["aio", "All-in-one"],
    ].filter(([k]) => !base[k].unavailable);
    const cell = (k, label, res) => {
      const b = base[k];
      const at = { "data-label": label };
      if (res.unavailable) return h("td", at, "Not available");
      if (res.neverPaysOff || res.lineMaxed) return h("td", at, h("span", { class: "worse" }, "Never pays off"));
      if (b.neverPaysOff) return h("td", at, dateAfter(p, res.months));
      const dm = res.months - b.months;
      const dc = res.cost - b.cost;
      if (Math.abs(dm) === 0 && Math.abs(dc) < 1) return h("td", Object.assign({ class: "same" }, at), "No change");
      return h(
        "td",
        at,
        h(
          "span",
          null,
          dateAfter(p, res.months),
          h("span", { class: "sub" }, `${dm > 0 ? "+" + duration(dm) : dm < 0 ? "−" + duration(-dm) : "same date"} · ${dc >= 0 ? "+" : "−"}${fmt$(Math.abs(dc))}`)
        )
      );
    };
    const rows = [
      ["Rates rise 2 points", "HELOC & all-in-one only; a fixed mortgage doesn't change", st.ratesUp2],
      ["Pay drops 10%", `${fmt$(p.income * 0.9)}/mo instead of ${fmt$(p.income)}`, st.incomeDown10],
      ["Spending rises 10%", `${fmt$(p.spending * 1.1)}/mo instead of ${fmt$(p.spending)}`, st.spendingUp10],
    ];
    $("stress").replaceChildren(
      h("thead", null, h("tr", null, h("th", { scope: "col" }, "What if"), cols.map(([, n]) => h("th", { scope: "col" }, n)))),
      h(
        "tbody",
        null,
        rows.map(([title, sub, res]) => h("tr", null, h("th", { scope: "row" }, title, h("span", { class: "sub" }, sub)), cols.map(([k, n]) => cell(k, n, res[k]))))
      )
    );
  }

  function renderRateNote(p) {
    const note = $("rate-note");
    note.replaceChildren();
    if (p.rate < 4.5) {
      note.append(
        h(
          "div",
          { class: "warn" },
          h("strong", null, `Your mortgage rate is ${fmtPct(p.rate)}. `),
          `Every extra dollar you put toward it earns exactly ${fmtPct(p.rate)}, guaranteed. ` +
            "Moving that debt to a HELOC or all-in-one loan at a higher variable rate usually costs more, and money in savings or investments may earn more than the mortgage costs."
        )
      );
    }
  }

  // ── Wiring ──────────────────────────────────────────────────────────────
  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(render, 150);
  }
  form.addEventListener("input", schedule);
  $("settings").addEventListener("input", schedule);
  $("settings").addEventListener("change", schedule);
  document.addEventListener(
    "blur",
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLInputElement) || !(el.id in DEFAULTS)) return;
      const n = parseNum(el.value);
      if (n != null && isFinite(n)) el.value = formatField(el.id, n);
    },
    true
  );
  form.addEventListener("submit", (e) => e.preventDefault());

  // Sliders mirror their text field; dragging one updates the answer live.
  const sliders = Array.from(document.querySelectorAll('input[type="range"][data-for]'));
  function paintSlider(r) {
    const pct = ((r.value - r.min) / (r.max - r.min)) * 100;
    r.style.setProperty("--pct", pct + "%");
  }
  function syncSliders() {
    for (const r of sliders) {
      const n = parseNum($(r.dataset.for).value);
      if (n != null && isFinite(n)) r.value = Math.min(Number(r.max), Math.max(Number(r.min), n));
      paintSlider(r);
    }
  }
  for (const r of sliders) {
    r.addEventListener("input", () => {
      const target = $(r.dataset.for);
      target.value = formatField(target.id, Number(r.value));
      paintSlider(r);
      schedule();
    });
  }
  document.addEventListener("input", (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type !== "range") syncSliders();
  });

  $("copy-link").addEventListener("click", async () => {
    const url = location.href;
    const status = $("status");
    try {
      await navigator.clipboard.writeText(url);
      status.textContent = "Link copied. Anyone who opens it sees these numbers.";
    } catch (e) {
      window.prompt("Copy this link:", url);
    }
  });
  $("reset").addEventListener("click", () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      /* ignore */
    }
    writeForm(DEFAULTS);
    syncSliders();
    render();
    $("status").textContent = "Reset to the example numbers.";
  });

  let lastWidth = 0;
  window.addEventListener("resize", () => {
    const w = $("chart").clientWidth;
    if (Math.abs(w - lastWidth) > 20) {
      lastWidth = w;
      schedule();
    }
  });
  window.addEventListener("hashchange", () => {
    writeForm(loadState());
    syncSliders();
    render();
  });

  writeForm(loadState());
  syncSliders();
  render();
  lastWidth = $("chart").clientWidth;
})();
