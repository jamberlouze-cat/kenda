import { supabase } from "./lib/supabase.js";
import { isConfigured, SUPABASE_URL } from "./lib/config.js";
import { queue, snapshot, babyMemory, nameMemory, applyQueue } from "./lib/store.js";
import {
  fromUnit, formatAmount, startOfDay, addDays, dayKey, sortDesc,
  totalToday, totalLast24h, lastFeed, formatElapsed,
  groupByDay, dailySeries, comparePeriods, compareToday,
  findPatterns, hourHistogram,
} from "./lib/stats.js";

const VERSION = "1.0.0";
const DAY = 86400000;
const HISTORY_DAYS = 31;          // 2 semaines + les 2 d'avant, pour la comparaison
const KINDS = { maternel: "Lait maternel", formule: "Formule" };
const KIND_SHORT = { maternel: "Maternel", formule: "Formule" };
const CAREGIVER_COLORS = ["#6B5A85", "#3E6B7A", "#8A6D4B", "#5F7F5A", "#9A5F72", "#7A7468"];
const REMIND_CHOICES = [null, 120, 150, 180, 210, 240, 300];

// ------------------------------------------------------------------ state ---
const state = {
  view: "loading",      // loading | config | auth | newPassword | onboard | error | app
  tab: "home",          // home | history | settings
  user: null,
  babies: [], caregivers: [], feeds: [],   // feeds : tous mes bébés, file d'attente appliquée
  babyId: null,
  online: navigator.onLine,
  offlineData: false,   // l'écran montre la dernière synchro, pas encore rafraîchie
  syncedAt: null,
  pending: queue.size(),
  listOpen: true,       // accueil : derniers boires dépliés
  range: "day",         // day | week | 2weeks
  metric: "total",      // total | count | interval
  sheet: null,
  authError: "", recovery: false, error: "",
  channel: null,
};

const app = document.getElementById("app");
const $ = (sel) => document.querySelector(sel);

// ------------------------------------------------------------------ utils ---
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

function toast(msg, { kind = "", ms = 2400 } = {}) {
  let t = $(".toast");
  if (!t) { t = document.createElement("div"); document.body.appendChild(t); }
  t.className = `toast ${kind}`;
  t.innerHTML = (kind === "ok" ? icon("check") : "") + `<span>${esc(msg)}</span>`;
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(t._to);
  t._to = setTimeout(() => t.classList.remove("show"), ms);
}

const fr = (d, opts) => new Intl.DateTimeFormat("fr-CA", opts).format(d);
const fmtTime = (d) => fr(new Date(d), { hour: "numeric", minute: "2-digit" });
function dayLabel(d, now = new Date()) {
  const key = dayKey(d);
  if (key === dayKey(now)) return "Aujourd'hui";
  if (key === dayKey(addDays(now, -1))) return "Hier";
  return fr(new Date(d), { weekday: "long", day: "numeric", month: "short" });
}
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Icônes outline (trait fin), dessinées ici pour ne dépendre d'aucun CDN hors ligne.
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v9h12v-9"/>',
  chart: '<path d="M4 20h16M7 20v-7M12 20V6M17 20V10"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  up2: '<path d="M6 15l6-6 6 6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  backspace: '<path d="M9 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-6-6z"/><path d="M13 10l4 4M17 10l-4 4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  share: '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  cloudOff: '<path d="M3 3l18 18"/><path d="M9.5 6.2A6 6 0 0 1 18 11a4 4 0 0 1 2.6 6.4M17 18H7a4 4 0 0 1-.9-7.9"/>',
  cloudUp: '<path d="M7 18a4 4 0 0 1-.9-7.9A6 6 0 0 1 18 11a4 4 0 0 1 0 7"/><path d="M12 20v-8M9 15l3-3 3 3"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  bottle: '<path d="M10.5 5.5c0-2 .5-3 1.5-3s1.5 1 1.5 3"/><rect x="8" y="5.5" width="8" height="3" rx="1"/><path d="M9 8.5V19a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V8.5"/><path d="M9 13h2.5M9 16.5h2.5"/>',
  baby: '<circle cx="12" cy="13" r="8"/><path d="M9.5 12.5v.01M14.5 12.5v.01"/><path d="M10 16c1.2 1 2.8 1 4 0"/><path d="M12 5c0-1.6 1.6-2.2 2.6-1.2"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14.5c2.5 0 4 2 4 5"/>',
  logout: '<path d="M14 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2"/><path d="M9 12h12M18 9l3 3-3 3"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  downArrow: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  equal: '<path d="M6 9h12M6 15h12"/>',
};
function icon(name) {
  return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}

