import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import * as d3 from "d3";
import { initTheme, initSkin, cssVar, tooltip, el, tipRow, loadJSON, fmtInt, treeList } from "../shared/ui.js";
import "./skin.js";

const DATA = "./data/blossom/";
const GROUP_ORDER = ["plum", "early", "yoshino", "japanese", "wild", "bitter"];
const ZOOM = { victoria: 13.2, vancouver: 12.2, cowichan: 11.5, nanaimo: 12, comox: 11.5 };
const KIND_LABEL = { clim: "Climatology", gdd: "Thermal time", chill: "Chill + thermal", tsens: "Temp. sensitivity", borrowed: "Borrowed response" };
const MAP_STYLE = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };

const isDark = initTheme(document.getElementById("theme"));
initSkin(document.getElementById("skin"));
const tip = tooltip();

const TIER_ORDER = ["S", "A", "B", "C", "D"];
const PINNED = "yoshino";   // Somei-yoshino, Japan's reference hanami cherry, leads the S tier
const state = { region: "victoria", doy: 90, cv: new Set(), colourBy: "bloom",
  historyGroup: "plum", scatterGroup: "plum", playing: false };
let meta, forecast, history, backtest, trees, streets, sightings, cultivars, map;

// ------------------------------------------------------------------ dates & probabilities
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
function doyToDate(doy, year = meta.season) {
  const d = Math.round(doy) + (isLeap(year) && doy > 59 ? 1 : 0);
  return new Date(year, 0, d);
}
function dateToDoy(date) {
  // UTC arithmetic so daylight-saving shifts never move a date to the previous day
  let doy = Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 0)) / 864e5);
  if (isLeap(date.getFullYear()) && date.getMonth() > 1) doy -= 1;
  return doy;
}
const fmtMD = d3.timeFormat("%b %-d");
const fmtDoy = (doy) => fmtMD(doyToDate(doy));
const isoDoy = (iso) => dateToDoy(new Date(iso + "T12:00:00"));

// CDF from 20 equally spaced predictive quantiles (2.5%, 7.5%, … 97.5%), with linear tails.
function cdf(q, x) {
  const n = q.length, p = (i) => (i + 0.5) / n;
  if (x <= q[0]) return Math.max(0, p(0) * (1 - (q[0] - x) / Math.max(2, (q[1] - q[0]) * 3)));
  if (x >= q[n - 1]) return Math.min(1, p(n - 1) + (1 - p(n - 1)) * ((x - q[n - 1]) / Math.max(2, (q[n - 1] - q[n - 2]) * 3)));
  for (let i = 0; i < n - 1; i++) {
    if (x <= q[i + 1]) return p(i) + (p(i + 1) - p(i)) * (x - q[i]) / ((q[i + 1] - q[i]) || 1);
  }
  return 1;
}
function bloomProb(region, group, doy) {
  const f = forecast.regions[region]?.groups[group];
  if (!f) return 0;
  const h = meta.groups[group].half_window;
  return Math.max(0, cdf(f.q, doy + h) - cdf(f.q, doy - h));
}

// tree counts by group for the region (or overall mix for regions without an inventory)
function groupWeights(region) {
  const idx = meta.regions[region].tree_cities.map((c) => trees.cities.indexOf(c));
  const counts = Object.fromEntries(GROUP_ORDER.map((g) => [g, 0]));
  for (const r of trees.rows) if (!idx.length || idx.includes(r[5])) counts[trees.groups[r[2]]]++;
  return counts;
}
function expectedCurve(region) {
  const w = groupWeights(region);
  const total = d3.sum(Object.values(w));
  const out = [];
  for (let doy = 15; doy <= 151; doy++) {
    const n = d3.sum(GROUP_ORDER, (g) => w[g] * bloomProb(region, g, doy));
    out.push({ doy, n, share: total ? n / total : 0 });
  }
  return { curve: out, total };
}

// ------------------------------------------------------------------ boot
init().catch((err) => {
  console.error(err);
  document.querySelector("main").prepend(el("div", { class: "wrap", style: { padding: "24px", color: "var(--accent)" } }, `Could not load data: ${err.message}`));
});

async function init() {
  [meta, forecast, history, backtest, trees, streets, sightings, cultivars] = await Promise.all(
    ["meta", "forecast", "history", "backtest", "trees", "streets", "sightings", "cultivars"].map((n) => loadJSON(`${DATA}${n}.json`)));

  const hash = new URLSearchParams(location.hash.slice(1));
  if (meta.regions[hash.get("region")]) state.region = hash.get("region");

  state.cv = new Set(trees.cultivars.map((_, i) => i));          // every cultivar shown to start
  document.getElementById("season-label").textContent = `Spring ${meta.season} forecast`;
  buildRegionButtons();
  buildGroupChips();
  buildTierControls();
  buildHistoryButtons();
  initMap();
  setRegion(state.region, { initial: true, date: hash.get("date") });

  const slider = document.getElementById("slider");
  slider.addEventListener("input", () => setDoy(+slider.value));
  document.getElementById("play").addEventListener("click", togglePlay);
  document.getElementById("show-sightings").addEventListener("change", (e) => { e.target.dataset.user = e.target.checked ? "on" : "off"; updateMapLayers(); });

  renderModelCard();
  document.getElementById("generated").textContent =
    `Data refreshed ${new Date(meta.generated).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}. ` +
    `Weather through ${forecast.regions[state.region].data_through}.`;

  let raf;
  new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderCharts); }).observe(document.querySelector("main"));
  window.addEventListener("themechange", () => { map?.setStyle(isDark() ? MAP_STYLE.dark : MAP_STYLE.light); renderRibbon(); });
}

// ------------------------------------------------------------------ controls
function buildRegionButtons() {
  const wrap = document.getElementById("regions");
  for (const [key, r] of Object.entries(meta.regions)) {
    wrap.append(el("button", { type: "button", "data-region": key, "aria-pressed": key === state.region, onclick: () => setRegion(key) }, r.name));
  }
}
// The map filter is one set of cultivars (state.cv). Group and tier chips are presets that tick or untick theirs,
// and the tree list edits it one cultivar at a time.
const cvIdx = (pred) => trees.cultivars.map((k, i) => (pred(cultivars[k], k) ? i : -1)).filter((i) => i >= 0);
const regionCount = (k) => d3.sum(meta.regions[state.region].tree_cities, (ct) => cultivars[k].counts[ct] || 0);
const present = (pred) => cvIdx((c, k) => pred(c, k) && (!meta.regions[state.region].has_trees || regionCount(k) > 0));
const allOn = (ids) => ids.length > 0 && ids.every((i) => state.cv.has(i));
const groupOn = (g) => trees.cultivars.some((k, i) => cultivars[k].group === g && state.cv.has(i));
let groupChips = [], tierChips = [], allChip, list;
function syncFilters() {
  groupChips.forEach(([g, chip]) => chip.setAttribute("aria-pressed", String(allOn(present((c) => c.group === g)))));
  const everything = allOn(present(() => true));
  allChip?.setAttribute("aria-pressed", String(everything));
  tierChips.forEach(([t, chip]) => chip.setAttribute("aria-pressed", String(allOn(present((c) => c.tier === t)))));
  list?.paint();
  updateMapLayers();
  renderStreets();
}
function togglePreset(ids) {
  if (allOn(ids)) ids.forEach((i) => state.cv.delete(i)); else ids.forEach((i) => state.cv.add(i));
  if (!state.cv.size) trees.cultivars.forEach((_, i) => state.cv.add(i));
  syncFilters();
}
function buildGroupChips() {
  const wrap = document.getElementById("group-chips");
  groupChips = GROUP_ORDER.map((g) => {
    const chip = el("button", { type: "button", class: "chip", "aria-pressed": "true", title: meta.groups[g].label },
      el("span", { class: "sw", style: { background: "var(--accent)", opacity: 0.35 + 0.65 * (GROUP_ORDER.indexOf(g) / 5) } }),
      shortGroup(g));
    chip.addEventListener("click", () => togglePreset(cvIdx((c) => c.group === g)));
    wrap.append(chip);
    return [g, chip];
  });
}
// Tier controls: colour the map by tier; tier chips are presets ("All trees" resets).
const tierColour = (t) => cssVar(`--tier-map-${t}`);
const tierOf = (ci) => cultivars[trees.cultivars[ci]]?.tier ?? "D";
function buildTierControls() {
  for (const b of document.querySelectorAll("#colour-by button")) {
    b.addEventListener("click", () => {
      state.colourBy = b.dataset.v;
      for (const x of document.querySelectorAll("#colour-by button")) x.setAttribute("aria-pressed", String(x === b));
      document.getElementById("legend-bloom").hidden = state.colourBy !== "bloom";
      document.getElementById("legend-tier").hidden = state.colourBy !== "tier";
      updateMapLayers();
    });
  }
  allChip = el("button", { type: "button", class: "chip", "aria-pressed": "true" }, "All trees");
  allChip.addEventListener("click", () => { trees.cultivars.forEach((_, i) => state.cv.add(i)); syncFilters(); });
  tierChips = TIER_ORDER.map((t) => {
    const chip = el("button", { type: "button", class: "chip", "aria-pressed": "true", title: meta.tiers[t] },
      el("span", { class: "sw", style: { background: `var(--tier-map-${t})` } }), `${t}`);
    chip.addEventListener("click", () => {
      const ids = cvIdx((c) => c.tier === t);
      // from "all trees", a tier chip isolates its tier; after that, chips add or remove whole tiers
      if (allOn(present(() => true))) { state.cv = new Set(ids); syncFilters(); } else togglePreset(ids);
    });
    return [t, chip];
  });
  document.getElementById("tier-chips").replaceChildren(allChip, ...tierChips.map(([, c]) => c));
  document.getElementById("tier-legend").replaceChildren(...TIER_ORDER.map((t) =>
    el("div", { class: "tl-row" }, el("i", { style: { background: `var(--tier-map-${t})` } }), el("b", {}, t), el("span", {}, meta.tiers[t]))));
}
// One row per cultivar on this region's streets: tier order (Somei-yoshino first), then most common.
function renderTreeList() {
  const hasTrees = meta.regions[state.region].has_trees;
  const items = trees.cultivars.map((k, i) => ({ id: i, k, name: cultivars[k].name, tier: cultivars[k].tier,
    count: hasTrees ? regionCount(k) : 0, colour: `var(--tier-map-${cultivars[k].tier})` }))
    .filter((it) => !hasTrees || it.count > 0)
    .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || (b.k === PINNED) - (a.k === PINNED) || b.count - a.count);
  list = treeList(document.getElementById("tree-list"), items, state.cv, syncFilters, { placeholder: "Find a cherry or plum…" });
}

