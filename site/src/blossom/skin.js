// "Sakura.exe" skin extras: a Win95 taskbar with a start menu and a Victoria-time clock, Japanese section
// labels, a vaporwave horizon with drifting pixel petals in the hero, and a footer flavour line.
// Everything is built only while the skin is active and removed when it is switched off.
import { el } from "../shared/ui.js";

const root = document.documentElement;
const active = () => root.dataset.skin === "alt";
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Japanese accent labels beside the English section headings: [anchor inside the section, label, romaji/gloss]
const LABELS = [
  ["#map", "花見マップ", "hanami map"],
  ["#tiers", "品種", "cultivars"],
  ["#calendar", "桜前線", "sakura zensen"],
  ["#history", "百年の春", "100 springs"],
  ["#cv-table", "精度", "accuracy"],
];
// Taskbar "open windows" and start-menu entries
const WINDOWS = [
  { key: "map", label: "Map", anchor: "#map" },
  { key: "forecast", label: "Forecast", anchor: "#calendar" },
  { key: "tiers", label: "Tier list", anchor: "#tiers" },
  { key: "sightings", label: "Sightings", anchor: "#map", sightings: true },
];
const MENU = [
  { label: "Map", jp: "地図", anchor: "#map" },
  { label: "Tier list", jp: "品種", anchor: "#tiers" },
  { label: "Forecast", jp: "桜前線", anchor: "#calendar" },
  { label: "History", jp: "歴史", anchor: "#history" },
  { label: "Model card", jp: "精度", anchor: "#cv-table" },
  { label: "Sightings", jp: "目撃", anchor: "#map", sightings: true },
];

const sectionOf = (sel) => document.querySelector(sel)?.closest("section");
const clockFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Vancouver", hour: "numeric", minute: "2-digit" });

function openWindow(item) {
  if (item.sightings) {
    const cb = document.getElementById("show-sightings");
    if (cb && !cb.checked) cb.click();   // fires the page's own change handler
  }
  const target = item.sightings ? document.querySelector(".map-shell") : sectionOf(item.anchor);
  target?.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: item.sightings ? "center" : "start" });
}