// ---------------------------------------------------------------- sélecteurs ---
const currentBaby = () => state.babies.find((b) => b.id === state.babyId) || null;
const babyFeeds = () => state.feeds.filter((f) => f.baby_id === state.babyId);
const unit = () => currentBaby()?.unit || "ml";
const amount = (ml) => `${formatAmount(ml, unit())} ${unit()}`;
const me = (babyId = state.babyId) => state.caregivers.find((c) => c.baby_id === babyId && c.user_id === state.user?.id) || null;
const caregiver = (id) => state.caregivers.find((c) => c.id === id) || null;
function enabledKinds() {
  const k = (currentBaby()?.kinds || []).filter((x) => KINDS[x]);
  return k.length ? k : ["maternel", "formule"];
}
/** Photo du bébé si elle existe, sinon l'icône. (La photo est une petite image « data: » gardée avec le bébé.) */
const babyFace = (b) => (b?.photo && /^data:image\//.test(b.photo) ? `<img src="${esc(b.photo)}" alt="">` : icon("baby"));
const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;

// ================================================================== RENDU ===
function render(view) {
  // Changement d'écran : ranger le clavier et repartir du haut. Sur iOS, le
  // clavier de l'écran précédent laisse sinon la page décalée (en-tête coupé).
  if (view && view !== state.view) { document.activeElement?.blur?.(); resetScroll(); }
  if (view) state.view = view;
  const v = state.view;
  if (v === "loading") app.innerHTML = `<div class="loading-screen"><div class="spinner"></div></div>`;
  else if (v === "config") app.innerHTML = viewConfig();
  else if (v === "auth") app.innerHTML = viewAuth();
  else if (v === "newPassword") app.innerHTML = viewNewPassword();
  else if (v === "onboard") app.innerHTML = viewOnboard();
  else if (v === "error") app.innerHTML = viewError();
  else renderApp();
}

function resetScroll() {
  window.scrollTo(0, 0);
  setTimeout(() => { if (!state.sheet) window.scrollTo(0, window.scrollY > 0 && document.documentElement.scrollHeight <= window.innerHeight + 1 ? 0 : window.scrollY); }, 350);
}
// Le clavier se referme : si la page n'a rien à faire défiler, iOS peut la
// laisser décalée quand même. On la remet en place.
document.addEventListener("focusout", () => setTimeout(() => {
  if (state.sheet || document.activeElement?.matches?.("input, select, textarea")) return;
  if (document.documentElement.scrollHeight <= window.innerHeight + 1) window.scrollTo(0, 0);
}, 300));

/** Coquille de l'app : en-tête, bandeau réseau, contenu, bouton +, barre du bas. */
function renderApp() {
  const baby = currentBaby();
  if (!baby) { app.innerHTML = viewOnboard(); return; }
  const many = state.babies.length > 1;
  app.innerHTML = `
    <div class="screen">
      <header class="header">
        <button class="baby-btn" data-action="open-babies" aria-label="Changer de bébé">
          <span class="baby-icon">${babyFace(baby)}</span>
          <span class="baby-id">
            <span class="baby-line"><span class="baby-name">${esc(baby.name)}</span>${many ? `<span class="baby-chev">${icon("down")}</span>` : ""}</span>
            <span class="meta" id="today-label"></span>
          </span>
        </button>
        <div class="totals" id="totals"></div>
      </header>
      <div id="net-banner" class="net-banner" hidden></div>
      <main id="main"></main>
    </div>
    <nav class="nav">
      ${navBtn("home", "home", "Accueil")}
      ${navBtn("history", "chart", "Historique")}
      ${navBtn("settings", "settings", "Paramètres")}
    </nav>`;
  renderMain();
  renderBanner();
}
const navBtn = (tab, ic, label) =>
  `<button class="${state.tab === tab ? "on" : ""}" data-action="tab" data-tab="${tab}">${icon(ic)}<span>${label}</span></button>`;

/** Les deux totaux, discrets, en haut à droite : visibles sur tous les onglets. */
function renderTotals() {
  const el = document.getElementById("totals");
  if (!el) return;
  const now = new Date(), feeds = babyFeeds(), u = unit();
  el.innerHTML = `
    <span class="total"><span class="total-label">Aujourd'hui</span><b>${formatAmount(totalToday(feeds, now), u)}</b><small>${u}</small></span>
    <span class="total"><span class="total-label">Dernières 24 h</span><b>${formatAmount(totalLast24h(feeds, now), u)}</b><small>${u}</small></span>`;
  const label = document.getElementById("today-label");
  if (label) label.textContent = fr(now, { weekday: "short", day: "numeric", month: "short" });
}

/** Ne redessine que le contenu : appelé à chaque changement de données et à
 *  chaque tic d'horloge (les compteurs glissants vieillissent tout seuls). */
function renderMain() {
  const main = document.getElementById("main");
  if (state.view !== "app" || !main) return;
  renderTotals();
  // Ne pas écraser un champ des paramètres pendant qu'on y écrit.
  if (state.tab === "settings" && main.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
  main.innerHTML = state.tab === "history" ? viewHistory() : state.tab === "settings" ? viewSettings() : viewHome();
}

// ------------------------------------------------------------------ accueil ---
/** Une ligne de boire : heure + type, puis une barre proportionnelle à la quantité. */
function feedRow(f, max) {
  const who = caregiver(f.caregiver_id);
  const showKind = enabledKinds().length > 1 || f.kind !== enabledKinds()[0];
  const unsent = queue.all().some((q) => q.id === f.id);
  const width = Math.max(8, Math.round((Number(f.amount_ml) / (max || Number(f.amount_ml))) * 100));
  return `
    <button class="feed-row" data-action="edit-feed" data-id="${f.id}">
      <span class="feed-main">
        <span class="feed-time">${fmtTime(f.started_at)}${showKind ? ` <span class="feed-kind">${KIND_SHORT[f.kind]}</span>` : ""}${who ? ` <span class="meta">· ${esc(who.name)}</span>` : ""}${unsent ? ` <span class="unsent" title="Pas encore envoyé">${icon("cloudUp")}</span>` : ""}</span>
        <span class="feed-bar-line"><span class="feed-bar-zone"><span class="feed-bar ${f.kind}" style="width:${width}%"></span></span>
          <span class="feed-amount">${formatAmount(f.amount_ml, unit())}<small> ${unit()}</small></span></span>
      </span>
      <span class="chev">${icon("right")}</span>
    </button>`;
}
const maxAmount = (list) => Math.max(1, ...list.map((f) => Number(f.amount_ml)));

function viewHome() {
  const now = new Date(), feeds = babyFeeds(), baby = currentBaby();
  const last = lastFeed(feeds, now);

  let hero;
  if (!last) {
    hero = `<div class="hero"><span class="hero-icon">${icon("bottle")}</span>
      <div class="hero-text"><p class="hero-title">Aucun boire noté</p>
      <p class="meta">Touche le « + » pour commencer le suivi de ${esc(baby.name)}.</p></div></div>`;
  } else {
    const elapsed = now - new Date(last.started_at);
    const late = baby.remind_after_min && elapsed >= baby.remind_after_min * 60000;
    const who = caregiver(last.caregiver_id);
    hero = `<div class="hero">
      <span class="hero-icon">${icon("bottle")}</span>
      <div class="hero-text">
        <p class="hero-title">Dernier boire</p>
        <p class="hero-elapsed ${late ? "late" : ""}">${elapsed < 60000 ? "à l'instant" : "il y a " + formatElapsed(elapsed)}</p>
        <p class="meta">${esc([`à ${fmtTime(last.started_at)}`, who ? `par ${who.name}` : ""].filter(Boolean).join(" · "))}</p>
      </div>
      <p class="hero-amount">${formatAmount(last.amount_ml, unit())}<small>${unit()}</small></p>
    </div>`;
  }

  const recent = sortDesc(feeds).slice(0, 5), max = maxAmount(recent);
  const open = state.listOpen;
  return `
    <section class="feed-card">
      <div class="feed-band"><h2>Boires</h2>
        <button class="add-btn" data-action="add-feed" aria-label="Ajouter un boire">${icon("plus")}</button></div>
      ${hero}
      ${recent.length ? `
        <button class="fold" data-action="toggle-list"><span>${open ? "Afficher moins" : "Afficher les derniers boires"}</span>${icon(open ? "up2" : "down")}</button>
        ${open ? recent.map((f) => feedRow(f, max)).join("") : ""}
        ${open && feeds.length > 5 ? `<button class="fold more" data-action="tab" data-tab="history"><span>Tout l'historique</span>${icon("right")}</button>` : ""}` : ""}
    </section>`;
}

// --------------------------------------------------------------- historique ---
function delta(cur, prev, label) {
  if (cur == null || prev == null || !prev) return `<span class="delta">${label}</span>`;
  const pct = Math.round(((cur - prev) / prev) * 100);
  const ic = pct > 0 ? "up" : pct < 0 ? "downArrow" : "equal";
  return `<span class="delta">${icon(ic)} ${pct === 0 ? "stable" : `${Math.abs(pct)} %`}</span>`;
}
const fmtInterval = (ms) => (ms == null ? "—" : formatElapsed(ms));

function compareCard() {
  const now = new Date(), feeds = babyFeeds();
  if (state.range === "day") {
    const c = compareToday(feeds, now);
    return `<section class="tiles">
      <div class="tile"><p class="tile-label">Aujourd'hui</p><p class="tile-num">${amount(c.today.total)}</p><p class="meta">${plural(c.today.count, "boire")}</p></div>
      <div class="tile"><p class="tile-label">Hier, à cette heure-ci</p><p class="tile-num">${amount(c.yesterdaySoFar.total)}</p><p class="meta">${plural(c.yesterdaySoFar.count, "boire")}</p></div>
      <div class="tile"><p class="tile-label">Hier, au total</p><p class="tile-num">${amount(c.yesterday.total)}</p><p class="meta">${plural(c.yesterday.count, "boire")}</p></div>
    </section>`;
  }
  const days = state.range === "week" ? 7 : 14;
  const { current: a, previous: b } = comparePeriods(feeds, days, now);
  const vs = `vs les ${days} jours d'avant`;
  const num = (x, f) => (x == null ? "—" : f(x));
  return `<section class="tiles">
      <div class="tile"><p class="tile-label">Volume par jour</p><p class="tile-num">${num(a.total, amount)}</p>${delta(a.total, b.total, "")}</div>
      <div class="tile"><p class="tile-label">Boires par jour</p><p class="tile-num">${num(a.count, (x) => (Math.round(x * 10) / 10).toString().replace(".", ","))}</p>${delta(a.count, b.count, "")}</div>
      <div class="tile"><p class="tile-label">Intervalle moyen</p><p class="tile-num">${fmtInterval(a.interval)}</p>${delta(a.interval, b.interval, "")}</div>
    </section>
    <p class="meta tiles-note">Moyennes des ${days} derniers jours complets, ${vs}.</p>`;
}

function chartCard() {
  const now = new Date(), feeds = babyFeeds();
  if (state.range === "day") {
    const key = dayKey(now);
    const list = feeds.filter((f) => dayKey(f.started_at) === key);
    const max = Math.max(1, ...list.map((f) => Number(f.amount_ml)));
    const minuteOf = (d) => { const x = new Date(d); return x.getHours() * 60 + x.getMinutes(); };
    const bars = list.map((f) =>
      `<span class="tl-bar ${f.kind}" style="left:${(minuteOf(f.started_at) / 1440) * 100}%;height:${Math.max(8, (Number(f.amount_ml) / max) * 100)}%"></span>`).join("");
    return `<section class="card chart-card">
      <div class="section-head"><h2>La journée</h2><span class="meta">un trait par boire</span></div>
      <div class="timeline">${bars}<span class="tl-now" style="left:${(minuteOf(now) / 1440) * 100}%"></span></div>
      <div class="tl-axis"><span>0 h</span><span>6 h</span><span>12 h</span><span>18 h</span><span>24 h</span></div>
    </section>`;
  }
  const days = state.range === "week" ? 7 : 14;
  const series = dailySeries(feeds, days, now);
  const pick = { total: (d) => d.total, count: (d) => d.count, interval: (d) => d.avgInterval || 0 }[state.metric];
  const label = {
    total: (d) => (d.total ? formatAmount(d.total, unit()) : ""),
    count: (d) => (d.count ? String(d.count) : ""),
    interval: (d) => (d.avgInterval ? (Math.round((d.avgInterval / 3600000) * 10) / 10).toString().replace(".", ",") : ""),
  }[state.metric];
  const max = Math.max(1, ...series.map(pick));
  const bars = series.map((d) => `
    <div class="bar-col ${d.isToday ? "today" : ""}">
      <span class="bar-val">${label(d)}</span>
      <span class="bar-track"><span class="bar-fill" style="height:${(pick(d) / max) * 100}%"></span></span>
      <span class="bar-x">${days === 7 ? fr(d.date, { weekday: "short" }).replace(".", "") : d.date.getDate()}</span>
    </div>`).join("");
  const caption = { total: `Volume total par jour (${unit()})`, count: "Nombre de boires par jour", interval: "Intervalle moyen entre deux boires (heures)" }[state.metric];
  const pill = (m, l) => `<button class="pill small ${state.metric === m ? "on lilac" : ""}" data-action="metric" data-metric="${m}">${l}</button>`;
  return `<section class="card chart-card">
      <div class="pillrow">${pill("total", "Volume")}${pill("count", "Fréquence")}${pill("interval", "Intervalle")}</div>
      <div class="bars n${days}">${bars}</div>
      <p class="meta center">${caption} · aujourd'hui en bleu (journée en cours)</p>
    </section>`;
}

function patternCard() {
  if (state.range === "day") return "";
  const now = new Date(), feeds = babyFeeds();
  const days = state.range === "week" ? 7 : 14;
  const p = findPatterns(feeds, now, days);
  if (!p.ready) {
    return `<section class="card pattern-card"><h2>Horaire type</h2>
      <p class="meta">Encore quelques jours de saisie (au moins 3) et Kenda pourra proposer un horaire type.</p></section>`;
  }
  const hist = hourHistogram(feeds, now, days), hmax = Math.max(1, ...hist);
  const hm = (m) => fmtTime(new Date(2000, 0, 1, Math.floor(m / 60), m % 60));
  const slots = p.slots.map((s) => `<span class="slot"><b>${hm(s.minute)}</b><small>≈ ${amount(s.avgMl)}</small></span>`).join("");
  return `<section class="card pattern-card">
      <h2>Horaire type</h2>
      <p class="pattern-line">Environ <b>${p.perDay} boires par jour</b>${p.intervalMs ? `, aux <b>${formatElapsed(p.intervalMs)}</b>` : ""}.</p>
      ${slots ? `<div class="slots">${slots}</div>` : `<p class="meta">Les heures varient trop d'un jour à l'autre pour dégager des créneaux fixes.</p>`}
      <div class="heat">${hist.map((n) => `<span style="opacity:${n ? 0.18 + 0.82 * (n / hmax) : 0.06}"></span>`).join("")}</div>
      <div class="tl-axis"><span>0 h</span><span>6 h</span><span>12 h</span><span>18 h</span><span>24 h</span></div>
      <p class="meta">Heures habituelles des boires, d'après ${plural(p.nDays, "jour")} de saisie.</p>
    </section>`;
}

function viewHistory() {
  const now = new Date();
  const days = state.range === "day" ? 1 : state.range === "week" ? 7 : 14;
  const from = addDays(startOfDay(now), -(days - 1)).getTime();
  const groups = groupByDay(babyFeeds().filter((f) => new Date(f.started_at).getTime() >= from));
  const seg = (r, l) => `<button class="${state.range === r ? "on" : ""}" data-action="range" data-range="${r}">${l}</button>`;
  const list = groups.length ? groups.map((g) => `
      <div class="day-group">
        <div class="day-head"><h3>${esc(capitalize(dayLabel(g.date, now)))}</h3>
          <span class="day-total">${amount(g.total)} <small>· ${plural(g.count, "boire")}</small></span></div>
        <div class="card list">${g.feeds.map((f) => feedRow(f, maxAmount(g.feeds))).join("")}</div>
      </div>`).join("")
    : `<div class="empty">Aucun boire ${days === 1 ? "aujourd'hui" : "sur cette période"}.</div>`;
  return `
    <div class="segmented">${seg("day", "Jour")}${seg("week", "Semaine")}${seg("2weeks", "2 semaines")}</div>
    ${compareCard()}
    ${chartCard()}
    ${patternCard()}
    <div class="section-head"><h2>Journal</h2></div>
    ${list}`;
}

// --------------------------------------------------------------- paramètres ---
function viewSettings() {
  const baby = currentBaby(), mine = me();
  const people = state.caregivers.filter((c) => c.baby_id === baby.id);
  const kinds = enabledKinds();
  const remind = (m) => (m == null ? "Aucune" : formatElapsed(m * 60000));
  return `
    <section class="card form-card">
      <h2>${esc(baby.name)}</h2>
      <div class="photo-row">
        <span class="photo-preview">${babyFace(baby)}</span>
        <div class="photo-actions">
          <label class="btn small">${baby.photo ? "Changer la photo" : "Ajouter une photo"}<input type="file" accept="image/*" data-change="baby-photo" aria-label="Choisir une photo de ${esc(baby.name)}"></label>
          ${baby.photo ? `<button class="link" data-action="remove-photo">Retirer la photo</button>` : ""}
        </div>
      </div>
      <div class="field"><label for="set-baby-name">Prénom du bébé</label>
        <div class="row"><input type="text" id="set-baby-name" value="${esc(baby.name)}" autocomplete="off" maxlength="40">
        <button class="btn small" data-action="save-baby-name">Enregistrer</button></div></div>
      <div class="field"><label>Unité de mesure</label>
        <div class="segmented">
          <button class="${baby.unit === "ml" ? "on" : ""}" data-action="set-unit" data-unit="ml">Millilitres (ml)</button>
          <button class="${baby.unit === "oz" ? "on" : ""}" data-action="set-unit" data-unit="oz">Onces (oz)</button>
        </div>
        <p class="meta">Choisie une fois pour tout le monde ; la saisie ne la redemande jamais.</p></div>
      <div class="field"><label>Types proposés à la saisie</label>
        ${Object.entries(KINDS).map(([k, l]) => `
          <button class="toggle-row" data-action="toggle-kind" data-kind="${k}" aria-pressed="${kinds.includes(k)}">
            <span>${l}</span><span class="switch ${kinds.includes(k) ? "on" : ""}"></span></button>`).join("")}
        <p class="meta">Avec un seul type actif, le choix disparaît de l'écran d'ajout.</p></div>
      <div class="field"><label for="set-remind">Alerte douce sur l'accueil après</label>
        <select id="set-remind" data-change="set-remind">
          ${REMIND_CHOICES.map((m) => `<option value="${m ?? ""}" ${(baby.remind_after_min ?? null) === m ? "selected" : ""}>${remind(m)}</option>`).join("")}
        </select>
        <p class="meta">La carte « Dernier boire » passe à l'orangé une fois ce délai dépassé. Aucune notification.</p></div>
    </section>

    <section class="card form-card">
      <h2>Partage</h2>
      <div class="field"><label>Code de partage de ${esc(baby.name)}</label>
        <div class="row"><div class="code">${esc(baby.join_code)}</div>
          <button class="icon-btn" data-action="copy-code" aria-label="Copier le code">${icon("copy")}</button>
          ${navigator.share ? `<button class="icon-btn" data-action="share-code" aria-label="Partager le code">${icon("share")}</button>` : ""}</div>
        <p class="meta">Ta conjointe ouvre Kenda, crée son compte, puis choisit « Rejoindre avec un code ». Chaque bébé a son propre code.</p></div>
      <div class="field"><label>Personnes qui suivent ${esc(baby.name)}</label>
        <div class="people">${people.map((c) => `
          <div class="person"><span class="avatar" style="background:${esc(c.color || CAREGIVER_COLORS[0])}">${esc(c.name.charAt(0).toUpperCase())}</span>
            <span>${esc(c.name)}</span>${c.user_id === state.user?.id ? `<span class="meta">· toi</span>` : ""}</div>`).join("")}</div></div>
      <div class="field"><label for="set-my-name">Ton prénom (affiché sur les boires)</label>
        <div class="row"><input type="text" id="set-my-name" value="${esc(mine?.name || "")}" autocomplete="off" maxlength="30">
        <button class="btn small" data-action="save-my-name">Enregistrer</button></div></div>
    </section>

    <section class="card form-card">
      <h2>Mes bébés</h2>
      <div class="list flat">${state.babies.map((b) => `
        <button class="feed-row" data-action="pick-baby" data-id="${b.id}">
          <span class="kind-dot maternel">${babyFace(b)}</span>
          <span class="feed-main"><span class="feed-time">${esc(b.name)}</span></span>
          ${b.id === state.babyId ? `<span class="meta">affiché</span>` : ""}
        </button>`).join("")}</div>
      <button class="btn ghost block" data-action="new-baby">${icon("plus")} Ajouter un bébé ou rejoindre un suivi</button>
    </section>

    <section class="card form-card">
      <h2>Compte</h2>
      <p class="meta">${esc(state.user?.email || "")}</p>
      <button class="btn ghost block danger" data-action="signout">${icon("logout")} Se déconnecter</button>
      <p class="meta center">Kenda ${VERSION}${window.KENDA_DEV ? " · DEV" : ""}</p>
    </section>`;
}

// ------------------------------------------------------ écrans hors de l'app ---
const brand = `<div class="brand"><span class="brand-icon">${icon("bottle")}</span><h1>Kenda</h1></div>`;

function viewConfig() {
  return `<div class="center-screen">${brand}
    <p>L'app n'est pas encore reliée à Supabase. Ouvre <b>lib/config.js</b> et colle l'adresse du projet et la clé publique.</p>
    <p class="meta">Les étapes détaillées sont dans le fichier README.</p></div>`;
}

function viewAuth() {
  return `<div class="center-screen">${brand}
    <p>Le suivi des boires de bébé, partagé entre parents.</p>
    <form id="auth-form" class="stack">
      <div class="field"><label for="auth-email">Ton courriel</label>
        <input type="email" id="auth-email" name="email" inputmode="email" autocomplete="username" placeholder="nom@exemple.com" required></div>
      <div class="field"><label for="auth-pass">Mot de passe</label>
        <input type="password" id="auth-pass" name="password" autocomplete="current-password" placeholder="••••••••" minlength="6" required></div>
      <p class="form-error" id="auth-error">${esc(state.authError)}</p>
      <p class="form-info" id="auth-info"></p>
      <button type="submit" id="auth-submit" class="btn primary block">Continuer</button>
      <button type="button" id="auth-forgot" class="link center" data-action="forgot">Mot de passe oublié ?</button>
    </form>
    <p class="meta">Première fois ? Entre un courriel et un mot de passe : ton compte est créé tout de suite.</p></div>`;
}

function viewNewPassword() {
  return `<div class="center-screen">${brand}
    <p>Choisis ton nouveau mot de passe.</p>
    <form id="reset-form" class="stack">
      <div class="field"><label for="reset-pass">Nouveau mot de passe</label>
        <input type="password" id="reset-pass" autocomplete="new-password" minlength="6" required></div>
      <div class="field"><label for="reset-pass2">Encore une fois</label>
        <input type="password" id="reset-pass2" autocomplete="new-password" minlength="6" required></div>
      <p class="form-error" id="reset-error"></p>
      <button type="submit" id="reset-submit" class="btn primary block">Enregistrer</button>
    </form></div>`;
}

function babyFormHtml() {
  const myName = me()?.name || state.caregivers.find((c) => c.user_id === state.user?.id)?.name || nameMemory.get();
  return `
    <div class="field"><label for="ob-name">Ton prénom (affiché sur les boires)</label>
      <input type="text" id="ob-name" autocomplete="off" placeholder="Maxime" maxlength="30" value="${esc(myName)}"></div>
    <div class="field"><label for="ob-baby">Prénom du bébé</label>
      <input type="text" id="ob-baby" autocomplete="off" maxlength="40"></div>
    <button class="btn primary block" data-action="create-baby">Créer le suivi</button>
    <div class="or"><span>ou</span></div>
    <div class="field"><label for="ob-code">Rejoindre avec un code de partage</label>
      <input type="text" id="ob-code" class="code-input" autocomplete="off" autocapitalize="characters" placeholder="ABC12" maxlength="8"></div>
    <button class="btn dark block" data-action="join-baby">Rejoindre ce suivi</button>
    <p class="form-error" id="ob-error"></p>`;
}

function viewOnboard() {
  return `<div class="center-screen">${brand}
    <p>Crée le suivi de ton bébé, ou rejoins celui que ta conjointe a déjà créé.</p>
    <div class="stack">${babyFormHtml()}</div>
    <button class="link center" data-action="signout">Se déconnecter</button></div>`;
}

function viewError() {
  return `<div class="center-screen">${brand}
    <p>${esc(state.error || "Kenda n'arrive pas à joindre le serveur.")}</p>
    <button class="btn primary" data-action="retry">Réessayer</button></div>`;
}

// ================================================================ FEUILLES ===
// Feuille du bas (ajout, modification, choix du bébé). Elle vit hors de #app :
// les tics d'horloge redessinent l'accueil sans la toucher.
function ensureScrim() {
  let scrim = document.getElementById("scrim");
  if (!scrim) {
    scrim = document.createElement("div");
    scrim.id = "scrim"; scrim.className = "scrim";
    scrim.innerHTML = `<div class="sheet" id="sheet" role="dialog" aria-modal="true"></div>`;
    scrim.addEventListener("click", (e) => { if (e.target === scrim) closeSheet(); });
    document.body.appendChild(scrim);
  }
  return scrim;
}
// Sur iOS, le clavier fait défiler la page derrière la feuille et ne la remet
// pas en place : on restaure la position nous-mêmes (leçon apprise sur Calico).
let sheetScrollY = 0;
function openSheet(sheet) {
  const scrim = ensureScrim();
  if (!state.sheet) sheetScrollY = window.scrollY;
  state.sheet = sheet;
  renderSheet();
  // Si la feuille a été refermée avant l'image suivante, on ne la rouvre pas.
  requestAnimationFrame(() => { if (state.sheet) { scrim.classList.add("open"); document.documentElement.classList.add("sheet-open"); } });
}
function closeSheet() {
  const scrim = document.getElementById("scrim");
  state.sheet = null;
  if (scrim) {
    if (scrim.contains(document.activeElement)) document.activeElement.blur();
    scrim.classList.remove("open");
  }
  document.documentElement.classList.remove("sheet-open");
  const restore = () => window.scrollTo(0, sheetScrollY);
  restore(); setTimeout(restore, 350);
}
function renderSheet() {
  const el = document.getElementById("sheet");
  if (!el || !state.sheet) return;
  const body = state.sheet.type === "feed" ? sheetFeed() : state.sheet.type === "babies" ? sheetBabies() : sheetNewBaby();
  const feed = state.sheet.type === "feed";
  el.classList.toggle("form-sheet", feed);
  el.innerHTML = feed ? body : `<div class="grab"></div>${body}`;
}

// ---------------------------------------------------------- ajout d'un boire ---
// Feuille calquée sur une fiche iOS : bandeau (fermer · titre · enregistrer),
// puis une ligne par champ. L'heure ouvre le sélecteur natif de l'iPhone, la
// quantité son clavier numérique.
function openFeedSheet(feed) {
  const kinds = enabledKinds();
  const last = sortDesc(babyFeeds())[0];
  openSheet({
    type: "feed",
    id: feed?.id || null,
    kind: feed?.kind || (last && kinds.includes(last.kind) ? last.kind : kinds[0]),
    time: feed ? new Date(feed.started_at) : null,   // null = « maintenant », figé à l'enregistrement
    confirmDelete: false,
  });
  // Nouveau boire : clavier numérique tout de suite (doit rester dans le geste du toucher pour iOS).
  if (!feed) $("#feed-amount")?.focus({ preventScroll: true });
}

// Heure de début = un jour (menu natif) + une heure (roulette native de l'iPhone).
// Un champ « date et heure » combiné ouvre sur iOS un calendrier, pas la roulette.
const DAY_CHOICES = 7;
const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
/** « Aujourd'hui », « Hier », puis court : « jeu. 17 sept. » (la ligne est étroite). */
function shortDay(d, now = new Date()) {
  const ago = daysAgo(d, now);
  return ago === 0 ? "Aujourd'hui" : ago === 1 ? "Hier" : fr(new Date(d), { weekday: "short", day: "numeric", month: "short" });
}
const daysAgo = (d, now = new Date()) => Math.round((startOfDay(now) - startOfDay(d)) / DAY);

/** Lit les deux champs et met à jour l'heure du boire et les libellés. */
function readWhen() {
  const s = state.sheet, dayEl = $("#feed-day"), timeEl = $("#feed-time");
  if (!s || !dayEl || !timeEl) return;
  const now = new Date();
  const [h, m] = (timeEl.value || hhmm(now)).split(":").map(Number);
  let ago = Number(dayEl.value) || 0;
  const build = () => { const d = addDays(startOfDay(now), -ago); d.setHours(h, m, 0, 0); return d; };
  // 23 h 50 choisi peu après minuit : c'était forcément hier.
  if (ago === 0 && build() > new Date(now.getTime() + 2 * 60000)) { ago = 1; dayEl.value = "1"; }
  s.time = build();
  $("#feed-day-label").textContent = shortDay(s.time, now);
  $("#feed-time-label").textContent = fmtTime(s.time);
}

function sheetFeed() {
  const s = state.sheet, u = unit(), kinds = enabledKinds();
  const showKinds = kinds.length > 1 || !kinds.includes(s.kind);
  const kindList = showKinds ? [...new Set([...kinds, s.kind])] : [];
  const now = new Date();
  const existing = s.id ? state.feeds.find((f) => f.id === s.id) : null;
  const last = lastFeed(babyFeeds(), now);

  const when = s.time || now, ago = Math.max(0, daysAgo(when, now));
  const dayOptions = Array.from({ length: Math.max(DAY_CHOICES, ago + 1) }, (_, i) =>
    `<option value="${i}" ${i === ago ? "selected" : ""}>${esc(capitalize(dayLabel(addDays(now, -i), now)))}</option>`).join("");

  // Passation : si l'autre parent vient tout juste de noter un boire, on le dit.
  let warn = "";
  if (!s.id && last && now - new Date(last.started_at) < 20 * 60000) {
    const who = caregiver(last.caregiver_id);
    warn = `<p class="sheet-warn">${icon("clock")} Un boire de ${amount(last.amount_ml)} a déjà été noté à ${fmtTime(last.started_at)}${who ? ` par ${esc(who.name)}` : ""}.</p>`;
  }
  return `
    <div class="sheet-band">
      <button class="band-btn" data-action="close-sheet" aria-label="Fermer">${icon("x")}</button>
      <h2>${s.id ? "Modifier le boire" : "Ajouter un boire"}</h2>
      <button class="band-save" data-action="save-feed" aria-label="Enregistrer">${icon("check")}</button>
    </div>
    ${warn}
    <div class="form-row">
      <span class="row-label">Heure de début</span>
      <span class="when">
        <label class="when-part"><span id="feed-day-label">${esc(shortDay(when, now))}</span>
          <select id="feed-day" class="row-cover" data-change="feed-when" aria-label="Jour du boire">${dayOptions}</select></label>
        <label class="when-part"><span id="feed-time-label">${fmtTime(when)}</span>
          <input type="time" id="feed-time" class="row-cover" value="${hhmm(when)}" data-change="feed-when" aria-label="Heure de début du boire"></label>
      </span>
    </div>
    ${showKinds ? `<div class="form-row">
      <span class="row-label">Type</span>
      <span class="pillrow tight">${kindList.map((k) =>
        `<button class="pill small ${k} ${s.kind === k ? "on" : ""}" data-action="feed-kind" data-kind="${k}">${KIND_SHORT[k]}</button>`).join("")}</span>
    </div>` : ""}
    <label class="form-row">
      <span class="row-label">Quantité</span>
      <span class="row-amount"><input type="text" id="feed-amount" inputmode="${u === "oz" ? "decimal" : "numeric"}" autocomplete="off" enterkeyhint="done"
        placeholder="Ajouter" value="${existing ? formatAmount(existing.amount_ml, u) : ""}" data-input="feed-amount" aria-label="Quantité en ${u}"><small>${u}</small></span>
    </label>
    ${!s.id && last ? `<div class="suggest" id="feed-suggest">
      <span>Utiliser la dernière quantité : ${amount(last.amount_ml)} ?</span>
      <button class="btn-outline" data-action="use-last" data-value="${formatAmount(last.amount_ml, u)}">Oui</button>
    </div>` : ""}
    ${s.id ? `<div class="sheet-foot"><button class="btn ghost danger" data-action="delete-feed">${icon("trash")} ${s.confirmDelete ? "Toucher encore pour supprimer" : "Supprimer ce boire"}</button></div>` : ""}`;
}

/** Garde la saisie propre : chiffres seulement (une décimale en oz). */
function cleanAmount(raw) {
  let v = String(raw).replace(/\./g, ",").replace(/[^\d,]/g, "");
  if (unit() !== "oz") return v.replace(/,/g, "").slice(0, 3);
  const [int, ...rest] = v.split(",");
  return rest.length ? `${int.slice(0, 2)},${rest.join("").slice(0, 1)}` : int.slice(0, 2);
}

function saveFeed() {
  const s = state.sheet, u = unit();
  const field = $("#feed-amount");
  const value = parseFloat((field?.value || "").replace(",", "."));
  if (!value || value <= 0) { toast("Entre une quantité"); field?.focus(); return; }
  const ml = fromUnit(value, u);
  if (ml > 1000) { toast("Quantité trop grande"); return; }
  const when = s.time || new Date();
  if (when.getTime() > Date.now() + 2 * 60000) { toast("L'heure est dans le futur"); return; }
  const existing = s.id ? state.feeds.find((f) => f.id === s.id) : null;
  // Modifier sans toucher à la quantité : on garde les ml d'origine (pas d'aller-retour oz → ml).
  const sameAmount = existing && formatAmount(existing.amount_ml, u) === formatAmount(ml, u);
  const feed = {
    id: s.id || uuid(),
    baby_id: state.babyId,
    kind: s.kind,
    amount_ml: sameAmount ? Number(existing.amount_ml) : ml,
    started_at: when.toISOString(),
    caregiver_id: existing ? existing.caregiver_id : me()?.id || null,
    deleted_at: null,
  };
  commitFeed(feed);
  closeSheet();
  toast(s.id ? "Boire modifié" : `Boire ajouté · ${amount(feed.amount_ml)}`, { kind: "ok" });
}

function deleteFeed() {
  const s = state.sheet;
  if (!s.confirmDelete) {
    s.confirmDelete = true;
    $('[data-action="delete-feed"]').innerHTML = `${icon("trash")} Toucher encore pour supprimer`;
    return;
  }
  const existing = state.feeds.find((f) => f.id === s.id);
  if (existing) commitFeed({ ...existing, deleted_at: new Date().toISOString() });
  closeSheet();
  toast("Boire supprimé");
}

/** Écrit un boire : à l'écran et sur l'appareil tout de suite, vers Supabase dès que possible. */
function commitFeed(feed) {
  const row = {
    id: feed.id, baby_id: feed.baby_id, kind: feed.kind, amount_ml: Number(feed.amount_ml),
    started_at: feed.started_at, caregiver_id: feed.caregiver_id || null,
    deleted_at: feed.deleted_at || null, updated_at: new Date().toISOString(),
  };
  state.feeds = state.feeds.filter((f) => f.id !== row.id);
  if (!row.deleted_at) state.feeds.push(row);
  queue.push(row);
  state.pending = queue.size();
  saveSnapshot();
  renderMain(); renderBanner();
  flushQueue();
}

// ------------------------------------------------------------ choix du bébé ---
function sheetBabies() {
  return `<h2>Mes bébés</h2>
    <div class="list flat">${state.babies.map((b) => `
      <button class="feed-row ${b.id === state.babyId ? "cur" : ""}" data-action="pick-baby" data-id="${b.id}">
        <span class="kind-dot maternel">${babyFace(b)}</span>
        <span class="feed-main"><span class="feed-time">${esc(b.name)}</span></span>
        ${b.id === state.babyId ? icon("check") : ""}
      </button>`).join("")}</div>
    <button class="btn ghost block" data-action="new-baby">${icon("plus")} Ajouter un bébé ou rejoindre un suivi</button>`;
}
function sheetNewBaby() {
  return `<h2>Nouveau suivi</h2><div class="stack">${babyFormHtml()}</div>`;
}

function pickBaby(id) {
  if (!state.babies.some((b) => b.id === id)) return;
  state.babyId = id; babyMemory.set(id);
  if (state.sheet) closeSheet();
  saveSnapshot();
  renderApp();
  window.scrollTo(0, 0);
}

// ================================================================= DONNÉES ===
function saveSnapshot() {
  if (!state.user || !state.babies.length) return;
  snapshot.save({
    userId: state.user.id, email: state.user.email, babies: state.babies, caregivers: state.caregivers,
    feeds: state.feeds, syncedAt: state.syncedAt,
  });
}

/** Affiche les données de la dernière synchro. Faux s'il n'y en a pas pour ce compte. */
function showSnapshot() {
  const snap = snapshot.load();
  if (!snap || !state.user || snap.userId !== state.user.id || !snap.babies?.length) return false;
  state.babies = snap.babies; state.caregivers = snap.caregivers || [];
  state.feeds = applyQueue(snap.feeds || []);
  state.syncedAt = snap.syncedAt || null;
  if (!state.user.email && snap.email) state.user = { ...state.user, email: snap.email };
  chooseBaby();
  state.offlineData = true;
  render("app");
  return true;
}

function chooseBaby(prefer) {
  const wanted = prefer || state.babyId || babyMemory.get();
  state.babyId = (state.babies.find((b) => b.id === wanted) || state.babies[0])?.id || null;
  if (state.babyId) babyMemory.set(state.babyId);
}

async function fetchFeeds() {
  const since = new Date(Date.now() - HISTORY_DAYS * DAY).toISOString();
  const all = [];
  for (let page = 0; page < 6; page++) {       // Supabase rend 1000 lignes à la fois
    const { data, error } = await supabase.from("feeds").select("*")
      .is("deleted_at", null).gte("started_at", since)
      .order("started_at", { ascending: false }).range(page * 1000, page * 1000 + 999);
    if (error) throw error;
    all.push(...data);
    if (data.length < 1000) break;
  }
  return all;
}

let loading = null;
function loadAll(preferBabyId = null) {
  loading ||= (async () => {
    try {
      const [b, c, feeds] = await Promise.all([
        supabase.from("babies").select("*").order("created_at"),
        supabase.from("caregivers").select("*").order("created_at"),
        fetchFeeds(),
      ]);
      if (b.error) throw b.error;
      if (c.error) throw c.error;
      state.caregivers = c.data;
      const mine = new Set(c.data.filter((x) => x.user_id === state.user.id).map((x) => x.baby_id));
      state.babies = b.data.filter((x) => mine.has(x.id));
      if (!state.babies.length) {
        state.babyId = null; snapshot.clear();
        if (state.sheet) closeSheet();
        render("onboard"); return true;
      }
      state.feeds = applyQueue(feeds);
      state.syncedAt = Date.now();
      state.offlineData = false; state.online = true;
      chooseBaby(preferBabyId);
      saveSnapshot();
      subscribeRealtime();
      if (state.view !== "app") render("app"); else { refreshHeader(); renderMain(); renderBanner(); }
      flushQueue();
      return true;
    } catch (err) {
      console.warn("loadAll", err);
      // Panne de réseau (et non refus de la base) : on le dit dans le bandeau.
      if (!navigator.onLine || /fetch|network|load failed/i.test(String(err?.message || err))) state.online = false;
      if (state.view === "app") { state.offlineData = true; renderBanner(); return false; }
      if (!showSnapshot()) {
        state.error = "Impossible de charger les données. Vérifie ta connexion, puis réessaie.";
        render("error");
      }
      return false;
    } finally { loading = null; }
  })();
  return loading;
}

/** Le nom du bébé ou la liste des bébés a pu changer : on refait la coquille,
 *  sauf si une feuille est ouverte (elle n'en dépend pas). */
function refreshHeader() {
  const name = $(".baby-name");
  if (!name || name.textContent !== currentBaby()?.name || ($(".baby-icon img")?.getAttribute("src") || null) !== (currentBaby()?.photo || null) || !!$(".baby-chev") !== state.babies.length > 1) renderApp();
}

// ------------------------------------------------------------- temps réel ---
let reloadTimer = null;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => loadAll(), 200);
}