const shortGroup = (g) => ({ plum: "Plums", early: "Early cherries", yoshino: "Yoshino & Akebono", japanese: "Japanese cherries", wild: "Wild cherry", bitter: "Bitter cherry" })[g];

function buildHistoryButtons() {
  const modelled = Object.keys(meta.model_card).filter((g) => meta.model_card[g].chosen !== "clim");
  const ordered = GROUP_ORDER.filter((g) => modelled.includes(g));
  const mk = (id, key, onPick) => {
    const wrap = document.getElementById(id);
    for (const g of ordered) {
      wrap.append(el("button", { type: "button", "aria-pressed": g === state[key], onclick: (e) => {
        state[key] = g;
        wrap.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b === e.currentTarget));
        onPick();
      } }, shortGroup(g)));
    }
  };
  mk("history-groups", "historyGroup", renderHistory);
  const scatterGroups = GROUP_ORDER.filter((g) => meta.model_card[g]);
  const sw = document.getElementById("scatter-groups");
  for (const g of scatterGroups) {
    sw.append(el("button", { type: "button", "aria-pressed": g === state.scatterGroup, onclick: (e) => {
      state.scatterGroup = g;
      sw.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b === e.currentTarget));
      renderScatter();
    } }, shortGroup(g)));
  }
}