function build() {
  const added = [];
  const add = (node, parent, before = null) => { parent.insertBefore(node, before); added.push(node); return node; };

  // --- Japanese labels
  const eyebrow = document.getElementById("season-label");
  if (eyebrow) add(el("span", { class: "sk-jp sk-jp-hero", "aria-hidden": "true", title: "kaika yosō: bloom forecast" }, "開花予想"), eyebrow.parentNode, eyebrow.nextSibling);
  for (const [anchor, jp, gloss] of LABELS) {
    const h2 = sectionOf(anchor)?.querySelector(".section-head h2");
    if (h2) add(el("span", { class: "sk-jp", "aria-hidden": "true" }, jp, el("small", {}, gloss)), h2);
  }

  // --- hero horizon: striped sun, perspective floor grid, drifting petals
  const hero = document.querySelector(".hero");
  if (hero) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 1000 100");
    svg.setAttribute("preserveAspectRatio", "none");
    const line = (x1, y1, x2, y2) => { const l = document.createElementNS(NS, "line"); Object.entries({ x1, y1, x2, y2 }).forEach(([k, v]) => l.setAttribute(k, v)); svg.append(l); };
    for (let k = -16; k <= 16; k++) line(680 + k * 6, 0, 680 + k * 95, 100);           // rays to the vanishing point under the sun
    for (let j = 1; j <= 7; j++) { const y = 100 * (j / 7) ** 1.9; line(0, y, 1000, y); } // rungs, closer together toward the horizon
    add(el("div", { class: "sk-horizon", "aria-hidden": "true" }, el("div", { class: "sk-sun" }), el("div", { class: "sk-floor" }, svg)), hero);
    if (!reduced()) {
      const petals = el("div", { class: "sk-petals", "aria-hidden": "true" });
      const spec = [[6, 8, 21, -2], [18, 6, 26, -14], [33, 10, 19, -7], [52, 6, 24, -19], [64, 8, 22, -4], [79, 10, 20, -11], [91, 6, 27, -22]];
      for (const [x, s, d, delay] of spec) {
        const p = el("i");
        Object.entries({ "--x": `${x}%`, "--s": `${s}px`, "--d": `${d}s`, "--delay": `${delay}s` }).forEach(([k, v]) => p.style.setProperty(k, v));
        petals.append(p);
      }
      add(petals, hero, hero.firstChild);
    }
  }

  // --- footer flavour line
  const foot = document.querySelector("footer.site .wrap");
  if (foot) add(el("p", { class: "sk-flavour", "aria-hidden": "true" }, "It is now safe to go outside and look at the trees."), foot);

  // --- taskbar
  const menuId = "sk-start-menu";
  const menu = el("div", { class: "sk-menu", id: menuId, role: "menu", hidden: true, "aria-label": "Start menu" },
    el("div", { class: "sk-menu-strip", "aria-hidden": "true" }, el("span", {}, el("b", {}, "Sakura"), "95")),
    el("ul", { role: "none" },
      ...MENU.map((m) => el("li", { role: "none" }, el("button", { type: "button", role: "menuitem", onclick: () => { closeMenu(); openWindow(m); } },
        el("i", { class: "sk-mi", "aria-hidden": "true" }), m.label, el("small", { "aria-hidden": "true" }, m.jp)))),
      el("li", { role: "none" }, el("hr", {})),
      el("li", { role: "none" }, el("button", { type: "button", role: "menuitem", onclick: () => { closeMenu(); document.getElementById("theme")?.click(); } },
        el("i", { class: "sk-mi", "aria-hidden": "true" }), el("span", { class: "sk-theme-label" }, "After hours"))),
      el("li", { role: "none" }, el("button", { type: "button", role: "menuitem", onclick: () => { closeMenu(); document.getElementById("skin")?.click(); } },
        el("i", { class: "sk-mi", "aria-hidden": "true" }), "Shut down…", el("small", { "aria-hidden": "true" }, "classic")))));
  const start = el("button", { type: "button", class: "sk-start", "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": menuId },
    el("i", { class: "sk-flower", "aria-hidden": "true" }), el("span", { lang: "ja" }, "スタート"));
  const tasks = WINDOWS.map((w) => el("button", { type: "button", "data-key": w.key, onclick: () => openWindow(w) }, el("i", { class: "sk-ico", "aria-hidden": "true" }), w.label));
  const peak = el("span", { class: "sk-peak", title: "Forecast peak bloom" }, el("i", { "aria-hidden": "true" }), "満開 —");
  const clock = el("time", { class: "sk-clock", title: "Victoria time (America/Vancouver)" }, "");
  const bar = el("nav", { class: "sk-taskbar", "aria-label": "Taskbar" },
    start, el("span", { class: "sk-sep", "aria-hidden": "true" }), el("div", { class: "sk-tasks" }, ...tasks), el("div", { class: "sk-tray" }, peak, clock));
  add(bar, document.body);
  add(menu, document.body);

  function openMenu() {
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    menu.querySelector(".sk-theme-label").textContent = dark ? "Desktop (day)" : "After hours (night)";
    menu.hidden = false; start.setAttribute("aria-expanded", "true");
    menu.querySelector("button")?.focus({ preventScroll: true });
  }
  function closeMenu() { menu.hidden = true; start.setAttribute("aria-expanded", "false"); }
  start.addEventListener("click", (e) => { e.stopPropagation(); menu.hidden ? openMenu() : closeMenu(); });
  const onDocClick = (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); };
  const onKey = (e) => {
    if (menu.hidden) return;
    if (e.key === "Escape") { closeMenu(); start.focus(); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const items = [...menu.querySelectorAll("button")];
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
      e.preventDefault();
    }
  };
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);

  // tray: Victoria clock + the hero's peak date (already rendered by the page)
  const tick = () => {
    clock.textContent = clockFmt.format(new Date());
    const d = document.getElementById("hero-date")?.textContent;
    if (d && d !== "—") peak.lastChild.textContent = `満開 ${d}`;
  };
  tick();
  const timer = setInterval(tick, 10000);
  const heroDate = document.getElementById("hero-date");
  const mo = new MutationObserver(tick);
  if (heroDate) mo.observe(heroDate, { childList: true, characterData: true, subtree: true });

  // highlight the "window" whose section is on screen
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const key = WINDOWS.find((w) => !w.sightings && sectionOf(w.anchor) === e.target)?.key;
      tasks.forEach((b) => b.setAttribute("aria-current", String(b.dataset.key === key)));
    }
  }, { rootMargin: "-45% 0px -50% 0px" });
  const watched = [...new Set(WINDOWS.map((w) => sectionOf(w.anchor)).filter(Boolean))];
  watched.forEach((s) => io.observe(s));

  return () => {
    clearInterval(timer);
    mo.disconnect();
    io.disconnect();
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
    added.forEach((n) => n.remove());
  };
}

let teardown = null;
function sync() {
  if (active() && !teardown) teardown = build();
  else if (!active() && teardown) { teardown(); teardown = null; }
}
window.addEventListener("skinchange", sync);
sync();