function onFeedChange(payload) {
  if (payload.eventType === "DELETE") { scheduleReload(); return; }
  const row = payload.new;
  if (!row?.id) { scheduleReload(); return; }
  const pending = queue.all().find((q) => q.id === row.id);
  if (pending && Date.parse(pending.updated_at) > Date.parse(row.updated_at)) return;   // notre version est plus récente
  state.feeds = state.feeds.filter((f) => f.id !== row.id);
  if (!row.deleted_at) state.feeds.push(row);
  saveSnapshot();
  renderMain();
}

// Sur iPhone, l'app en arrière-plan perd sa connexion temps réel sans prévenir :
// on garde le canal sous la main pour vérifier son état au réveil, et on
// recharge à chaque reconnexion (ce qui s'est passé pendant la coupure n'a
// jamais été reçu).
function subscribeRealtime() {
  const ch = state.channel;
  if (ch && (ch.state === "joined" || ch.state === "joining")) return;
  if (ch) supabase.removeChannel(ch);
  let firstJoin = true;
  state.channel = supabase.channel("kenda-" + state.user.id)
    .on("postgres_changes", { event: "*", schema: "public", table: "feeds" }, onFeedChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "babies" }, scheduleReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "caregivers" }, scheduleReload)
    .subscribe((status) => {
      if (status !== "SUBSCRIBED") return;
      if (firstJoin) { firstJoin = false; return; }
      scheduleReload();
    });
}