function setRegion(key, { initial = false, date = null } = {}) {
  state.region = key;
  document.querySelectorAll("#regions button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.region === key));
  const { curve } = expectedCurve(key);
  const peak = d3.greatest(curve, (d) => d.n);
  const today = new Date();
  const todayDoy = dateToDoy(today);
  if (date && !isNaN(new Date(date))) state.doy = dateToDoy(new Date(date + "T12:00:00"));
  else if (today.getFullYear() === meta.season && todayDoy >= 15 && todayDoy <= 151) state.doy = todayDoy;
  else state.doy = peak.doy;
  if (map) {
    const r = meta.regions[key];
    map[initial ? "jumpTo" : "flyTo"]({ center: r.center, zoom: ZOOM[key], ...(initial ? {} : { duration: 1600 }) });
  }
  renderHero(peak);
  renderTreeList();
  groupChips.forEach(([g, chip]) => chip.setAttribute("aria-pressed", String(allOn(present((c) => c.group === g)))));
  tierChips.forEach(([t, chip]) => chip.setAttribute("aria-pressed", String(allOn(present((c) => c.tier === t)))));
  allChip?.setAttribute("aria-pressed", String(allOn(present(() => true))));
  const sToggle = document.getElementById("show-sightings");
  sToggle.checked = !meta.regions[key].has_trees || sToggle.dataset.user === "on";
  setDoy(state.doy);
  renderTiers();
  renderCharts();
}

function setDoy(doy) {
  state.doy = Math.max(15, Math.min(151, Math.round(doy)));
  document.getElementById("slider").value = state.doy;
  document.getElementById("slider-date").textContent = fmtMD(doyToDate(state.doy)) + `, ${meta.season}`;
  const today = new Date();
  document.getElementById("slider-note").textContent =
    today.getFullYear() === meta.season && dateToDoy(today) === state.doy ? "· today" : "· forecast";
  history_replaceHash();
  updateMapLayers();
  renderStreets();
  renderRibbonPlayhead();
  renderCalendarPlayhead();
}

function history_replaceHash() {
  const d = doyToDate(state.doy);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  window.history.replaceState(null, "", `#region=${state.region}&date=${iso}`);
}

function togglePlay() {
  const btn = document.getElementById("play");
  state.playing = !state.playing;
  btn.innerHTML = state.playing
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>'
    : '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>';
  btn.setAttribute("aria-label", state.playing ? "Pause" : "Play through the season");
  if (!state.playing) return;
  if (state.doy >= 151) setDoy(15);
  let last = 0;
  const step = (t) => {
    if (!state.playing) return;
    if (t - last > 90) {
      last = t;
      if (state.doy >= 151) { togglePlay(); return; }
      setDoy(state.doy + 1);
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ------------------------------------------------------------------ hero
function renderHero(peak) {
  const r = meta.regions[state.region];
  const f = forecast.regions[state.region].groups;
  const { total } = expectedCurve(state.region);
  document.getElementById("hero-label").textContent = `Peak blossom · ${r.name}`;
  document.getElementById("hero-date").textContent = fmtMD(doyToDate(peak.doy));
  const sub = r.has_trees
    ? `The day the most city trees are expected to be in flower, around ${fmtInt.format(Math.round(peak.n))} of ${fmtInt.format(total)}. `
    : `The day the most trees are expected to be in flower, assuming the typical street mix of plums and cherries. `;
  document.getElementById("hero-sub").textContent = sub +
    `First plums open around ${fmtMD(new Date(f.plum.p10 + "T12:00"))}. The last Kanzan cherries hang on until about ${fmtMD(new Date(f.japanese.p90 + "T12:00"))}.`;

  const card = meta.model_card;
  const tr = history[state.region].trends.plum || {};
  const shift = tr.shift_1951_80_vs_recent30;
  const tiles = [
    r.has_trees
      ? ["Public trees mapped", fmtInt.format(total), r.tree_cities.length > 1 ? "City of Victoria and Township of Esquimalt inventories" : `City of ${r.name} inventory`]
      : ["Public trees mapped", "—", "No municipal tree inventory is published here, so this region is forecast only"],
    ["Plums vs 1951–80", shift != null ? `${shift > 0 ? "+" : "−"}${Math.abs(shift).toFixed(0)} days` : "—",
      shift != null ? `${shift < 0 ? "Earlier" : "Later"} over the last 30 springs, by the model replayed on station weather` : ""],
    ["Typical forecast error", `±${card.plum.scores[card.plum.chosen].mae.toFixed(1)} days`, `Plum blossom, cross-validated (climatology alone: ±${card.plum.scores.clim.mae.toFixed(1)})`],
    ["Weather record", `${history[state.region].first_year}–`, r.station],
  ];
  const wrap = document.getElementById("stats");
  wrap.replaceChildren(...tiles.map(([l, v, s]) => el("div", { class: "card stat" },
    el("div", { class: "label" }, l), el("div", { class: "value" }, v), el("div", { class: "sub" }, s))));
}

// ------------------------------------------------------------------ map
function themeColors() {
  return ["--ramp-0", "--ramp-1", "--ramp-2", "--ramp-3", "--accent", "--accent-2", "--surface"].map((v) => cssVar(v));
}
const cityRegion = (i) => meta.cities[trees.cities[i]].region;
const cityLabel = (i) => ({ victoria: "City of Victoria", vancouver: "City of Vancouver", esquimalt: "Township of Esquimalt" })[trees.cities[i]];
const ICON_LEVELS = 6;

function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: isDark() ? MAP_STYLE.dark : MAP_STYLE.light,
    center: meta.regions[state.region].center,
    zoom: ZOOM[state.region],
    attributionControl: { compact: true },
    cooperativeGestures: matchMedia("(pointer: coarse)").matches,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.on("style.load", () => { tintBasemap(); addTreeIcons(); addMapLayers(); });
  new ResizeObserver(() => map.resize()).observe(document.getElementById("map"));
  if (import.meta.env.DEV) window.__map = map;   // handle for headless visual checks

  const pop = new maplibregl.Popup({ closeButton: true, maxWidth: "320px", className: "tree-popup" });
  for (const layer of ["trees", "trees-icons"]) {
    map.on("click", layer, (e) => {
      tip.hide();
      pop.setLngLat(e.features[0].geometry.coordinates).setDOMContent(treeProfile(e.features[0].properties, true)).addTo(map);
    });
    map.on("mousemove", layer, (e) => {
      map.getCanvas().style.cursor = "pointer";
      if (pop.isOpen()) return;
      tip.show(e.originalEvent.clientX, e.originalEvent.clientY, (t) => t.append(treeProfile(e.features[0].properties, false)));
    });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; tip.hide(); });
  }
  map.on("click", "sightings", (e) => {
    tip.hide();
    pop.setLngLat(e.features[0].geometry.coordinates).setDOMContent(sightingCard(e.features[0].properties, true)).addTo(map);
  });
  map.on("mousemove", "sightings", (e) => {
    map.getCanvas().style.cursor = "pointer";
    if (pop.isOpen()) return;
    tip.show(e.originalEvent.clientX, e.originalEvent.clientY, (t) => t.append(sightingCard(e.features[0].properties, false)));
  });
  map.on("mouseleave", "sightings", () => { map.getCanvas().style.cursor = ""; tip.hide(); });
}

// Profile card for one tree: cultivar photo, tier, flower attributes, size, forecast.
function treeProfile(p, pinned) {
  const ck = trees.cultivars[p.c];
  const cv = cultivars[ck];
  const g = trees.groups[p.g];
  const reg = cityRegion(p.city);
  const f = forecast.regions[reg].groups[g];
  const prob = bloomProb(reg, g, state.doy);
  const md = (iso) => fmtMD(new Date(iso + "T12:00"));
  const size = [p.ht ? `${p.ht} m tall` : null, p.dbh ? `${p.dbh} cm trunk` : null].filter(Boolean).join(" · ");
  const body = el("div", { class: "pf-body" },
    el("div", { class: "pf-name" }, cv.name),
    el("div", { class: "pf-sub" }, [p.addr || trees.streets[p.s], cityLabel(p.city)].filter(Boolean).join(" · ")),
    el("dl", { class: "pf-attrs" },
      el("dt", {}, "Flowers"), el("dd", {}, `${cv.colour}, ${cv.form.toLowerCase()}`),
      el("dt", {}, "Shape"), el("dd", {}, cv.habit),
      size ? el("dt", {}, "Size") : null, size ? el("dd", {}, size) : null,
      el("dt", {}, "Peak"), el("dd", {}, `${md(f.median)} (80%: ${md(f.p10)} – ${md(f.p90)})`)),
    el("div", { class: "pf-prob" }, el("b", {}, `${Math.round(prob * 100)}%`), ` chance in bloom on ${fmtMD(doyToDate(state.doy))}`),
    el("p", { class: "pf-note" }, cv.note));
  const card = el("div", { class: `profile${pinned ? " pinned" : ""}` },
    el("div", { class: `pf-photo${cv.photo ? "" : " none"}`, style: cv.photo ? { backgroundImage: `url("${cv.photo.thumb}")` } : {} },
      el("span", { class: `tier tier-${cv.tier}` }, `${cv.tier} tier`),
      cv.photo?.similar ? el("i", { class: "cv-similar" }, `look-alike: ${cultivars[cv.photo.similar].name}`) : null),
    body);
  if (pinned) {
    body.append(
      el("div", { class: "pf-links" },
        el("a", { href: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat},${p.lon}`, target: "_blank", rel: "noopener" }, "Street View ↗"),
        cv.photo ? el("a", { href: cv.photo.page, target: "_blank", rel: "noopener" }, "Photo source ↗") : null),
      cv.photo ? el("div", { class: "pf-credit" }, photoCredit(cv)) : null);
  } else {
    body.append(el("div", { class: "pf-credit" }, "Click for Street View and the photo credit"));
  }
  return card;
}

function photoCredit(cv) {
  const where = cv.photo.source === "inat" ? "iNaturalist" : "Wikimedia Commons";
  const what = cv.photo.similar ? `No open photo of ${cv.name} exists, so this is a look-alike ${cultivars[cv.photo.similar].name}` : `Typical ${cv.name} in bloom`;
  return `${what}. Photo: ${cv.photo.credit} (${cv.photo.license}), ${where}`;
}

function sightingCard(p, pinned) {
  return el("div", { class: `profile${pinned ? " pinned" : ""}` },
    p.photo ? el("div", { class: "pf-photo", style: { backgroundImage: `url("${p.photo}")` } }) : null,
    el("div", { class: "pf-body" },
      el("div", { class: "pf-name" }, p.taxon || shortGroup(sightings.groups[p.g])),
      el("div", { class: "pf-sub" }, `${p.place || "iNaturalist observation"} · ${fmtMD(new Date(p.date + "T12:00"))}, ${p.date.slice(0, 4)}`),
      p.attr ? el("div", { class: "pf-credit" }, p.attr) : null,
      pinned ? el("div", { class: "pf-links" }, el("a", { href: `https://www.inaturalist.org/observations/${p.id}`, target: "_blank", rel: "noopener" }, "View on iNaturalist ↗")) : null));
}

// Warm the basemap toward card stock (light) or soft graphite (dark) so it sits with the page.
// The Sakura.exe skin swaps in a pastel desktop palette (day) or dusky indigo (night), including roads.
const BASEMAP = {
  classic: {
    light: { bg: "#efe6d4", water: "#d6dfdc", green: "#e3e3cc", building: "#e6dac5" },
    dark: { bg: "#34302f", water: "#2a2e33", green: "#383a35", building: "#3d3837" },
  },
  alt: {
    light: { bg: "#f8edf0", water: "#a9dbd3", green: "#e6eedf", building: "#eedfe6", road: "#d8cbef", roadMajor: "#bba8e4", roadInner: "#f1eafb", path: "#e6dcf2" },
    dark: { bg: "#2a2142", water: "#182a4c", green: "#2d2a48", building: "#352a52", road: "#382d5c", roadMajor: "#473a76", roadInner: "#3d3268", path: "#31284f" },
  },
};
function tintBasemap() {
  const pal = BASEMAP[document.documentElement.dataset.skin === "alt" ? "alt" : "classic"][isDark() ? "dark" : "light"];
  for (const layer of map.getStyle().layers) {
    const id = layer.id.toLowerCase();
    try {
      if (layer.type === "background") map.setPaintProperty(layer.id, "background-color", pal.bg);
      else if (layer.type === "fill" && id.includes("water")) map.setPaintProperty(layer.id, "fill-color", pal.water);
      else if (layer.type === "fill" && ["park", "landcover", "landuse", "wood", "grass"].some((k) => id.includes(k)))
        map.setPaintProperty(layer.id, "fill-color", pal.green);
      else if (layer.type === "fill" && id.includes("building")) map.setPaintProperty(layer.id, "fill-color", pal.building);
      else if (pal.road && layer.type === "line" && id === "waterway") map.setPaintProperty(layer.id, "line-color", pal.water);
      else if (pal.road && layer.type === "line" && /^(highway|tunnel|road)_/.test(id) && !id.includes("motorway_inner"))
        map.setPaintProperty(layer.id, "line-color", id.includes("casing") ? pal.roadMajor : id.includes("major_inner") ? pal.roadInner : id.includes("path") ? pal.path : pal.road);
    } catch { /* layer may not support the property */ }
  }
}

// Tree icons: a trunk with a five-blossom canopy, pre-tinted at six bloom-chance levels.
function addTreeIcons() {
  const [r0, r1, r2, r3] = themeColors();
  const ramp = d3.scaleLinear([0, 0.25, 0.6, 1], [r0, r1, r2, r3]).interpolate(d3.interpolateRgb);
  const dark = isDark();
  for (let i = 0; i < ICON_LEVELS; i++) {
    const P = i / (ICON_LEVELS - 1);
    const s = 64, c = document.createElement("canvas");
    c.width = c.height = s;
    const ctx = c.getContext("2d");
    const bark = dark ? "#9a7f6b" : "#6d4c3a";
    ctx.fillStyle = bark;
    ctx.beginPath(); ctx.moveTo(29, 62); ctx.lineTo(31, 34); ctx.lineTo(33, 34); ctx.lineTo(35, 62); ctx.closePath(); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = bark; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(32, 42); ctx.lineTo(22, 31); ctx.moveTo(32, 39); ctx.lineTo(42, 29); ctx.stroke();
    const blobs = [[32, 20, 13], [19, 28, 11], [45, 28, 11], [24, 14, 9], [41, 14, 9]];
    ctx.fillStyle = dark ? "#2e2a2b" : "#fffaf0";
    for (const [x, y, r] of blobs) { ctx.beginPath(); ctx.arc(x, y, r + 2.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = ramp(P);
    for (const [x, y, r] of blobs) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
    if (P > 0.3) {   // little five-petal blossoms dotted on the canopy
      ctx.fillStyle = dark ? "#ffe3ee" : "#ffffff";
      for (const [x, y] of [[30, 17], [21, 29], [44, 26], [37, 24], [25, 14]]) {
        for (let k = 0; k < 5; k++) { const a = (k / 5) * Math.PI * 2; ctx.beginPath(); ctx.arc(x + 2.6 * Math.cos(a), y + 2.6 * Math.sin(a), 1.7, 0, Math.PI * 2); ctx.fill(); }
      }
    }
    const id = `tree-${i}`;
    if (map.hasImage(id)) map.removeImage(id);
    map.addImage(id, ctx.getImageData(0, 0, s, s), { pixelRatio: 2 });
  }
  for (const t of TIER_ORDER) {   // tier mode: canopy in the tier colour with the tier letter
    const s = 64, c = document.createElement("canvas");
    c.width = c.height = s;
    const ctx = c.getContext("2d");
    const bark = dark ? "#9a7f6b" : "#6d4c3a";
    ctx.fillStyle = bark;
    ctx.beginPath(); ctx.moveTo(29, 62); ctx.lineTo(31, 34); ctx.lineTo(33, 34); ctx.lineTo(35, 62); ctx.closePath(); ctx.fill();
    const blobs = [[32, 20, 13], [19, 28, 11], [45, 28, 11], [24, 14, 9], [41, 14, 9]];
    ctx.fillStyle = dark ? "#2e2a2b" : "#fffaf0";
    for (const [x, y, r] of blobs) { ctx.beginPath(); ctx.arc(x, y, r + 2.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = tierColour(t);
    for (const [x, y, r] of blobs) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = t === "S" || t === "A" ? "#ffffff" : "#2e2420";
    ctx.font = "bold 22px Inter, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(t, 32, 24);
    const id = `tier-${t}`;
    if (map.hasImage(id)) map.removeImage(id);
    map.addImage(id, ctx.getImageData(0, 0, s, s), { pixelRatio: 2 });
  }
}

function addMapLayers() {
  const treeFC = {
    type: "FeatureCollection",
    features: trees.rows.map((r) => ({ type: "Feature", geometry: { type: "Point", coordinates: [r[0], r[1]] },
      properties: { g: r[2], c: r[3], t: tierOf(r[3]), s: r[4], city: r[5], dbh: r[6], ht: r[7], addr: r[8], lon: r[0], lat: r[1] } })),
  };
  const sightFC = {
    type: "FeatureCollection",
    features: sightings.rows.map((r) => ({ type: "Feature", geometry: { type: "Point", coordinates: [r[0], r[1]] },
      properties: { g: r[2], date: r[3], photo: r[4], attr: r[5], place: r[6], taxon: r[7], id: r[8] } })),
  };
  if (!map.getSource("trees")) map.addSource("trees", { type: "geojson", data: treeFC });
  if (!map.getSource("sightings")) map.addSource("sightings", { type: "geojson", data: sightFC });
  map.addLayer({ id: "trees-glow", type: "circle", source: "trees", paint: { "circle-blur": 1, "circle-pitch-alignment": "map" } });
  map.addLayer({ id: "trees", type: "circle", source: "trees", maxzoom: 14.5 });
  map.addLayer({ id: "trees-icons", type: "symbol", source: "trees", minzoom: 14.5,
    layout: { "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-anchor": "bottom",
      "icon-size": ["interpolate", ["linear"], ["zoom"], 14.5, 0.55, 17, 0.95, 19, 1.3] } });
  map.addLayer({ id: "sightings", type: "circle", source: "sightings", layout: { visibility: "none" } });
  updateMapLayers();
}

function probExpression() {
  // per-group bloom probability for the selected date, by the tree's city (→ forecast region) and group
  const byCity = trees.cities.map((_, ci) => ["match", ["get", "g"], ...trees.groups.flatMap((g, i) => [i, bloomProb(cityRegion(ci), g, state.doy)]), 0]);
  return ["match", ["get", "city"], ...byCity.flatMap((e, ci) => [ci, e]), 0];
}

function updateMapLayers() {
  if (!map || !map.getLayer("trees")) return;
  const [r0, r1, r2, r3, , a2, surface] = themeColors();
  const P = probExpression();
  const color = ["interpolate", ["linear"], P, 0, r0, 0.25, r1, 0.6, r2, 1, r3];
  const visibleGroups = trees.groups.map((g, i) => (groupOn(g) ? i : -1)).filter((i) => i >= 0);
  const filter = ["in", ["get", "c"], ["literal", [...state.cv]]];
  for (const id of ["trees", "trees-glow", "trees-icons"]) map.setFilter(id, filter);
  const byTier = state.colourBy === "tier";
  const tierColor = ["match", ["get", "t"], ...TIER_ORDER.flatMap((t) => [t, tierColour(t)]), "#999"];
  map.setPaintProperty("trees", "circle-color", byTier ? tierColor : color);
  if (!byTier) map.setPaintProperty("trees", "circle-opacity", ["+", 0.55, ["*", 0.45, P]]);
  map.setPaintProperty("trees", "circle-stroke-width", ["interpolate", ["linear"], ["zoom"], 12.5, 0, 14, 0.8]);
  map.setPaintProperty("trees", "circle-stroke-color", surface);
  map.setLayoutProperty("trees-icons", "icon-image", byTier ? ["concat", "tier-", ["get", "t"]]
    : ["step", P, "tree-0", ...d3.range(1, ICON_LEVELS).flatMap((i) => [(i - 0.5) / (ICON_LEVELS - 1), `tree-${i}`])]);
  map.setPaintProperty("trees", "circle-radius", byTier
    ? ["interpolate", ["linear"], ["zoom"], 10, ["match", ["get", "t"], "S", 2.6, "A", 2.1, 1.5], 14, ["match", ["get", "t"], "S", 5, "A", 4.2, 3.2]]
    : ["interpolate", ["linear"], ["zoom"], 10, ["+", 0.8, ["*", 1.6, P]], 14, ["+", 1.8, ["*", 3.4, P]]]);
  if (byTier) map.setPaintProperty("trees", "circle-opacity", 0.95);
  map.setPaintProperty("trees-glow", "circle-opacity", byTier ? 0 : ["*", isDark() ? 0.3 : 0.22, P]);
  map.setPaintProperty("trees-glow", "circle-color", r2);
  map.setPaintProperty("trees-glow", "circle-radius", ["interpolate", ["linear"], ["zoom"], 10, ["*", 6, P], 14, ["*", 12, P], 17, ["*", 26, P]]);

  const showS = document.getElementById("show-sightings").checked;
  map.setLayoutProperty("sightings", "visibility", showS ? "visible" : "none");
  map.setPaintProperty("sightings", "circle-color", a2);
  map.setPaintProperty("sightings", "circle-radius", ["interpolate", ["linear"], ["zoom"], 9, 3, 15, 6]);
  map.setPaintProperty("sightings", "circle-stroke-color", surface);
  map.setPaintProperty("sightings", "circle-stroke-width", 1.5);
  map.setFilter("sightings", ["in", ["get", "g"], ["literal", visibleGroups]]);

  const empty = document.querySelector(".map-empty");
  if (!meta.regions[state.region].has_trees) {
    if (!empty) document.getElementById("map").append(el("div", { class: "map-empty" },
      "No public tree inventory is published for this area, so the blue dots are blossoms local people have photographed on iNaturalist. Hover for their photos."));
  } else empty?.remove();
}

function renderStreets() {
  const ol = document.getElementById("streets");
  const region = state.region;
  if (!meta.regions[region].has_trees) { ol.replaceChildren(el("li", { class: "empty" }, "Street rankings need a tree inventory, which is only published for Victoria, Esquimalt and Vancouver.")); return; }
  // street counts are per group, so weight each group by the share of its trees here that are selected
  const share = Object.fromEntries(GROUP_ORDER.map((g) => {
    const ks = trees.cultivars.map((k, i) => [k, i]).filter(([k]) => cultivars[k].group === g);
    const tot = d3.sum(ks, ([k]) => regionCount(k));
    return [g, tot ? d3.sum(ks, ([k, i]) => (state.cv.has(i) ? regionCount(k) : 0)) / tot : 0];
  }));
  const scored = streets.filter((s) => s.region === region).map((s) => ({
    ...s, score: d3.sum(Object.entries(s.groups), ([g, n]) => n * (share[g] || 0) * bloomProb(region, g, state.doy)),
  })).sort((a, b) => b.score - a.score).slice(0, 8);
  const max = d3.max(scored, (s) => s.score) || 1;
  ol.replaceChildren(...scored.map((s) => el("li", {}, el("button", { type: "button", onclick: () => map.flyTo({ center: [s.lon, s.lat], zoom: 16, duration: 1400 }) },
    el("span", { class: "s-name" }, s.street + (s.city === "esquimalt" ? " (Esquimalt)" : "")),
    el("span", { class: "s-val" }, `${Math.round(s.score)} in bloom`),
    el("span", { class: "s-bar" }, el("i", { style: { width: `${(100 * s.score) / max}%` } }))))));
}

// ------------------------------------------------------------------ tier list
function renderTiers() {
  const region = state.region;
  const cities = meta.regions[region].tree_cities;
  const host = document.getElementById("tiers");
  const rows = Object.entries(meta.tiers).map(([tier, blurb]) => {
    const items = Object.entries(cultivars).filter(([, c]) => c.tier === tier)
      .map(([k, c]) => ({ k, c, n: d3.sum(cities, (ct) => c.counts[ct] || 0) }))
      .sort((a, b) => (b.k === PINNED) - (a.k === PINNED) || b.n - a.n);
    return el("div", { class: `tier-row tier-row-${tier}` },
      el("div", { class: `tier-label tier-${tier}` }, el("b", {}, tier), el("span", {}, blurb)),
      el("div", { class: "tier-items" }, ...items.map(({ c, n }) => {
        const best = cities.map((ct) => c.best_street[ct]).filter(Boolean).sort((a, b) => b.n - a.n)[0];
        const absent = cities.length && !n;
        const f = forecast.regions[region].groups[c.group];
        return el("button", { type: "button", class: `cv-card${absent ? " absent" : ""}`, title: c.note, onclick: () => {
            if (!best) return;
            map.flyTo({ center: [best.lon, best.lat], zoom: 16.5, duration: 1600 });
            document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "center" });
          } },
          el("span", { class: "cv-photo", style: c.photo ? { backgroundImage: `url("${c.photo.thumb}")` } : {} },
            c.photo?.similar ? el("i", { class: "cv-similar" }, "look-alike") : null),
          el("span", { class: "cv-name" }, c.name),
          el("span", { class: "cv-meta" }, cities.length ? (n ? `${fmtInt.format(n)} on city streets` : "Not on city streets here") : c.colour),
          best ? el("span", { class: "cv-best" }, `Best: ${best.street} (${best.n})`) : null,
          f ? el("span", { class: "cv-peak" }, `Peak ~${fmtMD(new Date(f.median + "T12:00"))}`) : null);
      })));
  });
  host.replaceChildren(...rows);
  document.getElementById("tiers-sub").textContent = cities.length
    ? `Counts and best streets come from the ${cities.map((c) => meta.cities[c].name).join(" and ")} inventories. Click a card to fly to its best street.`
    : "There's no public tree inventory for this region, so the tiers show what to look out for in gardens and parks.";
}

// ------------------------------------------------------------------ charts
function renderCharts() {
  renderRibbon();
  renderCalendar();
  renderRace();
  renderHistory();
  renderScatter();
}

function svgFor(id, height, margin) {
  const host = document.getElementById(id);
  const width = Math.max(260, host.clientWidth);
  host.replaceChildren();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img");
  return { svg, width, height, iw: width - margin.l - margin.r, ih: height - margin.t - margin.b, g: svg.append("g").attr("transform", `translate(${margin.l},${margin.t})`) };
}

const monthTicks = (lo, hi) => d3.range(1, 7).map((m) => dateToDoy(new Date(meta.season, m - 1, 1))).filter((d) => d >= lo && d <= hi);

// ribbon above the slider: expected share of trees in bloom through the season
let ribbonX;
function renderRibbon() {
  const m = { l: 0, r: 0, t: 4, b: 2 };
  const { svg, g, iw, ih } = svgFor("ribbon", 34, m);
  const { curve } = expectedCurve(state.region);
  ribbonX = d3.scaleLinear([15, 151], [8, iw - 8]);
  const y = d3.scaleLinear([0, d3.max(curve, (d) => d.share) || 1], [ih, 0]);
  g.append("path").datum(curve).attr("d", d3.area().x((d) => ribbonX(d.doy)).y0(ih).y1((d) => y(d.share)).curve(d3.curveMonotoneX))
    .style("fill", "var(--accent)").style("opacity", 0.14);
  g.append("path").datum(curve).attr("d", d3.line().x((d) => ribbonX(d.doy)).y((d) => y(d.share)).curve(d3.curveMonotoneX))
    .style("fill", "none").style("stroke", "var(--accent)").style("stroke-width", 2);
  g.append("line").attr("class", "playhead").attr("y1", 0).attr("y2", ih).style("stroke", "var(--ink)").style("stroke-width", 1.5);
  svg.on("pointermove", (e) => {
    const [px] = d3.pointer(e, g.node());
    const doy = Math.round(ribbonX.invert(px));
    const d = curve.find((c) => c.doy === doy);
    if (!d) return;
    tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, fmtDoy(doy)),
      tipRow(cssVar("--accent"), `${Math.round(d.share * 100)}%`, "of trees expected in bloom")));
  }).on("pointerleave", () => tip.hide()).on("click", (e) => setDoy(ribbonX.invert(d3.pointer(e, g.node())[0])));
  svg.style("cursor", "pointer");
  renderRibbonPlayhead();
}
function renderRibbonPlayhead() {
  if (!ribbonX) return;
  d3.select("#ribbon .playhead").attr("x1", ribbonX(state.doy)).attr("x2", ribbonX(state.doy));
}

// bloom calendar: range bars per group
let calX;
function renderCalendar() {
  const narrow = document.getElementById("calendar").clientWidth < 480;
  const m = { l: narrow ? 112 : 150, r: narrow ? 8 : 16, t: 8, b: 26 };
  const rowH = 38;
  const groups = GROUP_ORDER.filter((g) => forecast.regions[state.region].groups[g]);
  const { g, iw, ih } = svgFor("calendar", m.t + m.b + rowH * groups.length, m);
  const f = forecast.regions[state.region].groups;
  calX = d3.scaleLinear([40, 150], [0, iw]);
  document.getElementById("cal-title").textContent = `Forecast peak by group · ${meta.regions[state.region].name}`;
  document.getElementById("cal-legend").replaceChildren(
    el("span", { class: "key" }, el("i", { class: "band", style: { background: "var(--accent)", opacity: 0.2 } }), "80% range"),
    el("span", { class: "key" }, el("i", { class: "band", style: { background: "var(--accent)", opacity: 0.5 } }), "50% range"),
    el("span", { class: "key" }, el("i", { class: "dot", style: { background: "var(--accent)" } }), "Forecast peak"));

  g.append("g").attr("class", "grid").selectAll("line").data(monthTicks(40, 150)).join("line")
    .attr("x1", calX).attr("x2", calX).attr("y1", 0).attr("y2", ih);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`)
    .call(d3.axisBottom(calX).tickValues(monthTicks(40, 150)).tickFormat((d) => fmtMD(doyToDate(d))).tickSize(0).tickPadding(8))
    .call((a) => a.select(".domain").remove());

  const rows = g.selectAll("g.row").data(groups).join("g").attr("class", "row").attr("transform", (_, i) => `translate(0,${i * rowH + rowH / 2})`);
  rows.append("text").attr("class", "label").attr("x", -12).attr("dy", "0.35em").attr("text-anchor", "end")
    .style("font-size", narrow ? "11px" : null)
    .text((d) => (narrow ? shortGroup(d).replace(" & Akebono", "").replace(" cherries", "") : shortGroup(d)) + (meta.groups[d].offset_from ? " †" : ""));
  const bar = (lo, hi, h, op) => rows.append("rect")
    .attr("x", (d) => calX(isoDoy(f[d][lo]))).attr("width", (d) => Math.max(2, calX(isoDoy(f[d][hi])) - calX(isoDoy(f[d][lo]))))
    .attr("y", -h / 2).attr("height", h).attr("rx", 4).style("fill", "var(--accent)").style("opacity", op);
  bar("p10", "p90", 14, 0.2);
  bar("p25", "p75", 14, 0.5);
  rows.append("circle").attr("cx", (d) => calX(isoDoy(f[d].median))).attr("r", 5.5)
    .style("fill", "var(--accent)").style("stroke", "var(--surface)").style("stroke-width", 2);
  rows.append("text").attr("class", "label strong").attr("x", (d) => Math.min(iw - 2, calX(isoDoy(f[d].p90)) + 8)).attr("dy", "0.35em")
    .attr("text-anchor", (d) => (calX(isoDoy(f[d].p90)) + 60 > iw ? "end" : "start"))
    .text((d) => fmtMD(new Date(f[d].median + "T12:00")));
  rows.append("rect").attr("x", -m.l).attr("width", iw + m.l).attr("y", -rowH / 2).attr("height", rowH).style("fill", "transparent")
    .on("pointermove", (e, d) => tip.show(e.clientX, e.clientY, (t) => {
      const md = (k) => fmtMD(new Date(f[d][k] + "T12:00"));
      t.append(el("div", { class: "t-title" }, meta.groups[d].label),
        tipRow(cssVar("--accent"), md("median"), "forecast peak"),
        tipRow(null, `${md("p25")} – ${md("p75")}`, "50% range"),
        tipRow(null, `${md("p10")} – ${md("p90")}`, "80% range"));
      if (meta.groups[d].offset_from) t.append(el("div", { class: "note", style: { marginTop: "4px" } }, `† ${meta.groups[d].offset_from[1]} days relative to Japanese cherries (horticultural bloom order)`));
    })).on("pointerleave", () => tip.hide());
  g.append("line").attr("class", "cal-playhead").attr("y1", -4).attr("y2", ih).style("stroke", "var(--ink-2)").style("stroke-width", 1);
  renderCalendarPlayhead();

  const table = el("table", { class: "data" }, el("thead", {}, el("tr", {}, ...["Group", "Peak", "50% range", "80% range"].map((h) => el("th", {}, h)))),
    el("tbody", {}, ...groups.map((d) => {
      const md = (k) => fmtMD(new Date(f[d][k] + "T12:00"));
      return el("tr", {}, el("td", {}, meta.groups[d].label), el("td", {}, md("median")), el("td", {}, `${md("p25")} – ${md("p75")}`), el("td", {}, `${md("p10")} – ${md("p90")}`));
    })));
  document.getElementById("calendar-table").replaceChildren(table,
    el("p", { class: "note", style: { marginTop: "6px" } }, "† Timing derived from Japanese cherries using the horticultural bloom order; not fitted separately."));
}
function renderCalendarPlayhead() {
  if (!calX) return;
  const x = calX(Math.max(40, Math.min(150, state.doy)));
  d3.select("#calendar .cal-playhead").attr("x1", x).attr("x2", x);
}

// race to bloom: accumulated warmth vs threshold
function renderRace() {
  const reg = forecast.regions[state.region];
  const fc = reg.forcing;
  const host = document.getElementById("race");
  if (!fc) { host.replaceChildren(el("p", { class: "note" }, "Not available for this region.")); return; }
  const m = { l: 44, r: 16, t: 12, b: 26 };
  const { svg, g, iw, ih } = svgFor("race", 300, m);
  const season = String(meta.season), last = String(meta.season - 1);
  const years = Object.keys(fc.curves).filter((y) => y !== season);
  const n = fc.curves[years[0]].length;
  const t0 = meta.model_card.japanese?.params?.t0;
  const i0 = t0 != null ? Math.max(0, t0 - 122 + 31 - 21) : 0;   // three weeks before warmth starts counting
  const stats = d3.range(i0, n).map((i) => {
    const vals = years.map((y) => fc.curves[y][i]).filter((v) => v != null).sort(d3.ascending);
    return { i, lo: d3.quantile(vals, 0.1), mid: d3.quantile(vals, 0.5), hi: d3.quantile(vals, 0.9),
      last: fc.curves[last]?.[i], cur: fc.curves[season]?.[i] };
  });
  const x = d3.scaleLinear([i0, n - 1], [0, iw]);
  const ymax = Math.max(fc.threshold * 1.35, d3.max(stats, (d) => d.hi) || 0);
  const y = d3.scaleLinear([0, ymax], [ih, 0]).nice();
  const startDate = new Date(meta.season - 1, 11, 1);
  const idxDate = (i) => d3.timeDay.offset(startDate, i);
  const ticks = d3.range(i0, n).filter((i) => idxDate(i).getDate() === 1);

  g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(5)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickSize(0).tickPadding(8)).call((a) => a.select(".domain").remove());
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`)
    .call(d3.axisBottom(x).tickValues(ticks).tickFormat((i) => d3.timeFormat("%b")(idxDate(i))).tickSize(0).tickPadding(8)).call((a) => a.select(".domain").remove());

  g.append("path").datum(stats.filter((d) => d.lo != null)).attr("d", d3.area().x((d) => x(d.i)).y0((d) => y(d.lo)).y1((d) => y(d.hi)))
    .style("fill", "var(--ink-2)").style("opacity", 0.1);
  const line = (key) => d3.line().defined((d) => d[key] != null).x((d) => x(d.i)).y((d) => y(d[key]));
  g.append("path").datum(stats).attr("d", line("mid")).style("fill", "none").style("stroke", "var(--muted)").style("stroke-width", 1.5);
  g.append("path").datum(stats).attr("d", line("last")).style("fill", "none").style("stroke", "var(--accent-2)").style("stroke-width", 2);
  const hasCur = stats.some((d) => d.cur != null && d.cur > 0);
  if (hasCur) g.append("path").datum(stats).attr("d", line("cur")).style("fill", "none").style("stroke", "var(--accent)").style("stroke-width", 2.5);

  g.append("line").attr("x1", 0).attr("x2", iw).attr("y1", y(fc.threshold)).attr("y2", y(fc.threshold)).style("stroke", "var(--ink)").style("stroke-width", 1);
  g.append("text").attr("class", "label").attr("x", iw).attr("y", y(fc.threshold) - 6).attr("text-anchor", "end").text(`Japanese cherries open ≈ ${Math.round(fc.threshold)} degree-days`);
  const cross = stats.find((d) => d.last != null && d.last >= fc.threshold);
  if (cross) {
    g.append("circle").attr("cx", x(cross.i)).attr("cy", y(fc.threshold)).attr("r", 5).style("fill", "var(--accent-2)").style("stroke", "var(--surface)").style("stroke-width", 2);
    g.append("text").attr("class", "label").attr("x", x(cross.i) + 8).attr("y", y(fc.threshold) + 16).text(`${last}: ${fmtMD(idxDate(cross.i))}`);
  }
  document.getElementById("race-legend").replaceChildren(
    el("span", { class: "key" }, el("i", { class: "band", style: { background: "var(--ink-2)", opacity: 0.18 } }), "Typical range (30 springs)"),
    el("span", { class: "key" }, el("i", { class: "line", style: { background: "var(--muted)" } }), "Median spring"),
    el("span", { class: "key" }, el("i", { class: "line", style: { background: "var(--accent-2)" } }), `Spring ${last}`),
    ...(hasCur ? [el("span", { class: "key" }, el("i", { class: "line", style: { background: "var(--accent)" } }), `Spring ${season} so far`)] : []));
  const t0Date = t0 != null ? fmtMD(d3.timeDay.offset(new Date(meta.season, 0, 1), t0 - 122)) : null;
  document.getElementById("race-sub").textContent =
    `Degree-days above ${fc.tb} °C${t0Date ? ` counted from ${t0Date}` : ""}. Blossoms open when the line crosses the threshold.` +
    (hasCur ? "" : ` The ${season} line appears once this season's count begins.`);

  const cross_ = g.append("line").attr("y1", 0).attr("y2", ih).style("stroke", "var(--axis)").style("opacity", 0);
  svg.on("pointermove", (e) => {
    const [px] = d3.pointer(e, g.node());
    const i = Math.max(i0, Math.min(n - 1, Math.round(x.invert(px))));
    const d = stats[i - i0];
    cross_.attr("x1", x(i)).attr("x2", x(i)).style("opacity", 1);
    tip.show(e.clientX, e.clientY, (t) => {
      t.append(el("div", { class: "t-title" }, fmtMD(idxDate(i))));
      if (d.cur != null) t.append(tipRow(cssVar("--accent"), Math.round(d.cur), `${season} so far`));
      if (d.last != null) t.append(tipRow(cssVar("--accent-2"), Math.round(d.last), last));
      if (d.mid != null) t.append(tipRow(cssVar("--muted"), Math.round(d.mid), "median spring"));
      if (d.lo != null) t.append(tipRow(null, `${Math.round(d.lo)}–${Math.round(d.hi)}`, "typical range"));
    });
  }).on("pointerleave", () => { cross_.style("opacity", 0); tip.hide(); });
}

// history: modelled bloom for every year, rolling mean, iNaturalist observations
function renderHistory() {
  const hist = history[state.region];
  const g0 = state.historyGroup;
  const series = (hist.model[g0] || []).map(([year, doy]) => ({ year, doy }));
  const obs = (hist.observed[g0] || []).map(([year, doy, q25, q75, n]) => ({ year, doy, q25, q75, n }));
  const m = { l: 52, r: 16, t: 12, b: 26 };
  const { svg, g, iw, ih } = svgFor("history", 340, m);
  if (!series.length) { g.append("text").attr("class", "label").text("No modelled history for this group."); return; }
  const roll = series.map((d, i) => {
    const w = series.filter((s) => Math.abs(s.year - d.year) <= 7);
    return { year: d.year, doy: w.length >= 10 ? d3.mean(w, (s) => s.doy) : null };
  });
  const x = d3.scaleLinear(d3.extent(series, (d) => d.year), [0, iw]);
  const all = series.map((d) => d.doy).concat(obs.flatMap((d) => [d.q25, d.q75]));
  const y = d3.scaleLinear([d3.min(all) - 4, d3.max(all) + 4], [ih, 0]);
  const yt = d3.range(1, 7).map((mo) => dateToDoy(new Date(2001, mo - 1, 1))).concat(d3.range(1, 7).map((mo) => dateToDoy(new Date(2001, mo - 1, 15))))
    .filter((d) => d > y.domain()[0] && d < y.domain()[1]).sort(d3.ascending);
  g.append("g").attr("class", "grid").selectAll("line").data(yt).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickValues(yt).tickFormat((d) => fmtMD(doyToDate(d, 2001))).tickSize(0).tickPadding(8)).call((a) => a.select(".domain").remove());
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(8).tickFormat(d3.format("d")).tickSize(0).tickPadding(8)).call((a) => a.select(".domain").remove());

  g.append("path").datum(series).attr("d", d3.line().x((d) => x(d.year)).y((d) => y(d.doy)))
    .style("fill", "none").style("stroke", "var(--accent)").style("stroke-width", 1.25).style("opacity", 0.35);
  g.append("path").datum(roll).attr("d", d3.line().defined((d) => d.doy != null).x((d) => x(d.year)).y((d) => y(d.doy)).curve(d3.curveMonotoneX))
    .style("fill", "none").style("stroke", "var(--accent)").style("stroke-width", 2.5);
  const og = g.append("g");
  og.selectAll("line").data(obs).join("line").attr("x1", (d) => x(d.year)).attr("x2", (d) => x(d.year)).attr("y1", (d) => y(d.q25)).attr("y2", (d) => y(d.q75))
    .style("stroke", "var(--accent-2)").style("stroke-width", 1.5);
  og.selectAll("circle").data(obs).join("circle").attr("cx", (d) => x(d.year)).attr("cy", (d) => y(d.doy)).attr("r", 4.5)
    .style("fill", "var(--accent-2)").style("stroke", "var(--surface)").style("stroke-width", 2);

  document.getElementById("history-legend").replaceChildren(
    el("span", { class: "key" }, el("i", { class: "line", style: { background: "var(--accent)", opacity: 0.4 } }), "Modelled peak, each year"),
    el("span", { class: "key" }, el("i", { class: "line", style: { background: "var(--accent)" } }), "15-year average"),
    el("span", { class: "key" }, el("i", { class: "dot", style: { background: "var(--accent-2)" } }), "Observed on iNaturalist (median, middle 50%)"));
  const tr = hist.trends[g0] || {};
  const name = meta.regions[state.region].name;
  document.getElementById("history-note").textContent =
    `${shortGroup(g0)} in ${name}, modelled from ${hist.station} temperatures. ` +
    (tr.shift_1951_80_vs_recent30 != null ? `The last 30 springs average ${Math.abs(tr.shift_1951_80_vs_recent30).toFixed(0)} days ${tr.shift_1951_80_vs_recent30 < 0 ? "earlier" : "later"} than 1951–80. ` : "") +
    (tr.since_1950 != null ? `Linear trend since 1950: ${tr.since_1950 > 0 ? "+" : ""}${tr.since_1950.toFixed(1)} days per decade.` : "");

  const ch = g.append("line").attr("y1", 0).attr("y2", ih).style("stroke", "var(--axis)").style("opacity", 0);
  svg.on("pointermove", (e) => {
    const [px] = d3.pointer(e, g.node());
    const yr = Math.round(x.invert(px));
    const s = series.find((d) => d.year === yr);
    if (!s) return;
    const r = roll.find((d) => d.year === yr);
    const o = obs.find((d) => d.year === yr);
    ch.attr("x1", x(yr)).attr("x2", x(yr)).style("opacity", 1);
    tip.show(e.clientX, e.clientY, (t) => {
      t.append(el("div", { class: "t-title" }, `Spring ${yr}`), tipRow(cssVar("--accent"), fmtMD(doyToDate(s.doy, 2001)), "modelled peak"));
      if (r?.doy) t.append(tipRow(cssVar("--accent"), fmtMD(doyToDate(r.doy, 2001)), "15-year average"));
      if (o) t.append(tipRow(cssVar("--accent-2"), fmtMD(doyToDate(o.doy, 2001)), `observed (${o.n} sightings)`));
    });
  }).on("pointerleave", () => { ch.style("opacity", 0); tip.hide(); });
}

// predicted vs observed scatter (cross-validated)
function renderScatter() {
  const card = meta.model_card[state.scatterGroup];
  const pts = card.cv.filter((d) => d.pred != null);
  const m = { l: 52, r: 16, t: 12, b: 34 };
  const host = document.getElementById("scatter");
  const w = Math.max(260, host.clientWidth);
  const { svg, g, iw, ih } = svgFor("scatter", Math.min(380, w * 0.8), m);
  const ext = d3.extent(pts.flatMap((d) => [d.obs, d.pred]));
  const dom = [ext[0] - 4, ext[1] + 4];
  const x = d3.scaleLinear(dom, [0, iw]), y = d3.scaleLinear(dom, [ih, 0]);
  const ticks = x.ticks(5);
  g.append("g").attr("class", "grid").selectAll("line").data(ticks).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickFormat((d) => fmtMD(doyToDate(d, 2001))).tickSize(0).tickPadding(8)).call((a) => a.select(".domain").remove());
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(5).tickFormat((d) => fmtMD(doyToDate(d, 2001))).tickSize(0).tickPadding(8)).call((a) => a.select(".domain").remove());
  g.append("line").attr("x1", x(dom[0])).attr("y1", y(dom[0])).attr("x2", x(dom[1])).attr("y2", y(dom[1])).style("stroke", "var(--axis)").style("stroke-width", 1);
  g.append("text").attr("class", "label").attr("x", x(dom[1]) - 4).attr("y", y(dom[1]) + 14).attr("text-anchor", "end").text("perfect forecast");
  g.append("text").attr("class", "label").attr("x", iw / 2).attr("y", ih + 30).attr("text-anchor", "middle").text("Observed");
  g.selectAll("circle.pt").data(pts).join("circle").attr("class", "pt").attr("cx", (d) => x(d.obs)).attr("cy", (d) => y(d.pred)).attr("r", 5)
    .style("fill", "var(--accent)").style("stroke", "var(--surface)").style("stroke-width", 2);
  g.selectAll("circle.hit").data(pts).join("circle").attr("class", "hit").attr("cx", (d) => x(d.obs)).attr("cy", (d) => y(d.pred)).attr("r", 12).style("fill", "transparent")
    .on("pointermove", (e, d) => tip.show(e.clientX, e.clientY, (t) => t.append(
      el("div", { class: "t-title" }, `${meta.regions[d.region].name} · ${d.year}`),
      tipRow(null, fmtMD(doyToDate(d.obs, 2001)), "observed"),
      tipRow(cssVar("--accent"), fmtMD(doyToDate(d.pred, 2001)), "predicted"),
      tipRow(null, `${d.err > 0 ? "+" : ""}${d.err.toFixed(1)} d`, "error"))))
    .on("pointerleave", () => tip.hide());
  svg.attr("aria-label", `Predicted versus observed bloom dates for ${shortGroup(state.scatterGroup)}`);
}