// --------------------------------------------------------- file d'attente ---
// Refus définitifs de la base (donnée invalide, contrainte, règle de sécurité) :
// l'entrée est abandonnée et on le dit. Tout le reste (réseau, jeton à
// rafraîchir, serveur en panne) : on garde et on réessaie plus tard.
const isFinalRefusal = (error) => /^(22|23)\w{3}$|^42501$/.test(String(error?.code || ""));

let flushing = false;
async function flushQueue() {
  if (flushing) return;
  if (!state.user || !navigator.onLine) { state.pending = queue.size(); renderBanner(); return; }
  flushing = true;
  let dropped = false;
  try {
    let item;
    while ((item = queue.peek())) {
      let res;
      try { res = await supabase.from("feeds").upsert(item, { onConflict: "id" }); }
      catch (e) { res = { error: e }; }
      if (res.error) {
        if (!isFinalRefusal(res.error)) { state.online = false; break; }
        queue.remove(item); dropped = true;
        toast(`Un boire n'a pas pu être enregistré (${res.error.code}).`, { ms: 6000 });
        continue;
      }
      state.online = true;
      queue.remove(item);
    }
  } finally {
    flushing = false;
    state.pending = queue.size();
    renderBanner(); renderMain();
    if (dropped) loadAll();
  }
}

// Bandeau discret sous l'en-tête : hors ligne et/ou changements en attente.
function renderBanner() {
  const el = document.getElementById("net-banner");
  if (!el) return;
  const n = state.pending, offline = !state.online || !navigator.onLine;
  let html = "";
  if (offline) {
    let since = "";
    if (state.syncedAt) {
      const d = new Date(state.syncedAt);
      since = dayKey(d) === dayKey(new Date()) ? ` · à jour à ${fmtTime(d)}` : ` · à jour ${dayLabel(d).toLowerCase()} à ${fmtTime(d)}`;
    }
    html = `${icon("cloudOff")}<span>Hors ligne${since}${n ? ` · ${plural(n, "boire")} à envoyer` : ""}</span>`;
  } else if (n) html = `${icon("cloudUp")}<span>Envoi de ${plural(n, "boire")}…</span>`;
  else if (state.offlineData) html = `${icon("refresh")}<span>Données de la dernière synchro</span><button data-action="reload">Actualiser</button>`;
  el.hidden = !html;
  el.innerHTML = html;
}

// ================================================================= ACTIONS ===
async function submitAuth() {
  const email = $("#auth-email").value.trim(), password = $("#auth-pass").value;
  const err = $("#auth-error"), btn = $("#auth-submit");
  $("#auth-info").textContent = ""; err.textContent = "";
  if (!email.includes("@")) { err.textContent = "Entre un courriel valide."; return; }
  if (password.length < 6) { err.textContent = "Mot de passe : au moins 6 caractères."; return; }
  btn.disabled = true; btn.textContent = "Un instant…";
  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (!error) return;                                   // SIGNED_IN → boot()
    if (!/invalid|credentials/i.test(error.message)) { err.textContent = /fetch|network/i.test(error.message) ? "Pas de réseau. Réessaie dans un instant." : error.message; return; }
    const { data, error: e2 } = await supabase.auth.signUp({ email, password });
    if (e2) { err.textContent = /already/i.test(e2.message) ? "Mot de passe incorrect." : e2.message; return; }
    if (data.session) return;
    err.textContent = "Compte créé, mais Supabase attend une confirmation par courriel : désactive « Confirm email » (voir le README).";
  } finally { btn.disabled = false; btn.textContent = "Continuer"; }
}