// ------------------------------------------------------------------ model card
function renderModelCard() {
  const card = meta.model_card;
  const groups = GROUP_ORDER.filter((g) => card[g]);
  const kinds = ["clim", "gdd", "chill", "tsens", "borrowed"];
  const cell = (g, k) => {
    const s = k === "borrowed" ? Object.entries(card[g].scores).filter(([kk]) => kk.startsWith("borrowed")).sort((a, b) => a[1].mae - b[1].mae)[0]?.[1] : card[g].scores[k];
    const chosen = card[g].chosen.split(":")[0] === k;
    return el("td", { class: "num", style: chosen ? { background: "var(--accent-wash)", fontWeight: 650 } : {} }, s?.mae != null ? s.mae.toFixed(1) : "—");
  };
  const table = el("table", { class: "data" },
    el("thead", {}, el("tr", {}, el("th", {}, "Group"), ...kinds.map((k) => el("th", { class: "num" }, KIND_LABEL[k])), el("th", { class: "num" }, "Skill"), el("th", { class: "num" }, "Years"))),
    el("tbody", {}, ...groups.map((g) => el("tr", {}, el("td", {}, shortGroup(g)), ...kinds.map((k) => cell(g, k)),
      el("td", { class: "num" }, card[g].skill_vs_clim != null ? `${card[g].skill_vs_clim > 0 ? "+" : ""}${card[g].skill_vs_clim.toFixed(0)}%` : "—"),
      el("td", { class: "num" }, String(card[g].n_obs))))));
  document.getElementById("cv-table").replaceChildren(table,
    el("p", { class: "note", style: { marginTop: "8px" } }, "Skill is the reduction in error compared with climatology. Years counts region-years with enough observations to measure a bloom date."));

  // backtest small multiples
  const wrap = document.getElementById("backtest");
  wrap.replaceChildren();
  for (const g of groups) {
    const s = backtest[g]?.summary || [];
    const box = el("div", { class: "bt-card" }, el("div", { class: "bt-title" }, shortGroup(g)),
      el("div", { class: "bt-sub" }, `${KIND_LABEL[card[g].chosen.split(":")[0]]}${card[g].borrowed_from ? ` (from ${shortGroup(card[g].borrowed_from).toLowerCase()})` : ""}`),
      el("div", { class: "chart", id: `bt-${g}` }));
    wrap.append(box);
    requestAnimationFrame(() => {
      const m = { l: 4, r: 4, t: 18, b: 34 };
      const { g: gg, iw, ih } = svgFor(`bt-${g}`, 150, m);
      const x = d3.scaleBand(s.map((d) => d.issue), [0, iw]).padding(0.35);
      const y = d3.scaleLinear([0, Math.max(10, d3.max(s, (d) => d.mae))], [ih, 0]);
      const bw = Math.min(24, x.bandwidth());
      gg.append("line").attr("x1", 0).attr("x2", iw).attr("y1", ih).attr("y2", ih).style("stroke", "var(--axis)");
      const bars = gg.selectAll("g.b").data(s).join("g").attr("class", "b").attr("transform", (d) => `translate(${x(d.issue) + (x.bandwidth() - bw) / 2},0)`);
      bars.append("path").attr("d", (d) => {
        const h = ih - y(d.mae), r = Math.min(4, h);
        return `M0,${ih}V${ih - h + r}Q0,${ih - h} ${r},${ih - h}H${bw - r}Q${bw},${ih - h} ${bw},${ih - h + r}V${ih}Z`;
      }).style("fill", "var(--accent)");
      bars.append("text").attr("class", "label strong").attr("x", bw / 2).attr("y", (d) => y(d.mae) - 5).attr("text-anchor", "middle").style("font-size", "11px").text((d) => d.mae.toFixed(1));
      bars.append("text").attr("class", "label").attr("x", bw / 2).attr("y", ih + 14).attr("text-anchor", "middle").style("font-size", "10.5px")
        .text((d) => d3.timeFormat("%b %-d")(new Date(`2001-${d.issue}T12:00`)));
      bars.append("text").attr("class", "label").attr("x", bw / 2).attr("y", ih + 28).attr("text-anchor", "middle").style("font-size", "10.5px").style("fill", "var(--muted)")
        .text((d) => `${Math.round(d.coverage * 100)}%`);
    });
  }

  const j = card.japanese, w = card.wild;
  const lims = [
    "The observed bloom date is a citizen-science proxy. Observer effort varies by year, weekday and weather, so even a perfect model would miss by a few days.",
    j ? `Japanese cherries mix early and late cultivars, so their iNaturalist signal is too noisy to fit a temperature response on its own: cross-validated error is ${j.scores[j.chosen].mae.toFixed(1)} days against ${j.scores.clim.mae.toFixed(1)} for climatology. The forecast borrows the ${shortGroup(j.borrowed_from).toLowerCase()} response so it still reacts to a warm or cold spring. Treat those dates as ±10 days.` : null,
    w && w.chosen === "clim" ? `For wild cherry, no weather model beat climatology (${w.scores.clim.mae.toFixed(1)} days), so its forecast is the long-run average plus uncertainty.` : null,
    `Early cherries and Yoshino/Akebono are shifted ${Math.abs(meta.groups.early.offset_from[1])} and ${Math.abs(meta.groups.yoshino.offset_from[1])} days ahead of Japanese cherries, following the usual bloom order. These offsets are an assumption, not fitted.`,
    "Only Victoria, Esquimalt and Vancouver publish city tree inventories. I checked Saanich, Oak Bay, Langford, Colwood, View Royal, Nanaimo, North Cowichan, Courtenay and Campbell River and found no public inventory, and OpenStreetMap has only a handful of mapped cherries on the Island. Those areas show iNaturalist sightings instead.",
    "Temperatures come from one station per region. Urban heat and shelter can shift individual streets by several days.",
  ].filter(Boolean);
  document.getElementById("limitations").replaceChildren(...lims.map((t) => el("li", {}, t)));
}