const LINK_EXPIRED = "Ce lien n'est plus valide. Redemande un lien avec « Mot de passe oublié ? ».";

async function forgotPassword() {
  const emailEl = $("#auth-email"), err = $("#auth-error"), info = $("#auth-info"), btn = $("#auth-forgot");
  const email = emailEl.value.trim();
  err.textContent = ""; info.textContent = "";
  if (!email || !emailEl.checkValidity()) { err.textContent = "Entre ton courriel ci-dessus, puis retouche « Mot de passe oublié ? »."; emailEl.focus(); return; }
  btn.disabled = true;
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if (error) { err.textContent = /rate limit|security purposes|after \d+ seconds/i.test(error.message) ? "Trop de demandes pour l'instant. Réessaie dans quelques minutes." : error.message; return; }
    info.textContent = "Si un compte existe avec ce courriel, un lien vient d'être envoyé (regarde aussi les indésirables). Il est valable une heure.";
  } finally { btn.disabled = false; }
}

async function submitReset() {
  const p1 = $("#reset-pass").value, p2 = $("#reset-pass2").value;
  const err = $("#reset-error"), btn = $("#reset-submit");
  err.textContent = "";
  if (p1 !== p2) { err.textContent = "Les deux mots de passe ne sont pas identiques."; return; }
  btn.disabled = true; btn.textContent = "Un instant…";
  try {
    const { error } = await supabase.auth.updateUser({ password: p1 });
    if (error) {
      err.textContent = /different from the old/i.test(error.message) ? "Choisis un mot de passe différent de l'ancien."
        : /weak|easy to guess/i.test(error.message) ? "Ce mot de passe est trop courant. Choisis-en un autre."
        : /session missing|not authenticated/i.test(error.message) ? LINK_EXPIRED : error.message;
      return;
    }
    state.recovery = false; toast("Mot de passe enregistré", { kind: "ok" });
    await loadAll();
  } finally { btn.disabled = false; btn.textContent = "Enregistrer"; }
}

async function createOrJoinBaby(join) {
  const err = $("#ob-error"); err.textContent = "";
  const name = $("#ob-name").value.trim();
  if (!name) { err.textContent = "Entre ton prénom."; return; }
  let res;
  if (join) {
    const code = $("#ob-code").value.trim().toUpperCase();
    if (!code) { err.textContent = "Entre le code de partage."; return; }
    // La couleur dépend du nombre de personnes déjà là, qu'on ne voit pas encore : la base la choisit.
    res = await supabase.rpc("join_baby", { p_code: code, p_caregiver_name: name, p_color: null });
  } else {
    const babyName = $("#ob-baby").value.trim();
    if (!babyName) { err.textContent = "Entre le prénom du bébé."; return; }
    res = await supabase.rpc("create_baby", { p_baby_name: babyName, p_caregiver_name: name, p_color: CAREGIVER_COLORS[0] });
  }
  if (res.error) {
    const m = res.error.message || "";
    err.textContent = /not found/i.test(m) ? "Code introuvable. Vérifie-le avec la personne qui te l'a donné."
      : /full/i.test(m) ? "Ce suivi a déjà le maximum de personnes."
      : /fetch|network/i.test(m) ? "Pas de réseau. Réessaie dans un instant." : m;
    return;
  }
  nameMemory.set(name);
  if (state.sheet) closeSheet();
  state.tab = "home";
  await loadAll(res.data);
  toast(join ? "Suivi rejoint" : "Suivi créé", { kind: "ok" });
}

/** Photo du bébé : recadrée en carré et réduite à 256 px sur l'appareil (≈ 15 Ko),
 *  puis gardée avec le bébé — elle suit donc la synchro et le mode hors ligne. */
function shrinkPhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight), size = 256;
      const c = document.createElement("canvas"); c.width = c.height = size;
      c.getContext("2d").drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image illisible")); };
    img.src = url;
  });
}

/** Réglages du bébé : appliqués à l'écran tout de suite, annulés si Supabase refuse. */
async function updateBaby(patch, okMsg) {
  const baby = currentBaby(), before = { ...baby };
  Object.assign(baby, patch);
  saveSnapshot(); renderApp();
  const { error } = await supabase.from("babies").update(patch).eq("id", baby.id);
  if (error) { Object.assign(baby, before); saveSnapshot(); renderApp(); toast(`Pas enregistré : ${error.message}`, { ms: 5000 }); return; }
  if (okMsg) toast(okMsg, { kind: "ok" });
}

async function saveMyName() {
  const name = $("#set-my-name").value.trim(), mine = me();
  if (!name || !mine) { toast("Entre ton prénom"); return; }
  document.activeElement?.blur();
  const { error } = await supabase.from("caregivers").update({ name }).eq("id", mine.id);
  if (error) { toast(`Pas enregistré : ${error.message}`, { ms: 5000 }); return; }
  mine.name = name; nameMemory.set(name); saveSnapshot(); renderMain();
  toast("Prénom mis à jour", { kind: "ok" });
}

async function signOut() {
  if (state.pending && !confirm(`${plural(state.pending, "boire")} pas encore envoyé${state.pending > 1 ? "s" : ""} : ils seront perdus. Se déconnecter quand même ?`)) return;
  if (state.channel) { supabase.removeChannel(state.channel); state.channel = null; }
  await supabase.auth.signOut();
  resetToSignedOut();
}

function resetToSignedOut() {
  snapshot.clear(); queue.clear();
  Object.assign(state, { user: null, babies: [], caregivers: [], feeds: [], babyId: null, pending: 0, offlineData: false, syncedAt: null, tab: "home" });
  if (state.sheet) closeSheet();
  render("auth");
}

// Hors ligne on peut tout faire sur les boires ; ce qui touche au compte, aux
// bébés et aux réglages partagés attend le réseau.
const ONLINE_ONLY = new Set(["remove-photo", "create-baby", "join-baby", "save-baby-name", "set-unit", "toggle-kind", "save-my-name", "forgot"]);
const isOffline = () => !navigator.onLine || !state.online;

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const a = btn.dataset.action;
  if (ONLINE_ONLY.has(a) && isOffline()) {
    toast("Hors ligne — possible dès que le réseau revient", { ms: 3200 });
    if (navigator.onLine) wakeUp();      // peut-être revenu sans qu'on le sache
    return;
  }
  switch (a) {
    case "tab":
      state.tab = btn.dataset.tab; renderApp(); window.scrollTo(0, 0); return;
    case "range": state.range = btn.dataset.range; return renderMain();
    case "metric": state.metric = btn.dataset.metric; return renderMain();
    case "reload": return loadAll();
    case "retry": render("loading"); return boot();

    // boires
    case "add-feed": return openFeedSheet(null);
    case "edit-feed": { const f = state.feeds.find((x) => x.id === btn.dataset.id); if (f) openFeedSheet(f); return; }
    case "feed-kind":
      state.sheet.kind = btn.dataset.kind;      // sans redessiner : la quantité en cours de saisie reste
      document.querySelectorAll('#sheet [data-action="feed-kind"]').forEach((b) => b.classList.toggle("on", b.dataset.kind === state.sheet.kind));
      return;
    case "use-last": $("#feed-amount").value = btn.dataset.value; $("#feed-suggest")?.remove(); return;
    case "close-sheet": return closeSheet();
    case "toggle-list": state.listOpen = !state.listOpen; return renderMain();
    case "save-feed": return saveFeed();
    case "delete-feed": return deleteFeed();

    // bébés
    case "open-babies": return openSheet({ type: "babies" });
    case "pick-baby": return pickBaby(btn.dataset.id);
    case "new-baby": return openSheet({ type: "newBaby" });
    case "create-baby": return createOrJoinBaby(false);
    case "join-baby": return createOrJoinBaby(true);

    // paramètres
    case "save-baby-name": {
      const name = $("#set-baby-name").value.trim();
      if (!name) { toast("Entre le prénom du bébé"); return; }
      document.activeElement?.blur();
      return updateBaby({ name }, "Prénom mis à jour");
    }
    case "set-unit":
      if (btn.dataset.unit !== unit()) updateBaby({ unit: btn.dataset.unit }, `Unité : ${btn.dataset.unit}`);
      return;
    case "toggle-kind": {
      const k = btn.dataset.kind, cur = enabledKinds();
      const next = cur.includes(k) ? cur.filter((x) => x !== k) : Object.keys(KINDS).filter((x) => x === k || cur.includes(x));
      if (!next.length) { toast("Garde au moins un type actif"); return; }
      return updateBaby({ kinds: next });
    }
    case "remove-photo": return updateBaby({ photo: null }, "Photo retirée");
    case "save-my-name": return saveMyName();
    case "copy-code":
      navigator.clipboard?.writeText(currentBaby().join_code);
      return toast("Code copié", { kind: "ok" });
    case "share-code": {
      const b = currentBaby();
      navigator.share?.({ text: `Rejoins le suivi de ${b.name} dans Kenda (${location.origin}) avec le code ${b.join_code}.` }).catch(() => {});
      return;
    }
    case "forgot": return forgotPassword();
    case "signout": return signOut();
  }
});

document.addEventListener("change", (e) => {
  const kind = e.target?.dataset?.change;
  if (kind === "feed-when" && state.sheet?.type === "feed") readWhen();
  if (kind === "baby-photo") {
    const file = e.target.files?.[0];
    if (!file) return;
    if (isOffline()) { toast("Hors ligne — possible dès que le réseau revient", { ms: 3200 }); return; }
    shrinkPhoto(file).then((photo) => updateBaby({ photo }, "Photo mise à jour"))
      .catch(() => toast("Cette image n'a pas pu être lue"));
  }
  if (kind === "set-remind") {
    if (isOffline()) { toast("Hors ligne — possible dès que le réseau revient", { ms: 3200 }); renderMain(); return; }
    updateBaby({ remind_after_min: e.target.value ? Number(e.target.value) : null });
  }
});

// Sur ordinateur (souris), un champ invisible ne montre rien au clic : on
// demande au navigateur d'ouvrir son sélecteur. Sur iPhone, le toucher suffit.
document.addEventListener("click", (e) => {
  const field = e.target.closest?.(".when-part")?.querySelector("#feed-time");
  if (!field || !matchMedia("(pointer: fine)").matches) return;
  try { field.showPicker?.(); } catch { field.focus(); }
});

document.addEventListener("input", (e) => {
  // La roulette envoie « input » à chaque cran, « change » seulement à la fermeture.
  if (e.target?.id === "feed-time" && state.sheet?.type === "feed") { readWhen(); return; }
  if (e.target?.dataset?.input !== "feed-amount") return;
  const v = cleanAmount(e.target.value);
  if (v !== e.target.value) e.target.value = v;
  if (v) $("#feed-suggest")?.remove();
});

document.addEventListener("submit", (e) => {
  e.preventDefault();
  if (e.target.id === "auth-form") submitAuth();
  if (e.target.id === "reset-form") submitReset();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.sheet) closeSheet();
  if (e.key === "Enter" && e.target?.id === "feed-amount") saveFeed();
});

// =============================================================== DÉMARRAGE ===
// Lien du courriel « Mot de passe oublié ? » : Supabase ramène ici avec
// #access_token=…&type=recovery (supabase-js ouvre alors la session tout seul),
// ou #error=… si le lien a expiré.
function readAuthLink() {
  const p = new URLSearchParams(location.hash.slice(1) + "&" + location.search.slice(1));
  if (p.get("type") === "recovery") { state.recovery = true; return "recovery"; }
  if (p.get("error_description") || p.get("error")) return "error";
  return null;
}

/** Utilisateur de la session gardée sur l'appareil, lu sans passer par
 *  supabase-js : hors ligne avec un jeton expiré, getSession() s'acharne
 *  ~25 s à le rafraîchir, puis répond « pas de session ». */
function storedUser() {
  try {
    const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
    return JSON.parse(localStorage.getItem(`sb-${ref}-auth-token`))?.user || null;
  } catch { return null; }
}

const BOOT_PATIENCE = 2500;   // ms avant d'afficher la dernière synchro si le réseau traîne

async function boot() {
  if (!isConfigured() && !globalThis.__KENDA_FAKE_SUPABASE__) { render("config"); return; }
  // Empêche iOS de restaurer un ancien décalage de défilement au lancement.
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  const link = readAuthLink();      // avant que supabase-js ne lise l'adresse
  // Sans réseau (ou s'il traîne), on n'attend pas : l'app s'ouvre sur les
  // données de la dernière synchro, et le chargement continue derrière.
  const cachedUser = link ? null : storedUser();
  const early = cachedUser && setTimeout(() => {
    if (state.view === "app") return;
    state.user = cachedUser;
    showSnapshot();
  }, navigator.onLine ? BOOT_PATIENCE : 0);
  try {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (link) history.replaceState(null, "", location.pathname);
    if (link === "recovery") {
      if (session) { state.user = session.user; render("newPassword"); }
      else { state.authError = LINK_EXPIRED; render("auth"); }
      return;
    }
    if (link === "error") state.authError = LINK_EXPIRED;
    if (!session) {
      // Jeton expiré et réseau absent : la session est toujours sur l'appareil
      // (supabase-js ne l'efface que si le serveur la refuse) ; on reste connecté.
      const kept = error ? storedUser() : null;
      if (kept) { state.user = kept; await loadAll(); return; }
      state.user = null;
      render("auth");
      return;
    }
    state.user = session.user;
    await loadAll();
  } finally {
    clearTimeout(early);
  }
}

supabase.auth.onAuthStateChange((event, session) => {
  if (event === "PASSWORD_RECOVERY") { state.recovery = true; if (session) state.user = session.user; render("newPassword"); return; }
  if (event === "SIGNED_IN" && state.view === "auth" && !state.recovery) { state.user = session.user; render("loading"); loadAll(); }
  if (event === "SIGNED_OUT" && state.user) resetToSignedOut();
});

// ------------------------------------------------------------------ réveil ---
// Quand on revient dans l'app (autre app, écran verrouillé), tout peut dater :
// compteurs, boires donnés par l'autre parent, connexion temps réel morte.
let waking = null;
function wakeUp(evenHidden = false) {
  if (state.view !== "app" || (document.hidden && evenHidden !== true)) return;
  renderMain();                       // au moins les bons chiffres, tout de suite
  if (waking) return;
  waking = (async () => {
    try {
      await flushQueue();
      await loadAll();
      const ch = state.channel;
      if (!ch || (ch.state !== "joined" && ch.state !== "joining")) subscribeRealtime();
    } finally { waking = null; }
  })();
}
document.addEventListener("visibilitychange", wakeUp);
window.addEventListener("pageshow", wakeUp);
// Le réseau revient : on envoie ce qui attend, même si l'app est en arrière-plan.
window.addEventListener("online", () => { state.online = true; renderBanner(); wakeUp(true); });
window.addEventListener("offline", () => { state.online = false; renderBanner(); });

// L'horloge : le total « 24 h », le « il y a… » et le passage de minuit
// évoluent sans qu'on touche à rien.
setInterval(() => { if (!document.hidden && state.tab !== "settings") renderMain(); }, 20000);
// Tant qu'on est hors ligne ou qu'il reste des boires à envoyer, on retente :
// l'événement « online » n'est pas fiable sur iOS.
setInterval(() => { if (state.view === "app" && (state.pending || !state.online || state.offlineData)) wakeUp(true); }, 30000);

boot();
