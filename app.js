import { supabase } from "./lib/supabase.js";
import { isConfigured, SUPABASE_URL } from "./lib/config.js";
import { queue, snapshot, babyMemory, nameMemory, timerMemory, applyQueue } from "./lib/store.js";
import { photos } from "./lib/photos.js";
import {
  MEASURES, PERCENTILES, MAX_AGE_DAYS, parseDay, ageInDays, ageLabel, percentileOf, percentileLabel, percentileCurve,
  formatWeight, formatLength, lbOzToG, gToLbOz, lengthToCm, cmToLength, G_PER_LB, CM_PER_IN,
} from "./lib/growth.js";
import {
  ML_PER_OZ, fromUnit, formatAmount, startOfDay, addDays, dayKey, sortDesc,
  totalToday, totalLast24h, lastFeed, formatElapsed,
  groupByDay, dailySeries, comparePeriods,
  findPatterns, hourHistogram,
} from "./lib/stats.js";

const VERSION = "1.2.1";
const DAY = 86400000;
const HISTORY_DAYS = 31;          // 2 semaines + les 2 d'avant, pour la comparaison
const KINDS = { maternel: "Lait maternel", formule: "Formule" };
const KIND_SHORT = { maternel: "Maternel", formule: "Formule" };
const CAREGIVER_COLORS = ["#6B5A85", "#3E6B7A", "#8A6D4B", "#5F7F5A", "#9A5F72", "#7A7468"];
const REMIND_CHOICES = [null, 120, 150, 180, 210, 240, 300];
// Les blocs de l'accueil. L'ordre et l'état de chacun sont un réglage du bébé (babies.modules).
const MODULES = {
  biberon: { label: "Boires", icon: "drop" },      // id historique : « biberon »
  couches: { label: "Couches", icon: "diaper" },
  croissance: { label: "Croissance", icon: "ruler" },
  premieres: { label: "Premières de bébé", icon: "star" },
  tirelait: { label: "Tire-lait", icon: "pump" },
  allergenes: { label: "Allergènes", icon: "peanut" },
};
// Colonnes chargées pour les listes : tout sauf la photo (lib/photos.js s'en occupe).
const GROWTH_COLS = "id,baby_id,measured_on,weight_g,height_cm,head_cm,note,has_photo,caregiver_id,created_at,updated_at,deleted_at";
const FIRSTS_COLS = "id,baby_id,happened_on,title,note,has_photo,caregiver_id,created_at,updated_at,deleted_at";
const PUMP_COLS = "id,baby_id,started_at,duration_sec,amount_ml,left_ml,right_ml,caregiver_id,created_at,updated_at,deleted_at";
const ALLERGEN_COLS = "id,baby_id,given_at,allergens,food,reaction,symptoms,has_photo,caregiver_id,created_at,updated_at,deleted_at";
const SYNCED = ["feeds", "diapers", "growth", "firsts", "nursings", "pumpings", "allergen_exposures"];     // tables à saisie hors ligne (file d'attente)

// ------------------------------------------------------------------ state ---
const state = {
  view: "loading",      // loading | config | auth | newPassword | onboard | error | app
  tab: "home",          // home | history | settings
  user: null,
  older: {},            // par bébé : total des boires plus vieux que la fenêtre chargée
  babies: [], caregivers: [], feeds: [],   // feeds : tous mes bébés, file d'attente appliquée
  diapers: [], growth: [], firsts: [], nursings: [], pumpings: [], allergen_exposures: [],   // idem pour les autres modules
  page: null,           // sous-écran ouvert par-dessus l'onglet : diapers | growth | firsts | modules | allergen
  allergen: null,       // allergènes : celui dont on regarde le détail
  measure: "weight",    // croissance : courbe affichée (weight | height | head)
  growthSel: null,      // croissance : mesure pointée sur la courbe
  modulesDraft: null,   // « Gérer les modules » : brouillon tant qu'on n'a pas enregistré
  babyId: null,
  online: navigator.onLine,
  offlineData: false,   // l'écran montre la dernière synchro, pas encore rafraîchie
  syncedAt: null,
  pending: queue.size(),
  listOpen: true,       // accueil : derniers boires dépliés
  range: "week",        // week | 2weeks
  metric: "total",      // total | count | interval | nursing | nursingTime
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
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  share: '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  cloudOff: '<path d="M3 3l18 18"/><path d="M9.5 6.2A6 6 0 0 1 18 11a4 4 0 0 1 2.6 6.4M17 18H7a4 4 0 0 1-.9-7.9"/>',
  cloudUp: '<path d="M7 18a4 4 0 0 1-.9-7.9A6 6 0 0 1 18 11a4 4 0 0 1 0 7"/><path d="M12 20v-8M9 15l3-3 3 3"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  bottle: '<path d="M10.2 5.5v-.9c0-1.3.8-2.4 1.8-2.4s1.8 1.1 1.8 2.4v.9"/><rect x="8.2" y="5.5" width="7.6" height="2.8" rx="1.2"/><path d="M9.2 8.3c-2 .9-3.4 2.7-3.4 4.8V18a3.2 3.2 0 0 0 3.2 3.2h6a3.2 3.2 0 0 0 3.2-3.2v-4.9c0-2.1-1.4-3.9-3.4-4.8"/><path d="M8.3 13.6h2.4M8.3 16.6h2.4"/>',
  baby: '<circle cx="12" cy="13" r="8"/><path d="M9.5 12.5v.01M14.5 12.5v.01"/><path d="M10 16c1.2 1 2.8 1 4 0"/><path d="M12 5c0-1.6 1.6-2.2 2.6-1.2"/>',
  logout: '<path d="M14 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2"/><path d="M9 12h12M18 9l3 3-3 3"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  downArrow: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  equal: '<path d="M6 9h12M6 15h12"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  grip: '<path d="M5 9h14M5 15h14"/>',
  diaper: '<path d="M3 7h18v3a9 9 0 0 1-18 0z"/><path d="M3 10.5c3 .2 5 2.2 5.6 5.6M21 10.5c-3 .2-5 2.2-5.6 5.6"/>',
  ruler: '<rect x="2.5" y="8" width="19" height="8" rx="1.5"/><path d="M6.5 8v3M10.2 8v4M13.8 8v3M17.5 8v4"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.9l-5.3 2.7 1-5.8L3.5 9.7l5.9-.9z"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  breast: '<path d="M6 8c-1.5 2.5-2 5-2 7a8 8 0 0 0 16 0c0-2-.5-4.5-2-7"/><path d="M6 8c2-2.5 4-4 6-4s4 1.5 6 4"/><circle cx="12" cy="15" r="1.8"/>',
  pump: '<path d="M2.8 5.3c-.4-.9.3-1.7 1.2-1.4L9.5 6.2v3.6l-5.5 2.3c-.9.3-1.6-.5-1.2-1.4z"/><path d="M9.5 8h2.5"/><rect x="12" y="6.3" width="9" height="3.4" rx="1.4"/><path d="M13.2 9.7V18a2.8 2.8 0 0 0 2.8 2.8h1a2.8 2.8 0 0 0 2.8-2.8V9.7"/><path d="M13.2 13.5h2M13.2 16.5h2"/>',
  play: '<path d="M8 5.5v13l10-6.5z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  pencil: '<path d="M4 20l4.5-1L19 8.5l-3.5-3.5L5 15.5z"/><path d="M13.5 7l3.5 3.5"/>',
  drop: '<path d="M12 3.5c-2.5 3.2-6 7.3-6 11a6 6 0 0 0 12 0c0-3.7-3.5-7.8-6-11z"/>',
  scale: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M8 12a4 4 0 0 1 8 0"/><path d="M8 12h8"/><path d="M12 12l1.6-2.6"/>',
  height: '<path d="M7 4.5v15"/><path d="M4.5 7L7 4.5 9.5 7M4.5 17L7 19.5 9.5 17"/><path d="M14 6h6M14 10h3.5M14 14h6M14 18h3.5"/>',
  peanut: '<path d="M8.4 3.6a4.3 4.3 0 0 1 4.3 4.3c0 1.1.5 1.9 1.5 2.5a5.3 5.3 0 1 1-7.6 6.2c-.3-1.3-.9-2.1-1.9-2.8A4.3 4.3 0 0 1 8.4 3.6z"/><path d="M8 7.2v.01M10.4 12.4v.01M13 16.6v.01M15.8 13.6v.01"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 7.8v.01"/>',
  alert: '<path d="M12 4.5l8.5 14.5h-17z"/><path d="M12 10.5v3.8M12 16.6v.01"/>',
  head: '<circle cx="12" cy="12" r="7.5"/><path d="M4.5 12c0-1.3 3.4-2.4 7.5-2.4s7.5 1.1 7.5 2.4"/><path d="M4.5 12c0 1.3 3.4 2.4 7.5 2.4s7.5-1.1 7.5-2.4" stroke-dasharray="2 2.2"/>',
};
function icon(name) {
  return `<svg class="ic ic-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
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
const ofBaby = (table) => state[table].filter((r) => r.baby_id === state.babyId);
/** Modules du bébé, dans l'ordre choisi. Un module inconnu de la liste gardée (nouveau) arrive à la fin, actif. */
function moduleList(baby = currentBaby()) {
  const saved = (Array.isArray(baby?.modules) ? baby.modules : []).filter((m) => MODULES[m?.id]);
  const seen = new Set(saved.map((m) => m.id));
  return [...saved.map((m) => ({ id: m.id, on: m.on !== false, bottle: m.bottle !== false })), ...Object.keys(MODULES).filter((id) => !seen.has(id)).map((id) => ({ id, on: true, bottle: true }))];
}
const moduleOn = (id) => moduleList().find((m) => m.id === id)?.on !== false;
/** Le biberon est une sous-option de « Boires » (gardée dans babies.modules), comme l'allaitement (babies.nursing). */
const bottleOn = () => moduleList().find((m) => m.id === "biberon")?.bottle !== false;
const fmtDate = (day, opts = { day: "numeric", month: "short", year: "numeric" }) => fr(parseDay(day), opts);
const todayKey = () => dayKey(new Date());
/** La ligne attend-elle encore dans la file ? La file n'est lue qu'une fois par rendu (les rendus sont synchrones). */
let unsentIds = null;
function isUnsent(id) {
  if (!unsentIds) { unsentIds = new Set(queue.all().map((q) => q.id)); queueMicrotask(() => { unsentIds = null; }); }
  return unsentIds.has(id);
}
const unsentMark = (id) => (isUnsent(id) ? ` <span class="unsent" title="Pas encore envoyé">${icon("cloudUp")}</span>` : "");
/** Lignes regroupées par jour (l'ordre des lignes est gardé). */
function groupRows(rows, col) {
  const groups = new Map();
  for (const r of rows) { const k = dayKey(r[col]); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  return [...groups.values()];
}

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
  el.hidden = !moduleOn("biberon") || (!bottleOn() && !totalLast24h(feeds, now) && !totalToday(feeds, now));
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
  if (state.tab === "settings" && main.contains(document.activeElement) && /^(INPUT|SELECT)$/.test(document.activeElement.tagName)) return;
  if (state.page === "modules" && dragging?.item.isConnected) return;
  const strip = main.querySelector(".polaroids")?.scrollLeft || 0;      // le carrousel reste où le doigt l'a laissé
  main.innerHTML = state.page ? viewPage() : state.tab === "history" ? viewHistory() : state.tab === "settings" ? viewSettings() : viewHome();
  if (strip) { const el = main.querySelector(".polaroids"); if (el) el.scrollLeft = strip; }
}

// ------------------------------------------------------------------ accueil ---
/** Une ligne de boire : heure + type, puis une barre proportionnelle à la quantité. */
function feedRow(f, max) {
  const who = caregiver(f.caregiver_id);
  if (f._nursing) {
    return `
    <button class="feed-row" data-action="edit-nursing" data-id="${f.id}">
      <span class="feed-main">
        <span class="feed-time">${fmtTime(f.started_at)} <span class="feed-kind">Allaitement</span>${who ? ` <span class="meta">· ${esc(who.name)}</span>` : ""}${unsentMark(f.id)}</span>
        <span class="feed-bar-line"><span class="meta">${esc(nursingSummary(f))}${f.last_side ? ` · dernier : ${SIDE[f.last_side].toLowerCase()}` : ""}</span></span>
      </span>
      <span class="chev">${icon("right")}</span>
    </button>`;
  }
  const showKind = enabledKinds().length > 1 || f.kind !== enabledKinds()[0];
  const width = Math.max(8, Math.round((Number(f.amount_ml) / (max || Number(f.amount_ml))) * 100));
  return `
    <button class="feed-row" data-action="edit-feed" data-id="${f.id}">
      <span class="feed-main">
        <span class="feed-time">${fmtTime(f.started_at)}${showKind ? ` <span class="feed-kind">${KIND_SHORT[f.kind]}</span>` : ""}${who ? ` <span class="meta">· ${esc(who.name)}</span>` : ""}${unsentMark(f.id)}</span>
        <span class="feed-bar-line"><span class="feed-bar-zone"><span class="feed-bar ${f.kind}" style="width:${width}%"></span></span>
          <span class="feed-amount">${formatAmount(f.amount_ml, unit())}<small> ${unit()}</small></span></span>
      </span>
      <span class="chev">${icon("right")}</span>
    </button>`;
}
const maxAmount = (list) => Math.max(1, ...list.map((f) => Number(f.amount_ml) || 0));

/** Boires et tétées mêlés, du plus récent au plus ancien (une tétée porte `_nursing`). */
function feedEvents() {
  const nursings = nursingOn() || babyNursings().length ? babyNursings().map((n) => ({ ...n, kind: "allaitement", amount_ml: 0, _nursing: true })) : [];
  return sortDesc([...babyFeeds(), ...nursings]);
}
function homeFeeds() {
  const now = new Date(), baby = currentBaby();
  const events = feedEvents().filter((f) => new Date(f.started_at) <= now);
  const last = events[0] || null;

  let hero;
  if (!last) {
    hero = `<div class="hero"><span class="hero-icon">${icon("drop")}</span>
      <div class="hero-text"><p class="hero-title">Aucun boire noté</p>
      <p class="meta">Touche le « + » pour commencer le suivi de ${esc(baby.name)}.</p></div></div>`;
  } else {
    const elapsed = now - new Date(last.started_at);
    const late = baby.remind_after_min && elapsed >= baby.remind_after_min * 60000;
    const who = caregiver(last.caregiver_id);
    hero = `<div class="hero">
      <span class="hero-icon ${last._nursing ? "" : last.kind}">${icon(last._nursing ? "breast" : "bottle")}</span>
      <div class="hero-text">
        <p class="hero-title">${last._nursing ? "Dernière tétée" : "Dernier boire"}</p>
        <p class="hero-elapsed ${late ? "late" : ""}">${elapsed < 60000 ? "à l'instant" : "il y a " + formatElapsed(elapsed)}</p>
        <p class="meta">${esc([`à ${fmtTime(last.started_at)}`, who ? `par ${who.name}` : ""].filter(Boolean).join(" · "))}</p>
      </div>
      ${last._nursing ? `<p class="hero-nursing">${esc(nursingSummary(last)).replace(" · ", "<br>")}</p>`
    : `<p class="hero-amount">${formatAmount(last.amount_ml, unit())}<small>${unit()}</small></p>`}
    </div>`;
  }

  const recent = events.slice(0, 5), max = maxAmount(recent);
  const open = state.listOpen;
  return `
    <section class="feed-card">
      <div class="feed-band"><h2>Boires</h2>
        <button class="add-btn" data-action="add-feed" aria-label="Ajouter un boire">${icon("plus")}</button></div>
      ${runningRow("nursing", "Allaitement", "choose-nursing")}
      ${hero}
      ${recent.length ? `
        <button class="fold" data-action="toggle-list"><span>${open ? "Afficher moins" : "Afficher les derniers boires"}</span>${icon(open ? "up2" : "down")}</button>
        ${open ? recent.map((f) => feedRow(f, max)).join("") : ""}
        ${open && events.length > 5 ? `<button class="fold more" data-action="tab" data-tab="history"><span>Tout l'historique</span>${icon("right")}</button>` : ""}` : ""}
    </section>`;
}

function viewHome() {
  const blocks = { biberon: homeFeeds, couches: homeDiapers, croissance: homeGrowth, premieres: homeFirsts, tirelait: homePump, allergenes: homeAllergens };
  const on = moduleList().filter((m) => m.on);
  const manage = `<button class="btn ghost block manage-btn" data-action="open-page" data-page="modules">${icon("grip")} Gérer les modules</button>`;
  if (!on.length) return `<div class="empty">Tous les modules sont masqués.</div>${manage}`;
  return on.map((m) => blocks[m.id]()).join("") + manage;
}

// ------------------------------------------------------ accueil : couches ---
const sortBy = (rows, key) => [...rows].sort((a, b) => (a[key] < b[key] ? 1 : a[key] > b[key] ? -1 : (a.created_at < b.created_at ? 1 : -1)));
function diaperLabel(d) {
  const t = [d.wet ? "mouillée" : "", d.dirty ? "sale" : ""].filter(Boolean).join(" et ") || "sèche";
  return capitalize(t);
}
/** Carte d'un module : même gabarit que la carte « Boires » (bandeau, « + » à cheval, contenu, lien). */
function moduleCard(mod, title, addLabel, body, link) {
  return `<section class="feed-card mod-card ${mod}">
      <div class="feed-band"><h2>${title}</h2>
        <button class="add-btn" data-action="add-${mod}" aria-label="${addLabel}">${icon("plus")}</button></div>
      ${body}
      ${link ? `<button class="fold more" data-action="open-page" data-page="${link.page}"><span>${link.label}</span>${icon("right")}</button>` : ""}
    </section>`;
}

function homeDiapers() {
  const now = new Date(), baby = currentBaby();
  const last = sortBy(ofBaby("diapers"), "changed_at").find((d) => new Date(d.changed_at) <= now);
  let hero;
  if (!last) {
    hero = `<div class="hero"><span class="hero-icon">${icon("diaper")}</span>
      <div class="hero-text"><p class="hero-title">Aucune couche notée</p>
      <p class="meta">Touche le « + » au prochain changement de ${esc(baby.name)}.</p></div></div>`;
  } else {
    const elapsed = now - new Date(last.changed_at), who = caregiver(last.caregiver_id);
    hero = `<button class="hero hero-btn" data-action="edit-couches" data-id="${last.id}">
      <span class="hero-icon">${icon("diaper")}</span>
      <div class="hero-text">
        <p class="hero-title">Dernier changement</p>
        <p class="hero-elapsed">${elapsed < 60000 ? "à l'instant" : "il y a " + formatElapsed(elapsed)}</p>
        <p class="meta">${esc([`à ${fmtTime(last.changed_at)}`, who ? `par ${who.name}` : ""].filter(Boolean).join(" · "))}</p>
      </div>
      <p class="hero-tags"><span class="tag">${diaperLabel(last)}</span>${last.rash ? `<span class="tag warn">Érythème</span>` : ""}</p>
    </button>`;
  }
  const today = ofBaby("diapers").filter((d) => dayKey(d.changed_at) === dayKey(now) && new Date(d.changed_at) <= now);
  const wet = today.filter((d) => d.wet).length, dirty = today.filter((d) => d.dirty).length;
  const body = `${hero}${today.length ? `<p class="meta today-line">Aujourd'hui : ${plural(today.length, "couche")} · ${plural(wet, "mouillée")}, ${plural(dirty, "sale")}</p>` : ""}`;
  return moduleCard("couches", "Couches", "Ajouter une couche", body, last ? { page: "diapers", label: "Voir l'historique" } : null);
}

// --------------------------------------------------- accueil : croissance ---
const weightUnit = () => currentBaby()?.weight_unit || "kg";
const lengthUnit = () => currentBaby()?.length_unit || "cm";
function formatMeasure(measure, stored) {
  return measure === "weight" ? formatWeight(Number(stored), weightUnit()) : formatLength(Number(stored), lengthUnit());
}
/** Dernière ligne de croissance qui porte cette mesure. */
function lastMeasure(measure) {
  const col = MEASURES[measure].col;
  return sortBy(ofBaby("growth"), "measured_on").find((g) => g[col] != null) || null;
}
const MEASURE_ICON = { weight: "scale", height: "height", head: "head" };
function homeGrowth() {
  const rows = Object.entries(MEASURES).map(([m, def]) => {
    const g = lastMeasure(m);
    return `<button class="measure-row" data-action="open-page" data-page="growth" data-measure="${m}">
        <span class="measure-icon">${icon(MEASURE_ICON[m])}</span>
        <span class="measure-name">${def.label}</span>
        ${g ? `<span class="measure-val">${formatMeasure(m, g[def.col])}</span><span class="meta">${esc(fmtDate(g.measured_on, { day: "numeric", month: "short" }))}</span>`
    : `<span class="meta">—</span>`}
      </button>`;
  }).join("");
  return moduleCard("croissance", "Croissance", "Ajouter une mesure", `<div class="measure-list">${rows}</div>`, { page: "growth", label: "Voir tout" });
}

// ---------------------------------------------------- accueil : premières ---
function firstBadge(f) {
  const photo = f.has_photo ? photos.get(f.id) : null;
  return photo ? `<span class="hero-icon photo"><img src="${esc(photo)}" alt=""></span>` : `<span class="hero-icon">${icon("star")}</span>`;
}
function firstWhen(f) {
  const baby = currentBaby();
  const age = baby.birth_date && f.happened_on >= baby.birth_date ? ` · ${ageLabel(baby.birth_date, f.happened_on)}` : "";
  return `${fmtDate(f.happened_on)}${age}`;
}
/** Un polaroïd par première, de la plus récente à la plus ancienne, à faire défiler du doigt. */
function homeFirsts() {
  const rows = sortBy(ofBaby("firsts"), "happened_on"), baby = currentBaby();
  const body = rows.length ? `<div class="polaroids">${rows.map((f) => {
    const photo = f.has_photo ? photos.get(f.id) : null;
    return `<button class="polaroid" data-action="edit-premieres" data-id="${f.id}">
        <span class="polaroid-photo">${photo ? `<img src="${esc(photo)}" alt="">` : icon("star")}</span>
        <span class="polaroid-title">${esc(f.title)}</span>
        <span class="meta">${esc(firstWhen(f))}</span>
      </button>`;
  }).join("")}</div>`
    : `<div class="hero"><span class="hero-icon">${icon("star")}</span>
      <div class="hero-text"><p class="hero-title">Aucune première notée</p>
      <p class="meta">Premier sourire, premier bain… touche le « + » pour garder les grands moments de ${esc(baby.name)}.</p></div></div>`;
  return moduleCard("premieres", "Premières de bébé", "Ajouter une première", body, rows.length ? { page: "firsts", label: "Voir tout" } : null);
}

// =============================================================== SOUS-ÉCRANS ===
function viewPage() {
  const p = state.page;
  if (p === "modules") return pageModules();
  if (p === "allergen") return pageAllergen();
  const title = { diapers: "Couches", growth: "Croissance", firsts: "Premières de bébé", pump: "Tire-lait" }[p];
  const body = p === "diapers" ? pageDiapers() : p === "growth" ? pageGrowth() : p === "pump" ? pagePump() : pageFirsts();
  const mod = { diapers: "couches", growth: "croissance", firsts: "premieres", pump: "tirelait" }[p];
  return `<div class="page-head ${mod}">
      <button class="back" data-action="close-page" aria-label="Retour">${icon("left")}</button>
      <h2>${title}</h2>
      <button class="page-add" data-action="add-${mod}" aria-label="Ajouter">${icon("plus")}</button>
    </div>${body}`;
}

function pageDiapers() {
  const now = new Date(), rows = sortBy(ofBaby("diapers"), "changed_at");
  if (!rows.length) return `<div class="empty">Aucune couche notée dans les ${HISTORY_DAYS} derniers jours.</div>`;
  return groupRows(rows, "changed_at").map((list) => {
    const wet = list.filter((d) => d.wet).length, dirty = list.filter((d) => d.dirty).length;
    return `<div class="day-group">
        <div class="day-head"><h3>${esc(capitalize(dayLabel(list[0].changed_at, now)))}</h3>
          <span class="day-total">${plural(list.length, "couche")} <small>· ${plural(wet, "mouillée")}, ${plural(dirty, "sale")}</small></span></div>
        <div class="card list">${list.map((d) => {
    const who = caregiver(d.caregiver_id);
    return `<button class="feed-row" data-action="edit-couches" data-id="${d.id}">
            <span class="feed-main"><span class="feed-time">${fmtTime(d.changed_at)}${who ? ` <span class="meta">· ${esc(who.name)}</span>` : ""}${unsentMark(d.id)}</span></span>
            <span class="hero-tags row-tags"><span class="tag">${diaperLabel(d)}</span>${d.rash ? `<span class="tag warn">Érythème</span>` : ""}</span>
            <span class="chev">${icon("right")}</span></button>`;
  }).join("")}</div>
      </div>`;
  }).join("");
}

function pageFirsts() {
  const rows = sortBy(ofBaby("firsts"), "happened_on");
  if (!rows.length) return `<div class="empty">Aucune première notée pour l'instant.</div>`;
  return `<div class="card list">${rows.map((f) => `
      <button class="feed-row first-row" data-action="edit-premieres" data-id="${f.id}">
        ${firstBadge(f)}
        <span class="feed-main"><span class="feed-time wrap">${esc(f.title)}</span>
          <span class="meta">${esc(firstWhen(f))}</span>
          ${f.note ? `<span class="meta note-preview">${esc(f.note)}</span>` : ""}</span>
        <span class="chev">${icon("right")}</span></button>`).join("")}</div>`;
}

// ------------------------------------------------------ courbe de croissance ---
/** Pas « rond » pour ~n graduations. */
function niceStep(range, n) {
  const raw = range / n, pow = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

/** Points de la mesure, du plus ancien au plus récent : { row, days (âge ou jours depuis la 1re mesure), value }. */
function growthPoints(measure) {
  const baby = currentBaby(), col = MEASURES[measure].col;
  const rows = sortBy(ofBaby("growth"), "measured_on").filter((g) => g[col] != null).reverse();
  const origin = baby.birth_date || rows[0]?.measured_on;
  return rows.map((row) => ({ row, days: ageInDays(origin, row.measured_on), value: Number(row[col]) })).filter((p) => p.days >= 0);
}

function growthChart(measure) {
  const baby = currentBaby(), pts = growthPoints(measure);
  const curvesOk = !!(baby.birth_date && baby.sex);
  if (!pts.length && !curvesOk) return `<div class="empty">Aucune mesure pour l'instant.</div>`;
  const W = 340, H = 250, L = 38, R = 30, T = 12, B = 26;
  const lastDay = pts.length ? pts[pts.length - 1].days : 0;
  const x1 = Math.min(MAX_AGE_DAYS, Math.max(91, Math.ceil((lastDay * 1.2) / 30.4375) * 30.4375));
  const curves = curvesOk ? PERCENTILES.map((p) => ({ p, line: percentileCurve(measure, baby.sex, p, 0, x1) })) : [];
  // Échelle verticale dans l'unité affichée (kg/lb, cm/po), avec des graduations rondes.
  const disp = (v) => (measure === "weight" ? (weightUnit() === "lb" ? v / G_PER_LB : v / 1000) : lengthUnit() === "po" ? v / CM_PER_IN : v);
  const all = [...pts.map((p) => disp(p.value)), ...curves.flatMap((c) => c.line.map((q) => disp(q.value)))];
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
  const step = niceStep(hi - lo, 5);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const X = (d) => L + (d / x1) * (W - L - R), Y = (v) => T + (1 - (disp(v) - lo) / (hi - lo)) * (H - T - B);
  const path = (line) => line.map((q, i) => `${i ? "L" : "M"}${X(q.days).toFixed(1)} ${Y(q.value).toFixed(1)}`).join("");

  let grid = "";
  for (let v = lo; v <= hi + 1e-9; v += step) {
    const y = T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    grid += `<line class="g-grid" x1="${L}" x2="${W - R}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="g-tick" x="${L - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${String(Math.round(v * 100) / 100).replace(".", ",")}</text>`;
  }
  // Axe du temps : en mois d'âge si on connaît la naissance, sinon depuis la première mesure.
  const months = x1 / 30.4375, mStep = months <= 8 ? 1 : months <= 16 ? 2 : months <= 30 ? 3 : months <= 48 ? 6 : 12;
  for (let m = 0; m <= months + 1e-9; m += mStep) {
    const x = X(m * 30.4375);
    grid += `<text class="g-tick" x="${x.toFixed(1)}" y="${H - 8}" text-anchor="middle">${m}${m === 0 ? "" : " m"}</text>`;
  }
  const refs = curves.map((c) => {
    const end = c.line[c.line.length - 1];
    return `<path class="g-ref ${c.p === 50 ? "mid" : ""}" d="${path(c.line)}"/><text class="g-ref-label" x="${W - R + 4}" y="${(Y(end.value) + 3.5).toFixed(1)}">${c.p}</text>`;
  }).join("");
  const sel = pts.find((p) => p.row.id === state.growthSel) || pts[pts.length - 1];
  const dots = pts.map((p) => `<g data-action="growth-point" data-id="${p.row.id}" class="g-hit">
      <circle cx="${X(p.days).toFixed(1)}" cy="${Y(p.value).toFixed(1)}" r="16" fill="transparent"/>
      <circle class="g-dot ${p === sel ? "sel" : ""}" cx="${X(p.days).toFixed(1)}" cy="${Y(p.value).toFixed(1)}" r="${p === sel ? 6.5 : 4.5}"/></g>`).join("");
  const unitLabel = measure === "weight" ? weightUnit() : lengthUnit();

  let readout = "";
  if (sel) {
    const pct = curvesOk ? percentileOf(measure, baby.sex, sel.days, sel.value) : null;
    readout = `<div class="g-readout">
        <div><p class="g-value">${formatMeasure(measure, sel.value)}</p>
          <p class="meta">${esc(fmtDate(sel.row.measured_on))}${baby.birth_date ? ` · ${esc(ageLabel(baby.birth_date, sel.row.measured_on))}` : ""}</p></div>
        ${pct != null ? `<div class="g-pct"><b>${percentileLabel(pct)}</b><span class="meta">percentile</span></div>` : ""}
      </div>`;
  }
  return `${readout}
    <svg class="growth-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Courbe de ${MEASURES[measure].label.toLowerCase()} en ${unitLabel}">
      ${grid}${refs}
      ${pts.length > 1 ? `<path class="g-line" d="${path(pts.map((p) => ({ days: p.days, value: p.value })))}"/>` : ""}
      ${dots}
    </svg>
    <p class="meta center">${MEASURES[measure].label} (${unitLabel}) selon ${baby.birth_date ? "l'âge en mois" : "les mois écoulés depuis la première mesure"}${curvesOk ? ` · percentiles ${PERCENTILES.join(", ")} de l'OMS (${baby.sex === "f" ? "filles" : "garçons"})` : ""}</p>`;
}

function pageGrowth() {
  const baby = currentBaby(), m = state.measure;
  const seg = (k) => `<button class="${m === k ? "on" : ""}" data-action="measure" data-measure="${k}">${MEASURES[k].label}</button>`;
  const rows = sortBy(ofBaby("growth"), "measured_on");
  const missing = [!baby.birth_date ? "la date de naissance" : "", !baby.sex ? "le sexe" : ""].filter(Boolean).join(" et ");
  const cell = (k, g) => (g[MEASURES[k].col] != null ? `<span><small>${MEASURES[k].label}</small><b>${formatMeasure(k, g[MEASURES[k].col])}</b></span>` : "");
  return `
    <div class="segmented green">${seg("weight")}${seg("height")}${seg("head")}</div>
    <section class="card chart-card growth-card">${growthChart(m)}</section>
    ${missing ? `<p class="hint">Ajoute ${missing} de ${esc(baby.name)} dans les <button class="link" data-action="tab" data-tab="settings">Paramètres</button> pour voir les percentiles des courbes de l'OMS (celles du carnet de santé).</p>` : ""}
    <div class="section-head"><h2>Mesures</h2></div>
    ${rows.length ? `<div class="card list">${rows.map((g) => {
    const photo = g.has_photo ? photos.get(g.id) : null;
    return `<button class="feed-row growth-row" data-action="edit-croissance" data-id="${g.id}">
        ${photo ? `<span class="hero-icon photo small"><img src="${esc(photo)}" alt=""></span>` : ""}
        <span class="feed-main"><span class="feed-time">${esc(fmtDate(g.measured_on))}${baby.birth_date && g.measured_on >= baby.birth_date ? ` <span class="meta">· ${esc(ageLabel(baby.birth_date, g.measured_on))}</span>` : ""}</span>
          <span class="growth-cells">${cell("weight", g)}${cell("height", g)}${cell("head", g)}</span>
          ${g.note ? `<span class="meta note-preview">${esc(g.note)}</span>` : ""}</span>
        <span class="chev">${icon("right")}</span></button>`;
  }).join("")}</div>` : `<div class="empty">Aucune mesure pour l'instant. Touche le « + » pour noter la première.</div>`}`;
}

// ------------------------------------------------------- gérer les modules ---
function openModules() {
  state.modulesDraft = { list: moduleList().map((m) => ({ ...m })), kinds: [...enabledKinds()], nursing: nursingOn(), bottle: bottleOn() };
  state.page = "modules"; renderApp(); window.scrollTo(0, 0);
}
function pageModules() {
  const d = state.modulesDraft;
  return `<div class="page-head modules">
      <button class="band-text" data-action="close-page">Annuler</button>
      <h2>Modules</h2>
      <button class="band-text strong" data-action="save-modules">Enregistrer</button>
    </div>
    <p class="meta hint">Glisse une poignée pour changer l'ordre de l'accueil. Un module désactivé disparaît de l'accueil ; ses données sont gardées.</p>
    <div class="mod-list" id="mod-list">${d.list.map((m) => `
      <div class="mod-item ${m.id}" data-id="${m.id}">
        <div class="mod-line">
          <span class="drag-handle" aria-hidden="true">${icon("grip")}</span>
          <span class="mod-dot">${icon(MODULES[m.id].icon)}</span>
          <span class="mod-name">${MODULES[m.id].label}</span>
          <button class="switch-btn" data-action="draft-module" data-id="${m.id}" role="switch" aria-checked="${m.on}" aria-label="${MODULES[m.id].label}"><span class="switch ${m.on ? "on" : ""}"></span></button>
        </div>
        ${m.id === "biberon" ? `<div class="mod-line sub ${m.on ? "" : "off"}">
          <span class="mod-name">Allaitement</span>
          <button class="switch-btn" data-action="draft-nursing" role="switch" aria-checked="${d.nursing}" aria-label="Allaitement"><span class="switch ${d.nursing ? "on" : ""}"></span></button>
        </div>
        <div class="mod-line sub ${m.on ? "" : "off"}">
          <span class="mod-name">Biberon</span>
          <button class="switch-btn" data-action="draft-bottle" role="switch" aria-checked="${d.bottle}" aria-label="Biberon"><span class="switch ${d.bottle ? "on" : ""}"></span></button>
        </div>` + Object.entries(KINDS).map(([k, l]) => `
        <div class="mod-line sub sub2 ${m.on && d.bottle ? "" : "off"}">
          <span class="mod-name">${l}</span>
          <button class="switch-btn" data-action="draft-kind" data-kind="${k}" role="switch" aria-checked="${d.kinds.includes(k)}" aria-label="${l}"><span class="switch ${d.kinds.includes(k) ? "on" : ""}"></span></button>
        </div>`).join("") : ""}
      </div>`).join("")}</div>`;
}

// Glisser-déposer des modules : la ligne suit le doigt, et ce sont ses VOISINES
// qu'on déplace dans la page. Événements tactiles sur iPhone (les événements
// « pointer » y lâchent le doigt de façon imprévisible), souris ailleurs.
let dragging = null;
function startDrag(handle, y) {
  if (!handle || !state.modulesDraft || dragging) return;
  const item = handle.closest(".mod-item");
  dragging = { item, y };
  item.classList.add("dragging");
}
function moveDrag(y) {
  if (!dragging) return;
  const { item } = dragging, gap = 10;
  let dy = y - dragging.y;
  // Un grand geste peut sauter plusieurs voisines d'un coup. Le seuil est la
  // moitié du déplacement d'une permutation (hauteur + espace) : avec un seuil
  // plus petit, monter puis redescendre permutait sans fin (écran figé).
  for (let n = 0; n < 10; n++) {
    const prev = item.previousElementSibling, next = item.nextElementSibling;
    const up = prev && prev.offsetHeight + gap, down = next && next.offsetHeight + gap;
    if (dy < 0 && prev && -dy > up / 2) { item.parentElement.insertBefore(prev, item.nextElementSibling); dragging.y -= up; dy += up; }
    else if (dy > 0 && next && dy > down / 2) { item.parentElement.insertBefore(next, item); dragging.y += down; dy -= down; }
    else break;
  }
  item.style.transform = `translateY(${dy}px)`;
}
function endDrag() {
  if (!dragging) return;
  const { item } = dragging; dragging = null;
  item.classList.remove("dragging"); item.style.transform = "";
  const order = [...document.querySelectorAll("#mod-list .mod-item")].map((el) => el.dataset.id), d = state.modulesDraft;
  if (d) d.list.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}
const dragHandle = (e) => e.target.closest?.(".drag-handle");
document.addEventListener("touchstart", (e) => {
  const h = dragHandle(e); if (!h) return;
  e.preventDefault();                       // pas de défilement ni de sélection pendant le glisser
  startDrag(h, e.touches[0].clientY);
}, { passive: false });
document.addEventListener("touchmove", (e) => { if (dragging) { e.preventDefault(); moveDrag(e.touches[0].clientY); } }, { passive: false });
document.addEventListener("touchend", endDrag);
document.addEventListener("touchcancel", endDrag);
document.addEventListener("mousedown", (e) => { const h = dragHandle(e); if (h) { e.preventDefault(); startDrag(h, e.clientY); } });
document.addEventListener("mousemove", (e) => moveDrag(e.clientY));
document.addEventListener("mouseup", endDrag);
window.addEventListener("blur", endDrag);

function saveModules() {
  const d = state.modulesDraft, boires = d.list.find((m) => m.id === "biberon");
  if (boires?.on && !d.nursing && !d.bottle) { toast("Garde l'allaitement ou le biberon actif"); return; }
  if (boires?.on && d.bottle && !d.kinds.length) { toast("Garde au moins un type de lait actif"); return; }
  const kinds = d.kinds.length ? Object.keys(KINDS).filter((k) => d.kinds.includes(k)) : enabledKinds();
  state.page = null; state.modulesDraft = null;
  updateBaby({ modules: d.list.map(({ id, on }) => (id === "biberon" ? { id, on, bottle: d.bottle } : { id, on })), kinds, nursing: d.nursing }, "Modules enregistrés");
}

// --------------------------------------------------------------- historique ---
function delta(cur, prev) {
  if (cur == null || prev == null || !prev) return `<span class="delta"></span>`;
  const pct = Math.round(((cur - prev) / prev) * 100);
  const ic = pct > 0 ? "up" : pct < 0 ? "downArrow" : "equal";
  return `<span class="delta">${icon(ic)} ${pct === 0 ? "stable" : `${Math.abs(pct)} %`}</span>`;
}
const fmtInterval = (ms) => (ms == null ? "—" : formatElapsed(ms));

/** Les tétées vues comme des boires dont la « quantité » est la durée (s) : les calculs de lib/stats.js servent tels quels. */
const nursingFeeds = () => babyNursings().map((n) => ({ started_at: n.started_at, amount_ml: (n.left_sec || 0) + (n.right_sec || 0) }));
const nursingStats = () => nursingOn() || babyNursings().length > 0;
const bottleStats = () => bottleOn() || babyFeeds().length > 0 || !nursingStats();
function compareCard() {
  const now = new Date();
  const days = state.range === "week" ? 7 : 14;
  const num = (x, f) => (x == null ? "—" : f(x));
  const perDay = (x) => (Math.round(x * 10) / 10).toString().replace(".", ",");
  const tile = (label, value, d) => `<div class="tile"><p class="tile-label">${label}</p><p class="tile-num">${value}</p>${d}</div>`;
  let out = "";
  if (bottleStats()) {
    const { current: a, previous: b } = comparePeriods(babyFeeds(), days, now);
    out += `<section class="tiles">
      ${tile("Volume par jour", num(a.total, amount), delta(a.total, b.total))}
      ${tile("Boires par jour", num(a.count, perDay), delta(a.count, b.count))}
      ${tile("Intervalle moyen", fmtInterval(a.interval), delta(a.interval, b.interval))}
    </section>`;
  }
  if (nursingStats()) {
    const { current: a, previous: b } = comparePeriods(nursingFeeds(), days, now);
    const each = (x) => (x.total == null || !x.count ? null : x.total / x.count);
    out += `<section class="tiles">
      ${tile("Tétées par jour", num(a.count, perDay), delta(a.count, b.count))}
      ${tile("Allaitement par jour", num(a.total, fmtDur), delta(a.total, b.total))}
      ${tile("Durée d'une tétée", num(each(a), fmtDur), delta(each(a), each(b)))}
    </section>`;
  }
  return `${out}
    <p class="meta tiles-note">Moyennes des ${days} derniers jours complets, vs les ${days} jours d'avant.</p>`;
}
function chartCard() {
  const now = new Date();
  const days = state.range === "week" ? 7 : 14;
  const hours = (ms) => (Math.round((ms / 3600000) * 10) / 10).toString().replace(".", ",");
  const METRICS = {
    total: { pill: "Volume", pick: (d) => d.total, label: (d) => (d.total ? formatAmount(d.total, unit()) : ""), caption: `Volume total par jour (${unit()})` },
    count: { pill: "Fréquence", pick: (d) => d.count, label: (d) => (d.count ? String(d.count) : ""), caption: "Nombre de boires par jour" },
    interval: { pill: "Intervalle", pick: (d) => d.avgInterval || 0, label: (d) => (d.avgInterval ? hours(d.avgInterval) : ""), caption: "Intervalle moyen entre deux boires (heures)" },
    nursing: { nursing: true, pill: "Tétées", pick: (d) => d.count, label: (d) => (d.count ? String(d.count) : ""), caption: "Nombre de tétées par jour" },
    nursingTime: { nursing: true, pill: "Durée", pick: (d) => d.total, label: (d) => (d.total ? String(Math.round(d.total / 60)) : ""), caption: "Allaitement par jour (minutes)" },
  };
  // Biberon et allaitement : les trois mesures du biberon + les tétées. Allaitement seul : tétées et durée.
  const shown = [...(bottleStats() ? ["total", "count", "interval"] : []), ...(nursingStats() ? (bottleStats() ? ["nursing"] : ["nursing", "nursingTime"]) : [])];
  const metric = shown.includes(state.metric) ? state.metric : shown[0];
  const m = METRICS[metric];
  const series = dailySeries(m.nursing ? nursingFeeds() : babyFeeds(), days, now);
  const max = Math.max(1, ...series.map(m.pick));
  const bars = series.map((d) => `
    <div class="bar-col ${d.isToday ? "today" : ""}">
      <span class="bar-val">${m.label(d)}</span>
      <span class="bar-track"><span class="bar-fill" style="height:${(m.pick(d) / max) * 100}%"></span></span>
      <span class="bar-x">${days === 7 ? fr(d.date, { weekday: "short" }).replace(".", "") : d.date.getDate()}</span>
    </div>`).join("");
  const pill = (k) => `<button class="pill small ${metric === k ? "on lilac" : ""}" data-action="metric" data-metric="${k}">${METRICS[k].pill}</button>`;
  return `<section class="card chart-card">
      <div class="pillrow">${shown.map(pill).join("")}</div>
      <div class="bars n${days}">${bars}</div>
      <p class="meta center">${m.caption} · aujourd'hui en bleu (journée en cours)</p>
    </section>`;
}
function patternCard() {
  if (!bottleStats()) return "";   // l'horaire type se calcule sur les biberons
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

/** Calendrier de la dernière semaine : une colonne par jour, l'axe des heures
 *  de haut en bas, un trait par boire. Les habitudes (et les nuits) sautent aux yeux.
 *  Lecture seule, à la demande de Maxime : un toucher accidentel ne doit rien ouvrir. */
function weekCalendarCard() {
  const now = new Date(), events = feedEvents();
  const days = Array.from({ length: 7 }, (_, i) => addDays(startOfDay(now), i - 6));
  const minuteOf = (d) => { const x = new Date(d); return x.getHours() * 60 + x.getMinutes(); };
  const pct = (min) => `${(min / 1440) * 100}%`;
  const head = days.map((d, i) => `
    <div class="cal-day ${i === 6 ? "today" : ""}"><span>${esc(fr(d, { weekday: "short" }).replace(".", ""))}</span><b>${d.getDate()}</b></div>`).join("");
  const cols = days.map((d, i) => {
    const key = dayKey(d);
    const marks = events.filter((f) => dayKey(f.started_at) === key).map((f) =>
      `<span class="cal-mark ${f.kind}" style="top:${pct(minuteOf(f.started_at))}" title="${esc(`${fmtTime(f.started_at)}, ${f._nursing ? nursingSummary(f) : amount(f.amount_ml)}`)}"></span>`).join("");
    return `<div class="cal-col ${i === 6 ? "today" : ""}">${marks}${i === 6 ? `<span class="cal-now" style="top:${pct(minuteOf(now))}"></span>` : ""}</div>`;
  }).join("");
  const hours = [0, 3, 6, 9, 12, 15, 18, 21, 24];
  return `<section class="card cal-card">
      <div class="section-head"><h2>La semaine</h2><span class="meta">un trait par boire</span></div>
      <div class="cal-head"><span></span>${head}</div>
      <div class="cal-body">
        <div class="cal-axis">${hours.map((h) => `<span style="top:${pct(h * 60)}">${h} h</span>`).join("")}</div>
        <div class="cal-grid">
          <span class="cal-night" style="top:0;height:${pct(6 * 60)}"></span>
          <span class="cal-night" style="top:${pct(20 * 60)};bottom:0"></span>
          ${hours.slice(1, -1).map((h) => `<span class="cal-line" style="top:${pct(h * 60)}"></span>`).join("")}
          ${cols}
        </div>
      </div>
      ${enabledKinds().length > 1 || babyNursings().length ? `<p class="cal-legend meta"><i class="maternel"></i> Maternel <i class="formule"></i> Formule${babyNursings().length ? `<i class="allaitement"></i> Allaitement` : ""}</p>` : ""}
    </section>`;
}

function lifetimeCard() {
  const t = lifetime(), baby = currentBaby();
  if (!t.count) return "";
  return `<section class="lifetime">
      <span class="lifetime-icon">${icon("bottle")}</span>
      <div><p class="lifetime-label">Tout ce que ${esc(baby.name)} a bu</p>
        <p class="lifetime-num">${lifetimeLabel(t.ml)}</p>
        <p class="meta">${plural(t.count, "boire")}${t.first ? ` depuis le ${fr(new Date(t.first), { day: "numeric", month: "long", year: "numeric" })}` : ""}</p></div>
    </section>`;
}

function viewHistory() {
  const now = new Date();
  const days = state.range === "week" ? 7 : 14;
  const from = addDays(startOfDay(now), -(days - 1)).getTime();
  const groups = groupByDay(feedEvents().filter((f) => new Date(f.started_at).getTime() >= from));
  const seg = (r, l) => `<button class="${state.range === r ? "on" : ""}" data-action="range" data-range="${r}">${l}</button>`;
  const list = groups.length ? groups.map((g) => `
      <div class="day-group">
        <div class="day-head"><h3>${esc(capitalize(dayLabel(g.date, now)))}</h3>
          <span class="day-total">${g.total ? `${amount(g.total)} <small>· ${plural(g.count, "boire")}</small>` : `<small>${plural(g.count, "tétée")}</small>`}</span></div>
        <div class="card list">${g.feeds.map((f) => feedRow(f, maxAmount(g.feeds))).join("")}</div>
      </div>`).join("")
    : `<div class="empty">Aucun boire sur cette période.</div>`;
  return `
    <div class="segmented">${seg("week", "Semaine")}${seg("2weeks", "2 semaines")}</div>
    ${state.range === "week" ? weekCalendarCard() : ""}
    ${compareCard()}
    ${chartCard()}
    ${patternCard()}
    <div class="section-head"><h2>Journal</h2></div>
    ${list}
    ${lifetimeCard()}`;
}

// --------------------------------------------------------------- paramètres ---
function viewSettings() {
  const baby = currentBaby(), mine = me();
  const people = state.caregivers.filter((c) => c.baby_id === baby.id);
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
</div>
      <div class="field"><label>Sexe</label>
        <div class="segmented">
          <button class="${baby.sex === "f" ? "on" : ""}" data-action="set-sex" data-sex="f">Fille</button>
          <button class="${baby.sex === "m" ? "on" : ""}" data-action="set-sex" data-sex="m">Garçon</button>
        </div></div>
      <div class="field"><label for="set-birth">Date de naissance</label>
        <input type="date" id="set-birth" value="${esc(baby.birth_date || "")}" max="${todayKey()}" data-change="set-birth"></div>
      <div class="field"><label>Unités de la croissance</label>
        <div class="segmented">
          <button class="${weightUnit() === "kg" ? "on" : ""}" data-action="set-weight-unit" data-unit="kg">Kilogrammes</button>
          <button class="${weightUnit() === "lb" ? "on" : ""}" data-action="set-weight-unit" data-unit="lb">Livres et onces</button>
        </div>
        <div class="segmented">
          <button class="${lengthUnit() === "cm" ? "on" : ""}" data-action="set-length-unit" data-unit="cm">Centimètres</button>
          <button class="${lengthUnit() === "po" ? "on" : ""}" data-action="set-length-unit" data-unit="po">Pouces</button>
        </div></div>
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
</div>
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
    </section>
    <p class="meta center version">Kenda ${VERSION}${window.KENDA_DEV ? " · DEV" : ""}</p>`;
}

// ------------------------------------------------------ écrans hors de l'app ---
const brand = `<div class="brand"><img class="brand-icon${window.KENDA_DEV ? " dev" : ""}" src="assets/${window.KENDA_DEV ? "icon-dev-512" : "koala"}.png" alt=""><h1>Kenda</h1></div>`;

function viewConfig() {
  return `<div class="center-screen">${brand}
    <p>L'app n'est pas encore reliée à Supabase. Ouvre <b>lib/config.js</b> et colle l'adresse du projet et la clé publique.</p>
    <p class="meta">Les étapes détaillées sont dans le fichier README.</p></div>`;
}

function viewAuth() {
  return `<div class="center-screen">${brand}
    <form id="auth-form" class="stack">
      <div class="field"><label for="auth-email">Courriel</label>
        <input type="email" id="auth-email" name="email" inputmode="email" autocomplete="username" placeholder="nom@exemple.com" required></div>
      <div class="field"><label for="auth-pass">Mot de passe</label>
        <input type="password" id="auth-pass" name="password" autocomplete="current-password" placeholder="••••••••" minlength="6" required></div>
      <p class="form-error" id="auth-error">${esc(state.authError)}</p>
      <p class="form-info" id="auth-info"></p>
      <button type="submit" id="auth-submit" class="btn primary block">Continuer</button>
      <button type="button" id="auth-forgot" class="link center" data-action="forgot">Mot de passe oublié ?</button>
    </form>
    <p class="meta">Première connexion ? Entre ton courriel et un mot de passe pour créer ton compte.</p></div>`;
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
  const timerSheet = state.sheet?.type === "nursing" || state.sheet?.type === "pump";
  state.sheet = null;
  if (timerSheet) renderMain();          // l'accueil montre (ou cache) le minuteur en cours
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
  const t = state.sheet.type;
  const body = t === "feed" ? sheetFeed() : t === "diaper" ? sheetDiaper() : t === "growth" ? sheetGrowth() : t === "first" ? sheetFirst()
    : t === "nursing" ? sheetNursing() : t === "pump" ? sheetPump() : t === "allergen" ? sheetAllergen() : t === "alInfo" ? sheetAllergenInfo() : t === "feedChoice" ? sheetFeedChoice()
    : t === "babies" ? sheetBabies() : sheetNewBaby();
  const form = FORM_SHEETS.has(t);
  el.classList.toggle("form-sheet", form);
  el.classList.remove("wheel-open");          // la roulette est toujours redessinée fermée
  el.className = el.className.replace(/\bmod-\S+/g, "") + (form ? ` mod-${t}` : "");
  el.innerHTML = form ? body : `<div class="grab"></div>${body}`;
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

// Heure de début : UNE roulette jour · heure · minute, comme le sélecteur
// « date et heure » des apps iOS natives. Le web n'y a pas accès (un champ
// datetime-local ouvre un calendrier sur iPhone) : elle est donc faite maison,
// avec le défilement aimanté du navigateur (scroll-snap).
const WHEEL_ITEM = 38;          // hauteur d'un cran, en px (même valeur dans app.css)
const WHEEL_DAYS = 30;
const daysAgo = (d, now = new Date()) => Math.round((startOfDay(now) - startOfDay(d)) / DAY);
/** « Aujourd'hui », « Hier », puis court : « jeu. 17 sept. ». */
function shortDay(d, now = new Date()) {
  const ago = daysAgo(d, now);
  return ago === 0 ? "Aujourd'hui" : ago === 1 ? "Hier" : fr(new Date(d), { weekday: "short", day: "numeric", month: "short" });
}
const timeLabel = (d) => { const x = d || new Date(); return `${shortDay(x)} ${fmtTime(x)}`; };
/** Heure de début de la fiche ouverte : celle choisie, sinon le premier démarrage du minuteur ; null = « maintenant ». */
function sheetStart() {
  const s = state.sheet;
  if (s.time) return s.time;
  const t = !s.id && (s.type === "nursing" || s.type === "pump") ? timerOf(s.type) : null;
  return t?.startedAt ? new Date(t.startedAt) : null;
}
function sheetTimeLabel() {
  const s = state.sheet, d = sheetStart();
  return !d && !s.manual && (s.type === "nursing" || s.type === "pump") ? "Au démarrage" : timeLabel(d);
}

function wheelHtml(when, now) {
  const span = Math.max(WHEEL_DAYS, daysAgo(when, now) + 1);
  const col = (name, items) => `<div class="wheel-col" data-wheel="${name}" role="listbox" aria-label="${name}">${items.map((t) => `<div class="wheel-item">${t}</div>`).join("")}</div>`;
  const two = (n) => String(n).padStart(2, "0");
  return `<div class="wheel" id="wheel" data-span="${span}" hidden>
      <div class="wheel-band"></div>
      ${col("jour", Array.from({ length: span }, (_, i) => esc(shortDay(addDays(now, -(span - 1 - i)), now))))}
      ${col("heure", Array.from({ length: 24 }, (_, i) => String(i)))}
      ${col("minute", Array.from({ length: 60 }, (_, i) => two(i)))}
    </div>`;
}

const wheelCol = (name) => $(`#wheel [data-wheel="${name}"]`);
const wheelIndex = (el) => Math.max(0, Math.min(el.children.length - 1, Math.round(el.scrollTop / WHEEL_ITEM)));

/** Place les trois colonnes sur une date. */
function wheelShow(date, smooth = false) {
  const wheel = $("#wheel"); if (!wheel) return;
  const span = Number(wheel.dataset.span), now = new Date();
  const set = (name, i) => wheelCol(name).scrollTo({ top: i * WHEEL_ITEM, behavior: smooth ? "smooth" : "auto" });
  set("jour", span - 1 - Math.min(span - 1, Math.max(0, daysAgo(date, now))));
  set("heure", date.getHours());
  set("minute", date.getMinutes());
}

/** Lit la roulette (appelé quand le défilement s'arrête). Le futur est refusé : retour à maintenant. */
function wheelRead() {
  const wheel = $("#wheel"), s = state.sheet;
  if (!wheel || wheel.hidden || !["feed", "diaper", "nursing", "pump", "allergen"].includes(s?.type)) return;
  const span = Number(wheel.dataset.span), now = new Date();
  const d = addDays(startOfDay(now), -(span - 1 - wheelIndex(wheelCol("jour"))));
  d.setHours(wheelIndex(wheelCol("heure")), wheelIndex(wheelCol("minute")), 0, 0);
  if (d > now) { s.time = null; wheelShow(sheetStart() || now, true); }
  else s.time = d;
  $("#feed-time-label").textContent = sheetTimeLabel();
}

function toggleWheel() {
  const wheel = $("#wheel"); if (!wheel) return;
  const open = wheel.hidden;
  if (open) document.activeElement?.blur?.();          // range le clavier numérique
  wheel.hidden = !open;
  $("#feed-when-row").classList.toggle("open", open);
  $("#sheet")?.classList.toggle("wheel-open", open);
  if (open) wheelShow(sheetStart() || new Date());
}

let wheelTimer = null;
document.addEventListener("scroll", (e) => {
  if (!e.target?.dataset?.wheel) return;
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(wheelRead, 120);
}, true);

function sheetFeed() {
  const s = state.sheet, u = unit(), kinds = enabledKinds();
  const showKinds = kinds.length > 1 || !kinds.includes(s.kind);
  const kindList = showKinds ? [...new Set([...kinds, s.kind])] : [];
  const now = new Date();
  const existing = s.id ? state.feeds.find((f) => f.id === s.id) : null;
  const last = lastFeed(babyFeeds(), now);

  const when = s.time || now;

  // Passation : si l'autre parent vient tout juste de noter un boire, on le dit.
  let warn = "";
  if (!s.id && last && now - new Date(last.started_at) < 20 * 60000) {
    const who = caregiver(last.caregiver_id);
    warn = `<p class="sheet-warn">${icon("clock")} Un boire de ${amount(last.amount_ml)} a déjà été noté à ${fmtTime(last.started_at)}${who ? ` par ${esc(who.name)}` : ""}.</p>`;
  }
  return `
    ${sheetBand(s.id ? "Modifier le boire" : "Ajouter un boire")}
    ${warn}
    <button class="form-row" id="feed-when-row" data-action="toggle-wheel" aria-label="Changer l'heure de début">
      <span class="row-label">Heure de début</span>
      <span class="row-value" id="feed-time-label">${esc(timeLabel(s.time))}</span>
    </button>
    ${wheelHtml(when, now)}
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
    ${deleteFoot(s, "ce boire")}`;
}

/** Quantité retapée telle quelle à la modification : on garde les ml d'origine (pas d'aller-retour oz → ml). */
const sameOrNew = (ml, before) => (before != null && formatAmount(before, unit()) === formatAmount(ml, unit()) ? Number(before) : ml);

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
  const feed = {
    id: s.id || uuid(),
    baby_id: state.babyId,
    kind: s.kind,
    amount_ml: sameOrNew(ml, existing?.amount_ml),
    started_at: when.toISOString(),
    caregiver_id: existing ? existing.caregiver_id : me()?.id || null,
    deleted_at: null,
  };
  commitFeed(feed);
  closeSheet();
  toast(s.id ? "Boire modifié" : `Boire ajouté · ${amount(feed.amount_ml)}`, { kind: "ok" });
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

// ------------------------------------------------ fiches des autres modules ---
// Même gabarit que la fiche « boire » : bandeau aux couleurs du module, une
// ligne par champ. La photo (facultative) est réduite sur l'appareil ; dans la
// fiche, `photo` vaut undefined (inchangée), null (retirée) ou l'image.
const FORM_SHEETS = new Set(["feed", "diaper", "growth", "first", "nursing", "pump", "allergen"]);
const sheetBand = (title) => `<div class="sheet-band">
      <button class="band-btn" data-action="close-sheet" aria-label="Fermer">${icon("x")}</button>
      <h2>${title}</h2>
      <button class="band-save" data-action="save-sheet" aria-label="Enregistrer">${icon("check")}</button>
    </div>`;
const dateRow = (value) => `<label class="form-row">
      <span class="row-label">Date</span>
      <input type="date" id="sheet-date" class="row-input date" value="${esc(value)}" max="${todayKey()}" required>
    </label>`;
const noteRow = (value) => `<label class="form-row tall">
      <span class="row-label">Note</span>
      <textarea id="sheet-note" class="row-input" rows="2" placeholder="Ajouter" maxlength="2000">${esc(value || "")}</textarea>
    </label>`;
const sheetPhoto = (s) => (s.photo === undefined ? (s.id && s.hasPhoto ? photos.get(s.id) : null) : s.photo);
function photoRow(s) {
  const cur = sheetPhoto(s);
  return `<div class="form-row">
      <span class="row-label">Photo</span>
      <span class="row-photo">
        ${cur ? `<img src="${esc(cur)}" alt="" class="photo-thumb">` : ""}
        <label class="btn-outline">${cur ? "Changer" : "Ajouter"}<input type="file" accept="image/*" data-change="sheet-photo" aria-label="Choisir une photo"></label>
        ${cur ? `<button class="link" data-action="sheet-photo-remove">Retirer</button>` : ""}
      </span>
    </div>`;
}
const deleteFoot = (s, what) => (s.id ? `<div class="sheet-foot"><button class="btn ghost danger" data-action="delete-sheet">${icon("trash")} ${s.confirmDelete ? "Toucher encore pour supprimer" : `Supprimer ${what}`}</button></div>` : "");

function openDiaperSheet(row) {
  openSheet({ type: "diaper", id: row?.id || null, time: row ? new Date(row.changed_at) : null,
    wet: row ? !!row.wet : true, dirty: row ? !!row.dirty : false, rash: row ? !!row.rash : false, confirmDelete: false });
}
function sheetDiaper() {
  const s = state.sheet, now = new Date();
  const pill = (k, l) => `<button class="pill small couches ${s[k] ? "on" : ""}" data-action="diaper-flag" data-flag="${k}" aria-pressed="${s[k]}">${l}</button>`;
  return `${sheetBand(s.id ? "Modifier la couche" : "Ajouter une couche")}
    <button class="form-row" id="feed-when-row" data-action="toggle-wheel" aria-label="Changer l'heure">
      <span class="row-label">Heure</span>
      <span class="row-value" id="feed-time-label">${esc(timeLabel(s.time))}</span>
    </button>
    ${wheelHtml(s.time || now, now)}
    <div class="form-row">
      <span class="row-label">Type</span>
      <span class="pillrow tight">${pill("wet", "Mouillée")}${pill("dirty", "Sale")}</span>
    </div>
    <button class="form-row" data-action="diaper-flag" data-flag="rash" role="switch" aria-checked="${s.rash}">
      <span class="row-label">Érythème fessier</span>
      <span class="switch ${s.rash ? "on" : ""}"></span>
    </button>
    ${deleteFoot(s, "cette couche")}`;
}
function saveDiaper() {
  const s = state.sheet, when = s.time || new Date();
  if (when.getTime() > Date.now() + 2 * 60000) { toast("L'heure est dans le futur"); return; }
  const existing = s.id ? state.diapers.find((d) => d.id === s.id) : null;
  commitRow("diapers", {
    id: s.id || uuid(), baby_id: state.babyId, wet: s.wet, dirty: s.dirty, rash: s.rash,
    changed_at: when.toISOString(), caregiver_id: existing ? existing.caregiver_id : me()?.id || null, deleted_at: null,
  });
  closeSheet();
  toast(s.id ? "Couche modifiée" : "Couche ajoutée", { kind: "ok" });
}

function openGrowthSheet(row) {
  const wu = weightUnit();
  const s = { type: "growth", id: row?.id || null, date: row?.measured_on || todayKey(), note: row?.note || "",
    hasPhoto: !!row?.has_photo, photo: undefined, confirmDelete: false,
    weight: "", weightOz: "", height: "", head: "" };
  if (row?.weight_g != null) {
    if (wu === "lb") { const { lb, oz } = gToLbOz(Number(row.weight_g)); s.weight = String(lb); s.weightOz = String(oz).replace(".", ","); }
    else s.weight = String(Math.round(Number(row.weight_g)) / 1000).replace(".", ",");
  }
  if (row?.height_cm != null) s.height = String(cmToLength(Number(row.height_cm), lengthUnit())).replace(".", ",");
  if (row?.head_cm != null) s.head = String(cmToLength(Number(row.head_cm), lengthUnit())).replace(".", ",");
  openSheet(s);
}
function sheetGrowth() {
  const s = state.sheet, wu = weightUnit(), lu = lengthUnit();
  const num = (id, value, unitLabel, width = 90) => `<span class="row-amount"><input type="text" id="${id}" inputmode="decimal" autocomplete="off" placeholder="Ajouter" value="${esc(value)}" data-input="growth" style="width:${width}px" aria-label="${unitLabel}"><small>${unitLabel}</small></span>`;
  return `${sheetBand(s.id ? "Modifier les mesures" : "Ajouter une mesure")}
    ${dateRow(s.date)}
    <label class="form-row"><span class="row-label">Poids</span>
      ${wu === "lb" ? `<span class="row-amount pair">${num("g-weight", s.weight, "lb", 60)}${num("g-weight-oz", s.weightOz, "oz", 60)}</span>` : num("g-weight", s.weight, "kg")}</label>
    <label class="form-row"><span class="row-label">Taille</span>${num("g-height", s.height, lu)}</label>
    <label class="form-row"><span class="row-label">Tour de tête</span>${num("g-head", s.head, lu)}</label>
    ${noteRow(s.note)}
    ${photoRow(s)}
    ${deleteFoot(s, "ces mesures")}`;
}
const numVal = (id) => { const v = parseFloat(($(`#${id}`)?.value || "").replace(",", ".")); return Number.isFinite(v) && v > 0 ? v : null; };
function saveGrowth() {
  const s = state.sheet, wu = weightUnit(), lu = lengthUnit();
  const date = $("#sheet-date")?.value;
  if (!date || date > todayKey()) { toast("Choisis une date passée ou aujourd'hui"); return; }
  let weight_g = null;
  if (wu === "lb") { const lb = numVal("g-weight") ?? 0, oz = numVal("g-weight-oz") ?? 0; if (lb || oz) weight_g = lbOzToG(lb, oz); }
  else if (numVal("g-weight") != null) weight_g = Math.round(numVal("g-weight") * 1000);
  const height_cm = numVal("g-height") != null ? lengthToCm(numVal("g-height"), lu) : null;
  const head_cm = numVal("g-head") != null ? lengthToCm(numVal("g-head"), lu) : null;
  if (weight_g == null && height_cm == null && head_cm == null) { toast("Entre au moins une mesure"); return; }
  if (weight_g > 60000 || height_cm > 200 || head_cm > 100) { toast("Une mesure semble trop grande"); return; }
  const existing = s.id ? state.growth.find((g) => g.id === s.id) : null;
  const row = { id: s.id || uuid(), baby_id: state.babyId, measured_on: date, weight_g, height_cm, head_cm,
    note: $("#sheet-note")?.value.trim() || null, caregiver_id: existing ? existing.caregiver_id : me()?.id || null, deleted_at: null };
  if (s.photo !== undefined) row.photo = s.photo;
  commitRow("growth", row);
  state.growthSel = row.id;
  closeSheet();
  toast(s.id ? "Mesures modifiées" : "Mesure ajoutée", { kind: "ok" });
}

function openFirstSheet(row) {
  openSheet({ type: "first", id: row?.id || null, date: row?.happened_on || todayKey(), title: row?.title || "", note: row?.note || "",
    hasPhoto: !!row?.has_photo, photo: undefined, confirmDelete: false });
  if (!row) $("#sheet-title")?.focus({ preventScroll: true });
}
function sheetFirst() {
  const s = state.sheet;
  return `${sheetBand(s.id ? "Modifier la première" : "Ajouter une première")}
    ${dateRow(s.date)}
    <label class="form-row tall">
      <span class="row-label">Première</span>
      <input type="text" id="sheet-title" class="row-input" placeholder="Ajouter" value="${esc(s.title)}" maxlength="120" autocomplete="off" enterkeyhint="done">
    </label>
    ${noteRow(s.note)}
    ${photoRow(s)}
    ${deleteFoot(s, "cette première")}`;
}
function saveFirst() {
  const s = state.sheet, date = $("#sheet-date")?.value, title = $("#sheet-title")?.value.trim();
  if (!title) { toast("Donne un titre à cette première"); $("#sheet-title")?.focus(); return; }
  if (!date || date > todayKey()) { toast("Choisis une date passée ou aujourd'hui"); return; }
  const existing = s.id ? state.firsts.find((f) => f.id === s.id) : null;
  const row = { id: s.id || uuid(), baby_id: state.babyId, happened_on: date, title, note: $("#sheet-note")?.value.trim() || null,
    caregiver_id: existing ? existing.caregiver_id : me()?.id || null, deleted_at: null };
  if (s.photo !== undefined) row.photo = s.photo;
  commitRow("firsts", row);
  closeSheet();
  toast(s.id ? "Première modifiée" : "Première ajoutée", { kind: "ok" });
}

/** Enregistrer / supprimer selon la fiche ouverte. */
function saveSheet() {
  const t = state.sheet?.type;
  if (t === "feed") return saveFeed();
  if (t === "diaper") return saveDiaper();
  if (t === "growth") return saveGrowth();
  if (t === "first") return saveFirst();
  if (t === "nursing") return saveNursing();
  if (t === "pump") return savePump();
  if (t === "allergen") return saveAllergen();
}
function deleteSheet() {
  const s = state.sheet;
  if (!s.confirmDelete) {
    s.confirmDelete = true;
    $('[data-action="delete-sheet"]').innerHTML = `${icon("trash")} Toucher encore pour supprimer`;
    return;
  }
  const table = { feed: "feeds", diaper: "diapers", growth: "growth", first: "firsts", nursing: "nursings", pump: "pumpings", allergen: "allergen_exposures" }[s.type];
  const existing = state[table].find((r) => r.id === s.id);
  const gone = existing && { ...existing, deleted_at: new Date().toISOString() };
  if (gone) { if (table === "feeds") commitFeed(gone); else commitRow(table, gone); }
  closeSheet();
  toast(table === "feeds" ? "Boire supprimé" : "Supprimé");
}

/** Écrit une ligne d'un module : à l'écran et sur l'appareil tout de suite, vers
 *  Supabase dès que possible (même file que les boires). La photo ne va ni dans
 *  l'état ni dans l'instantané : elle part dans la file, et reste dans le cache. */
function commitRow(table, row) {
  const { has_photo, ...payload } = row;
  payload.updated_at = new Date().toISOString();
  // Photo inchangée : une version encore dans la file peut en porter une ; on la garde.
  const queued = queue.all().find((q) => q.id === row.id);
  if (!("photo" in payload) && queued && "photo" in queued) payload.photo = queued.photo;
  const { photo, ...local } = payload;
  if ("photo" in payload) { local.has_photo = !!photo; if (photo) photos.set(row.id, payload.updated_at, photo); else photos.remove(row.id); }
  else local.has_photo = !!(state[table].find((r) => r.id === row.id)?.has_photo ?? has_photo);
  if (local.deleted_at) photos.remove(row.id);
  else if (local.has_photo && photos.get(row.id)) photos.set(row.id, payload.updated_at, photos.get(row.id));   // même version que la ligne
  state[table] = state[table].filter((r) => r.id !== row.id);
  if (!local.deleted_at) state[table].push(local);
  queue.push({ ...payload, _t: table });
  state.pending = queue.size();
  saveSnapshot();
  renderMain(); renderBanner();
  flushQueue();
}

/** Réduit une image sur l'appareil, en JPEG « data: ». Photo d'une fiche : entière, 640 px de côté
 *  au plus (≈ 60 Ko). Photo du bébé (`square`) : recadrée au centre, 256 px (≈ 15 Ko) — elle est
 *  gardée avec le bébé et suit donc la synchro et le mode hors ligne. */
function shrinkPhoto(file, { size = 640, square = false, quality = 0.8 } = {}) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight, side = Math.min(w, h), k = Math.min(1, size / Math.max(w, h));
      const c = document.createElement("canvas");
      c.width = square ? size : Math.round(w * k); c.height = square ? size : Math.round(h * k);
      if (square) c.getContext("2d").drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
      else c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image illisible")); };
    img.src = url;
  });
}

/** Les photos manquantes ou périmées des lignes chargées, par paquets de 8. */
let loadingPhotos = false;
async function loadPhotos() {
  if (loadingPhotos) return;
  loadingPhotos = true;
  try {
    for (const table of ["growth", "firsts", "allergen_exposures"]) {
      const want = state[table].filter((r) => r.has_photo && Date.parse(photos.version(r.id) || 0) !== Date.parse(r.updated_at)).map((r) => r.id);
      for (let i = 0; i < want.length; i += 8) {
        const { data, error } = await supabase.from(table).select("id,photo,updated_at").in("id", want.slice(i, i + 8));
        if (error) return;
        for (const r of data) if (r.photo) photos.set(r.id, r.updated_at, r.photo);
        if (state.view === "app") renderMain();
      }
    }
  } finally { loadingPhotos = false; }
}

// ------------------------------------------------- allaitement & tire-lait ---
// Minuteurs persistants (lib/store.js timerMemory) : ils tournent même quand la
// fiche est fermée ou le téléphone verrouillé, et l'accueil montre « en cours ».
const nursingOn = () => currentBaby()?.nursing !== false;
const babyNursings = () => ofBaby("nursings");
const babyPumpings = () => ofBaby("pumpings");
/** Secondes accumulées sur un côté, minuteur en marche compris. */
const timerSeconds = (t, side) => (t?.sides?.[side] || 0) + (t?.running === side ? Math.max(0, Math.floor((Date.now() - t.since) / 1000)) : 0);
const timerOf = (kind) => { const t = timerMemory.get(kind); return t && t.babyId === state.babyId ? t : null; };
function timerToggle(kind, side) {
  const t = timerOf(kind) || { babyId: state.babyId, startedAt: null, sides: {}, running: null, since: 0, lastSide: null };
  if (t.running === side) { t.sides[side] = timerSeconds(t, side); t.running = null; }
  else {
    if (t.running) t.sides[t.running] = timerSeconds(t, t.running);
    t.running = side; t.since = Date.now(); t.lastSide = side;
    t.startedAt ||= new Date().toISOString();
  }
  timerMemory.set(kind, t);
  return t;
}
/** « 12:05 » pour un minuteur qui tourne. */
const fmtClock = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
/** « 12 min », « 1 h 05 », « 45 s » pour une durée gardée. */
function fmtDur(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return `${sec} s`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}
const SIDE = { left: "Gauche", right: "Droit" };
const nursingSummary = (n) => [n.left_sec ? `G ${fmtDur(n.left_sec)}` : "", n.right_sec ? `D ${fmtDur(n.right_sec)}` : ""].filter(Boolean).join(" · ") || "0 min";

/** Bandeau « en cours » sous le bandeau d'une carte, quand un minuteur tourne ou est en pause. */
function runningRow(kind, label, action) {
  const t = timerOf(kind); if (!t) return "";
  const sides = kind === "nursing" ? ["left", "right"] : ["all"];
  const parts = sides.map((s) => `${kind === "nursing" ? SIDE[s].charAt(0) + " " : ""}<b data-timer="${kind}:${s}">${fmtClock(timerSeconds(t, s))}</b>`).join(" · ");
  return `<button class="running-row" data-action="${action}"><span class="dot ${t.running ? "live" : ""}"></span><span>${label}${t.running ? " en cours" : " en pause"}</span><span class="running-time">${parts}</span>${icon("right")}</button>`;
}
// L'horloge des minuteurs : une fois par seconde, seulement les chiffres.
setInterval(() => {
  for (const el of document.querySelectorAll("[data-timer]")) {
    const [kind, side] = el.dataset.timer.split(":"), t = timerOf(kind);
    if (t) el.textContent = fmtClock(timerSeconds(t, side));
  }
}, 1000);

// ---- petit choix : allaitement ou biberon
function sheetFeedChoice() {
  return `<h2>Ajouter un boire</h2>
    <div class="choice-list">
      <button class="choice" data-action="choose-nursing"><span class="kind-dot maternel">${icon("breast")}</span><span>Allaitement</span></button>
      <button class="choice" data-action="choose-bottle"><span class="kind-dot formule">${icon("bottle")}</span><span>Biberon</span></button>
    </div>`;
}

// ---- fiche allaitement
function openNursingSheet(row) {
  const t = row ? null : timerOf("nursing");
  openSheet({ type: "nursing", id: row?.id || null, time: row ? new Date(row.started_at) : null, manual: !!row,
    left: row ? Math.round(row.left_sec / 60) : 0, right: row ? Math.round(row.right_sec / 60) : 0,
    lastSide: row?.last_side || t?.lastSide || null, confirmDelete: false });
}
function sheetNursing() {
  const s = state.sheet, now = new Date(), t = s.id ? null : timerOf("nursing");
  const prev = sortBy(babyNursings(), "started_at").find((n) => n.id !== s.id);
  const lastSide = s.id ? prev?.last_side : (t?.lastSide ? null : prev?.last_side);   // « dernier sein » de la tétée d'avant
  const side = (k) => {
    const running = t?.running === k, sec = t ? timerSeconds(t, k) : 0;
    return `<div class="side ${running ? "live" : ""}">
        <span class="last-side ${lastSide === k ? "" : "hidden"}">dernier sein</span>
        ${s.manual ? `<span class="row-amount"><input type="text" id="n-${k}" inputmode="numeric" autocomplete="off" value="${s[k] || ""}" placeholder="0" aria-label="${SIDE[k]}, minutes"><small>min</small></span>`
    : `<span class="timer" data-timer="nursing:${k}">${fmtClock(sec)}</span>`}
        <span class="side-name">${SIDE[k]}</span>
        ${s.manual ? "" : `<button class="btn-outline" data-action="nursing-toggle" data-side="${k}">${running ? `${icon("pause")} Pause` : sec ? `${icon("play")} Reprendre` : `${icon("play")} Démarrer`}</button>`}
      </div>`;
  };
  return `${sheetBand(s.id ? "Modifier la tétée" : "Allaitement")}
    <div class="sides">${side("left")}${side("right")}</div>
    ${s.manual ? "" : `<button class="link center small" data-action="nursing-manual">${icon("pencil")} Entrer les minutes à la main</button>`}
    <button class="form-row" id="feed-when-row" data-action="toggle-wheel" aria-label="Changer l'heure de début">
      <span class="row-label">Heure de début</span>
      <span class="row-value" id="feed-time-label">${esc(sheetTimeLabel())}</span>
    </button>
    ${wheelHtml(sheetStart() || now, now)}
    ${s.manual ? `<div class="form-row"><span class="row-label">Dernier sein</span>
      <span class="pillrow tight">${["left", "right"].map((k) => `<button class="pill small maternel ${s.lastSide === k ? "on" : ""}" data-action="nursing-last" data-side="${k}">${SIDE[k]}</button>`).join("")}</span></div>` : ""}
    ${s.id ? deleteFoot(s, "cette tétée") : t ? `<div class="sheet-foot"><button class="btn ghost danger" data-action="nursing-abandon">${icon("trash")} Abandonner cette tétée</button></div>` : ""}`;
}
function saveNursing() {
  const s = state.sheet, t = s.id ? null : timerOf("nursing");
  const existing = s.id ? state.nursings.find((n) => n.id === s.id) : null;
  // Minutes laissées telles quelles à la modification : on garde les secondes d'origine.
  const secs = (id, before) => { const m = numVal(id) || 0; return before != null && m === Math.round(before / 60) ? before : m * 60; };
  let left, right, lastSide = s.lastSide;
  if (s.manual) { left = secs("n-left", existing?.left_sec); right = secs("n-right", existing?.right_sec); }
  else { left = timerSeconds(t, "left"); right = timerSeconds(t, "right"); lastSide = t?.lastSide || null; }
  if (!left && !right) { toast("Démarre un côté, ou entre les minutes"); return; }
  if (!lastSide) lastSide = right ? "right" : "left";
  const when = sheetStart() || new Date();
  if (when.getTime() > Date.now() + 2 * 60000) { toast("L'heure est dans le futur"); return; }
  commitRow("nursings", { id: s.id || uuid(), baby_id: state.babyId, started_at: when.toISOString(), left_sec: Math.round(left), right_sec: Math.round(right),
    last_side: lastSide, caregiver_id: existing ? existing.caregiver_id : me()?.id || null, deleted_at: null });
  if (!s.id) timerMemory.clear("nursing");
  closeSheet();
  toast(s.id ? "Tétée modifiée" : "Tétée ajoutée", { kind: "ok" });
}

// ---- tire-lait
function homePump() {
  const now = new Date(), baby = currentBaby();
  const last = sortBy(babyPumpings(), "started_at").find((p) => new Date(p.started_at) <= now);
  const today = babyPumpings().filter((p) => dayKey(p.started_at) === dayKey(now)).reduce((a, p) => a + Number(p.amount_ml), 0);
  let hero;
  if (!last) {
    hero = `<div class="hero"><span class="hero-icon">${icon("pump")}</span>
      <div class="hero-text"><p class="hero-title">Aucune séance notée</p>
      <p class="meta">Touche le « + » à la prochaine séance de tire-lait.</p></div></div>`;
  } else {
    const elapsed = now - new Date(last.started_at), who = caregiver(last.caregiver_id);
    hero = `<button class="hero hero-btn" data-action="edit-tirelait" data-id="${last.id}">
      <span class="hero-icon">${icon("pump")}</span>
      <div class="hero-text">
        <p class="hero-title">Dernière séance</p>
        <p class="hero-elapsed">${elapsed < 60000 ? "à l'instant" : "il y a " + formatElapsed(elapsed)}</p>
        <p class="meta">${esc([`à ${fmtTime(last.started_at)}`, last.duration_sec ? fmtDur(last.duration_sec) : "", who ? `par ${who.name}` : ""].filter(Boolean).join(" · "))}</p>
      </div>
      <p class="hero-amount">${formatAmount(last.amount_ml, unit())}<small>${unit()}</small></p>
    </button>`;
  }
  const body = `${runningRow("pump", "Séance", "add-tirelait")}${hero}${today ? `<p class="meta today-line">Aujourd'hui : ${amount(today)}</p>` : ""}`;
  return moduleCard("tirelait", "Tire-lait", "Ajouter une séance", body, last ? { page: "pump", label: "Voir l'historique" } : null);
}
function pagePump() {
  const now = new Date(), rows = sortBy(babyPumpings(), "started_at");
  if (!rows.length) return `<div class="empty">Aucune séance notée dans les ${HISTORY_DAYS} derniers jours.</div>`;
  return groupRows(rows, "started_at").map((list) => `<div class="day-group">
      <div class="day-head"><h3>${esc(capitalize(dayLabel(list[0].started_at, now)))}</h3>
        <span class="day-total">${amount(list.reduce((a, p) => a + Number(p.amount_ml), 0))} <small>· ${plural(list.length, "séance")}</small></span></div>
      <div class="card list">${list.map((p) => {
    const who = caregiver(p.caregiver_id);
    const sides = p.left_ml != null || p.right_ml != null ? `G ${formatAmount(p.left_ml || 0, unit())} · D ${formatAmount(p.right_ml || 0, unit())}` : "";
    return `<button class="feed-row" data-action="edit-tirelait" data-id="${p.id}">
        <span class="feed-main"><span class="feed-time">${fmtTime(p.started_at)}${who ? ` <span class="meta">· ${esc(who.name)}</span>` : ""}${unsentMark(p.id)}</span>
          <span class="meta">${esc([p.duration_sec ? fmtDur(p.duration_sec) : "", sides].filter(Boolean).join(" · "))}</span></span>
        <span class="feed-amount">${formatAmount(p.amount_ml, unit())}<small> ${unit()}</small></span>
        <span class="chev">${icon("right")}</span></button>`;
  }).join("")}</div></div>`).join("");
}
function openPumpSheet(row) {
  const u = unit(), f = (ml) => (ml == null ? "" : formatAmount(ml, u));
  openSheet({ type: "pump", id: row?.id || null, mode: row ? (row.left_ml != null || row.right_ml != null ? "sides" : "total") : "sides",
    time: row ? new Date(row.started_at) : null, manual: !!row, minutes: row ? Math.round(row.duration_sec / 60) : 0,
    left: f(row?.left_ml), right: f(row?.right_ml), total: row ? f(row.amount_ml) : "", confirmDelete: false });
}
function sheetPump() {
  const s = state.sheet, u = unit(), now = new Date(), t = s.id ? null : timerOf("pump");
  const running = t?.running === "all", sec = t ? timerSeconds(t, "all") : 0;
  const num = (id, value, label) => `<span class="row-amount"><input type="text" id="${id}" inputmode="${u === "oz" ? "decimal" : "numeric"}" autocomplete="off" placeholder="Ajouter" value="${esc(value)}" data-input="pump-amount" aria-label="${label}"><small>${u}</small></span>`;
  return `${sheetBand(s.id ? "Modifier la séance" : "Tire-lait")}
    <div class="segmented rose in-sheet">
      <button class="${s.mode === "sides" ? "on" : ""}" data-action="pump-mode" data-mode="sides">Gauche / Droite</button>
      <button class="${s.mode === "total" ? "on" : ""}" data-action="pump-mode" data-mode="total">Total</button>
    </div>
    <div class="sides one">
      ${s.manual ? `<div class="side"><span class="row-amount"><input type="text" id="p-minutes" inputmode="numeric" autocomplete="off" value="${s.minutes || ""}" placeholder="0" aria-label="Durée, minutes"><small>min</small></span><span class="side-name">Durée</span></div>`
    : `<div class="side ${running ? "live" : ""}"><span class="timer" data-timer="pump:all">${fmtClock(sec)}</span>
        <button class="btn-outline" data-action="pump-toggle">${running ? `${icon("pause")} Pause` : sec ? `${icon("play")} Reprendre` : `${icon("play")} Démarrer`}</button></div>
      <button class="link center small" data-action="pump-manual">${icon("pencil")} Entrer la durée à la main</button>`}
    </div>
    <button class="form-row" id="feed-when-row" data-action="toggle-wheel" aria-label="Changer l'heure de début">
      <span class="row-label">Heure de début</span>
      <span class="row-value" id="feed-time-label">${esc(sheetTimeLabel())}</span>
    </button>
    ${wheelHtml(sheetStart() || now, now)}
    ${s.mode === "sides" ? `<label class="form-row"><span class="row-label">Quantité gauche</span>${num("p-left", s.left, "gauche")}</label>
    <label class="form-row"><span class="row-label">Quantité droite</span>${num("p-right", s.right, "droite")}</label>
    <div class="form-row total-row"><span class="row-label">Total</span><span class="row-value" id="pump-total">${pumpTotalLabel()}</span></div>`
    : `<label class="form-row"><span class="row-label">Quantité totale</span>${num("p-total", s.total, "total")}</label>`}
    ${s.id ? deleteFoot(s, "cette séance") : t ? `<div class="sheet-foot"><button class="btn ghost danger" data-action="pump-abandon">${icon("trash")} Abandonner cette séance</button></div>` : ""}`;
}
function pumpTotalLabel() {
  const s = state.sheet, v = (x) => parseFloat(String(x || "").replace(",", ".")) || 0;
  const l = $("#p-left") ? v($("#p-left").value) : v(s.left), r = $("#p-right") ? v($("#p-right").value) : v(s.right);
  return `${(Math.round((l + r) * 10) / 10).toString().replace(".", ",")} ${unit()}`;
}
function savePump() {
  const s = state.sheet, u = unit(), t = s.id ? null : timerOf("pump");
  const existing = s.id ? state.pumpings.find((p) => p.id === s.id) : null;
  const minutes = numVal("p-minutes") || 0;
  // Durée et quantités laissées telles quelles à la modification : on garde les valeurs d'origine.
  const duration = !s.manual ? (t ? timerSeconds(t, "all") : 0)
    : existing && minutes === Math.round(existing.duration_sec / 60) ? existing.duration_sec : minutes * 60;
  let left_ml = null, right_ml = null, amount_ml;
  if (s.mode === "sides") {
    const l = numVal("p-left"), r = numVal("p-right");
    if (l == null && r == null) { toast("Entre une quantité"); return; }
    left_ml = sameOrNew(fromUnit(l || 0, u), existing?.left_ml); right_ml = sameOrNew(fromUnit(r || 0, u), existing?.right_ml); amount_ml = Math.round((left_ml + right_ml) * 10) / 10;
  } else {
    const tot = numVal("p-total");
    if (tot == null) { toast("Entre une quantité"); return; }
    amount_ml = sameOrNew(fromUnit(tot, u), existing?.amount_ml);
  }
  if (amount_ml > 2000 || left_ml > 1000 || right_ml > 1000) { toast("Quantité trop grande"); return; }
  const when = sheetStart() || new Date();
  if (when.getTime() > Date.now() + 2 * 60000) { toast("L'heure est dans le futur"); return; }
  commitRow("pumpings", { id: s.id || uuid(), baby_id: state.babyId, started_at: when.toISOString(), duration_sec: Math.round(duration), amount_ml, left_ml, right_ml,
    caregiver_id: existing ? existing.caregiver_id : me()?.id || null, deleted_at: null });
  if (!s.id) timerMemory.clear("pump");
  closeSheet();
  toast(s.id ? "Séance modifiée" : `Séance ajoutée · ${amount(amount_ml)}`, { kind: "ok" });
}

// --------------------------------------------------------------- allergènes ---
// Introduction des allergènes prioritaires (guide d'Allergies Québec, avril 2024).
// Une seule sorte d'entrée, l'« exposition » ; l'état de chaque allergène en est
// déduit ici, jamais gardé en base. Noix, poissons et fruits de mer s'introduisent
// une variété à la fois : leurs clés sont « famille:variété » (« noix:cajou »).
const AL_TOLERATED = 3;       // expositions sans réaction avant de dire « toléré »
const AL_WEEK = 7;            // à redonner au moins une fois par semaine
const ALLERGENS = [
  { id: "arachide", label: "Arachide" },
  { id: "oeuf", label: "Œuf" },
  { id: "lait", label: "Lait", full: "Lait de vache" },
  { id: "ble", label: "Blé" },
  { id: "soya", label: "Soya" },
  { id: "sesame", label: "Sésame" },
  { id: "moutarde", label: "Moutarde" },
  { id: "noix", label: "Noix", kinds: { amande: "Amande", cajou: "Cajou", noisette: "Noisette", pacane: "Pacane", pistache: "Pistache", grenoble: "Grenoble" } },
  { id: "poisson", label: "Poisson", kinds: { saumon: "Saumon", truite: "Truite", morue: "Morue", thon: "Thon", aiglefin: "Aiglefin" } },
  { id: "fruitsdemer", label: "Fruits de mer", kinds: { crevette: "Crevette", homard: "Homard", crabe: "Crabe", petoncle: "Pétoncle" } },
];
const REACTIONS = { none: "Aucune", mild: "Légère", severe: "Importante" };
const SYMPTOMS = { urticaire: "Urticaire", vomissement: "Vomissement", comportement: "Comportement", respiration: "Toux / respiration", enflure: "Enflure lèvres-gorge", autre: "Autre" };
const alDef = (key) => ALLERGENS.find((a) => a.id === String(key).split(":")[0]) || null;
function alLabel(key, full = false) {
  const [, kind] = String(key).split(":"), def = alDef(key);
  if (kind) return def?.kinds?.[kind] || capitalize(kind);
  return def ? (full && def.full) || def.label : capitalize(String(key));
}

/** L'état de chaque clé, en rejouant les expositions de la plus vieille à la plus
 *  récente. Une réaction est imputée à ce qui n'était pas encore toléré ce jour-là
 *  (le beurre d'arachide, pas la rôtie) ; si tout l'était, à tout. Une réaction reste marquée.
 *  Partout, une réaction légère est jaune et une importante rouge (classes sev-mild / sev-severe). */
function allergenStats(exceptId = null) {
  const stats = new Map(), now = new Date();
  const get = (key) => { if (!stats.has(key)) stats.set(key, { key, count: 0, reaction: null, last: null, rows: [] }); return stats.get(key); };
  const rows = sortBy(ofBaby("allergen_exposures"), "given_at").reverse();
  for (const e of rows) {
    if (e.id === exceptId || new Date(e.given_at) > now) continue;
    const keys = (e.allergens || []).filter(Boolean), bad = e.reaction && e.reaction !== "none";
    const suspects = bad ? keys.filter((k) => alStatus(stats.get(k)) !== "ok") : [];
    for (const k of keys) {
      const st = get(k);
      // On garde la pire réaction (à gravité égale, la plus récente) : c'est elle qui colore la pastille.
      if (bad && (!suspects.length || suspects.includes(k))) { if (e.reaction === "severe" || st.reaction?.reaction !== "severe") st.reaction = e; }
      else st.count++;
      st.last = e.given_at; st.rows.unshift(e);
    }
  }
  return stats;
}
const alStatus = (st) => (!st ? "new" : st.reaction ? "reaction" : st.count >= AL_TOLERATED ? "ok" : st.count ? "trying" : "new");
const familyStats = (def, stats) => [...stats.values()].filter((st) => st.key.startsWith(def.id + ":"));

/** Pastille : pointillé (pas introduit), chiffre (en cours), crochet (toléré), triangle (réaction).
 *  Pour une famille : la variété la plus avancée, et le nombre de variétés tolérées en coin. */
function alBadge(def, stats) {
  if (!def.kinds) { const st = stats.get(def.id), status = alStatus(st); return { status, count: st?.count || 0, extra: 0, sev: st?.reaction?.reaction }; }
  const kinds = familyStats(def, stats), ok = kinds.filter((st) => alStatus(st) === "ok").length;
  const status = kinds.some((st) => st.reaction) ? "reaction" : ok ? "ok" : kinds.some((st) => st.count) ? "trying" : "new";
  const sev = kinds.some((st) => st.reaction?.reaction === "severe") ? "severe" : "mild";
  return { status, count: Math.max(0, ...kinds.map((st) => st.count)), extra: ok > 1 ? ok : 0, sev };
}
function alDot(b) {
  const inner = b.status === "ok" ? icon("check") : b.status === "reaction" ? icon("alert") : b.status === "trying" ? b.count : "";
  return `<b class="al-dot ${b.status} ${b.status === "reaction" ? `sev-${b.sev || "severe"}` : ""}">${inner}${b.extra ? `<i>${b.extra}</i>` : ""}</b>`;
}
const agoDays = (n) => (n <= 0 ? "aujourd'hui" : n === 1 ? "hier" : `il y a ${n} jours`);

function homeAllergens() {
  const stats = allergenStats(), now = new Date();
  const grid = ALLERGENS.map((def) => `<button class="al" data-action="open-allergen" data-key="${def.id}">${alDot(alBadge(def, stats))}<span>${def.label}</span></button>`).join("");
  // « À redonner » : les tolérés que bébé n'a pas mangés depuis plus d'une semaine (le guide demande
  // au moins une fois par semaine). Un constat, pas un rappel ; rien à montrer quand tout est à jour.
  const due = [...stats.values()].filter((st) => alStatus(st) === "ok" && daysAgo(new Date(st.last), now) > AL_WEEK).sort((a, b) => (a.last < b.last ? -1 : 1));
  const line = due.length ? `<div class="al-due"><p class="al-due-title">À redonner</p><div class="al-due-list">${due.map((st) => `<button class="al-due-chip" data-action="open-allergen" data-key="${esc(st.key.split(":")[0])}">${esc(alLabel(st.key))}<small>${daysAgo(new Date(st.last), now)} j</small></button>`).join("")}</div></div>` : "";
  const title = `Allergènes<button class="info-btn" data-action="al-info" aria-label="Comment utiliser ce module">${icon("info")}</button>`;
  return moduleCard("allergenes", title, "Ajouter un allergène", `<div class="al-grid home">${grid}</div>${line}`, null);
}

function exposureRow(e, def, stats) {
  const bad = e.reaction && e.reaction !== "none", who = caregiver(e.caregiver_id), photo = e.has_photo ? photos.get(e.id) : null;
  // La réaction de cette entrée est-elle imputée à cet allergène-ci (et non à un autre de la même bouchée) ?
  const blamed = bad && [...stats.values()].some((st) => st.reaction?.id === e.id && alDef(st.key)?.id === def.id);
  const labels = def.kinds || (e.allergens || []).length > 1 ? e.allergens.map((k) => alLabel(k)).join(", ") : "";
  const sub = [bad ? [REACTIONS[e.reaction], ...(e.symptoms || []).map((x) => SYMPTOMS[x] || x)].join(" · ") : "", labels, e.food || ""].filter(Boolean);
  return `<button class="feed-row al-row" data-action="edit-allergenes" data-id="${e.id}">
      <i class="al-mark ${blamed ? `bad sev-${e.reaction}` : ""}"></i>
      <span class="feed-main"><span class="feed-time">${esc(fr(new Date(e.given_at), { day: "numeric", month: "short" }))} · ${fmtTime(e.given_at)}${who ? ` <span class="meta">· ${esc(who.name)}</span>` : ""}${unsentMark(e.id)}</span>
        ${sub.length ? `<span class="meta ${blamed ? `bad sev-${e.reaction}` : ""}">${esc(sub.join(" · "))}</span>` : ""}</span>
      ${photo ? `<img src="${esc(photo)}" alt="" class="photo-thumb">` : ""}
      <span class="chev">${icon("right")}</span></button>`;
}

/** Détail d'un allergène : son état, ses variétés (familles), puis ses expositions. */
function pageAllergen() {
  const def = alDef(state.allergen) || ALLERGENS[0], stats = allergenStats(), now = new Date();
  const banner = (st) => {
    const status = alStatus(st);
    if (status === "reaction") return `<p class="al-state bad sev-${st.reaction.reaction}">Réaction ${st.reaction.reaction === "severe" ? "importante" : "légère"} · ${esc(fr(new Date(st.reaction.given_at), { day: "numeric", month: "short" }))}</p>`;
    if (status === "ok") return `<p class="al-state">Toléré · ${st.count} fois · ${agoDays(daysAgo(new Date(st.last), now))}</p>`;
    if (status === "trying") return `<p class="al-state soft">${st.count} sur ${AL_TOLERATED}</p>`;
    return "";
  };
  let top, rows;
  if (def.kinds) {
    const kinds = familyStats(def, stats).sort((a, b) => (a.last < b.last ? 1 : -1));
    top = kinds.length ? `<div class="card list al-kinds">${kinds.map((st) => `<div class="al-kind">${alDot({ status: alStatus(st), count: st.count, extra: 0, sev: st.reaction?.reaction })}
        <span class="al-kind-name">${esc(alLabel(st.key))}</span><span class="meta">${agoDays(daysAgo(new Date(st.last), now))}</span></div>`).join("")}</div>` : "";
    const seen = new Set(); rows = [];
    for (const st of kinds) for (const e of st.rows) if (!seen.has(e.id)) { seen.add(e.id); rows.push(e); }
    rows = sortBy(rows, "given_at");
  } else {
    top = banner(stats.get(def.id));
    rows = stats.get(def.id)?.rows || [];
  }
  return `<div class="page-head allergenes">
      <button class="back" data-action="close-page" aria-label="Retour">${icon("left")}</button>
      <h2>${def.full || def.label}</h2>
      <button class="page-add" data-action="add-allergenes" aria-label="Ajouter">${icon("plus")}</button>
    </div>${top}
    ${rows.length ? `<div class="card list">${rows.map((e) => exposureRow(e, def, stats)).join("")}</div>` : `<div class="empty">Pas encore introduit.</div>`}`;
}

/** Le « i » du bloc : le mode d'emploi, sur demande seulement (rien d'expliqué dans l'interface elle-même). */
function sheetAllergenInfo() {
  const dot = (status, count = 0, sev) => alDot({ status, count, extra: 0, sev });
  const item = (d, title, text) => `<div class="al-help">${d}<p><b>${title}</b>${text}</p></div>`;
  return `<h2>Allergènes</h2>
    ${item(dot("new"), "Pas encore introduit", "")}
    ${item(dot("trying", 2), "En cours", ` — le chiffre compte les fois données sans réaction.`)}
    ${item(dot("ok"), "Toléré", ` — ${AL_TOLERATED} fois sans réaction. Continue d'en donner chaque semaine.`)}
    ${item(dot("reaction", 0, "mild") + dot("reaction", 0, "severe"), "Réaction", ` — jaune : légère, rouge : importante. Reste marqué. Cesse cet aliment, continue les autres, parles-en au médecin.`)}
    <ul class="al-help-list">
      <li><b>Un nouveau à la fois.</b> Une entrée contient un seul allergène pas encore toléré ; les tolérés peuvent s'y ajouter (beurre d'arachide sur une rôtie).</li>
      <li><b>Noix, poisson, fruits de mer.</b> Chaque variété s'introduit séparément : touche la famille, puis la variété.</li>
      <li><b>Aliment.</b> Ce que bébé a mangé (yogourt, tofu…). Facultatif.</li>
      <li><b>Réaction plus tard ?</b> Rouvre l'entrée et change la réaction. Symptômes et photo serviront au médecin.</li>
      <li><b>À redonner.</b> Les tolérés que bébé n'a pas mangés depuis plus de ${AL_WEEK} jours, avec le nombre de jours. Pour garder la tolérance, vise au moins une fois par semaine.</li>
    </ul>
    <p class="meta">D'après le guide d'Allergies Québec (2024). Kenda ne remplace pas un avis médical.</p>`;
}

function openAllergenSheet(row, preset = null) {
  const def = preset ? alDef(preset) : null;
  const keys = row ? [...(row.allergens || [])] : def && !def.kinds ? [def.id] : [];
  const fam = def?.kinds ? def.id : keys.map((k) => k.split(":")).find((x) => x[1])?.[0] || null;
  openSheet({ type: "allergen", id: row?.id || null, time: row ? new Date(row.given_at) : null, keys, family: fam, custom: false,
    food: row?.food || "", reaction: row?.reaction || "none", symptoms: [...(row?.symptoms || [])],
    hasPhoto: !!row?.has_photo, photo: undefined, confirmDelete: false });
}
/** La fiche se redessine à chaque choix ; la roulette se referme avec elle. */
function redrawAllergen(toEnd = false) {
  const x = $(".al-kinds-row")?.scrollLeft || 0;
  renderSheetKeep();
  const row = $(".al-kinds-row"); if (row) row.scrollLeft = toEnd ? row.scrollWidth : x;      // la rangée des variétés reste où elle était
}

/** Au plus UN allergène pas encore toléré par entrée (une réaction reste attribuable) ; les tolérés se combinent. */
function allergenPick(key) {
  const s = state.sheet, def = alDef(key);
  if (def?.kinds && !key.includes(":")) { s.family = s.family === key ? null : key; s.custom = false; redrawAllergen(); const row = $(".al-kinds-row"); if (row) row.scrollLeft = 0; return; }
  s.keys = s.keys.includes(key) ? s.keys.filter((k) => k !== key) : [...s.keys, key];
  redrawAllergen();
}
function allergenCustom() {
  const s = state.sheet, name = ($("#al-custom")?.value || "").trim().toLowerCase().replace(/[:,]/g, " ").replace(/\s+/g, " ").slice(0, 30);
  s.custom = false;
  if (name && s.family) {
    const known = Object.entries(alDef(s.family).kinds).find(([, l]) => l.toLowerCase() === name)?.[0];
    const key = `${s.family}:${known || name}`;
    if (!s.keys.includes(key)) s.keys = [...s.keys, key];
  }
  redrawAllergen(true);
}

function sheetAllergen() {
  const s = state.sheet, now = new Date(), stats = allergenStats(s.id);
  const isNew = (k) => alStatus(stats.get(k)) !== "ok";
  const blocked = s.keys.some(isNew);           // un non-toléré est déjà choisi : les autres non-tolérés attendent
  const off = (k) => !s.keys.includes(k) && blocked && isNew(k);
  const grid = ALLERGENS.map((def) => {
    const on = def.kinds ? s.keys.some((k) => k.startsWith(def.id + ":")) : s.keys.includes(def.id);
    return `<button class="al ${on ? "sel" : ""} ${def.kinds && s.family === def.id ? "open" : ""} ${!def.kinds && off(def.id) ? "off" : ""}" data-action="al-pick" data-key="${def.id}" aria-pressed="${on}">${alDot(alBadge(def, stats))}<span>${def.label}</span></button>`;
  }).join("");
  const fam = s.family ? alDef(s.family) : null;
  let kinds = "";
  if (fam && s.custom) {
    kinds = `<input type="text" id="al-custom" class="al-custom" placeholder="Nom" maxlength="30" autocomplete="off" autocapitalize="off" enterkeyhint="done">
      <button class="pill small mint on" data-action="al-custom-ok">OK</button>`;
  } else if (fam) {
    // Les variétés déjà données d'abord (la rangée défile), puis les suggestions ; l'ordre ne change pas quand on en touche une.
    const keys = [...new Set([...familyStats(fam, stats).map((st) => st.key), ...Object.keys(fam.kinds).map((k) => `${fam.id}:${k}`), ...s.keys.filter((k) => k.startsWith(fam.id + ":"))])];
    kinds = keys.map((k) => `<button class="pill small mint ${s.keys.includes(k) ? "on" : ""} ${alStatus(stats.get(k))} sev-${stats.get(k)?.reaction?.reaction || "none"} ${off(k) ? "off" : ""}" data-action="al-pick" data-key="${esc(k)}" aria-pressed="${s.keys.includes(k)}">${esc(alLabel(k))}</button>`).join("")
      + `<button class="pill small" data-action="al-custom">Autre…</button>`;
  }
  const bad = s.reaction !== "none";
  const cur = sheetPhoto(s);
  return `${sheetBand(s.id ? "Modifier" : "Allergène")}
    <div class="al-grid">${grid}</div>
    <div class="al-kinds-row ${fam ? "" : "hidden"}">${kinds}</div>
    <button class="form-row" id="feed-when-row" data-action="toggle-wheel" aria-label="Changer l'heure">
      <span class="row-label">Heure</span>
      <span class="row-value" id="feed-time-label">${esc(timeLabel(s.time))}</span>
    </button>
    ${wheelHtml(s.time || now, now)}
    <label class="form-row">
      <span class="row-label">Aliment</span>
      <input type="text" id="al-food" class="row-input" placeholder="Ajouter" value="${esc(s.food)}" maxlength="120" autocomplete="off" enterkeyhint="done">
    </label>
    <p class="row-label al-seg-label">Réaction</p>
    <div class="segmented in-sheet mint">${Object.entries(REACTIONS).map(([k, l]) => `<button class="${s.reaction === k ? "on" : ""} r-${k}" data-action="al-reaction" data-reaction="${k}">${l}</button>`).join("")}</div>
    <div class="al-symptoms sev-${s.reaction} ${bad ? "" : "hidden"}">
      ${Object.entries(SYMPTOMS).map(([k, l]) => `<button class="pill small rosy ${s.symptoms.includes(k) ? "on" : ""}" data-action="al-symptom" data-symptom="${k}" aria-pressed="${s.symptoms.includes(k)}">${l}</button>`).join("")}
      <label class="pill small rosy photo ${cur ? "on" : ""}">${icon("camera")} Photo<input type="file" accept="image/*" data-change="sheet-photo" aria-label="Choisir une photo"></label>
      ${cur ? `<button class="pill small" data-action="sheet-photo-remove">Retirer la photo</button>` : ""}
    </div>
    ${deleteFoot(s, "cette entrée")}`;
}
function saveAllergen() {
  const s = state.sheet, when = s.time || new Date();
  if (!s.keys.length) { toast(s.family ? "Choisis une variété" : "Choisis un allergène"); return; }
  if (when.getTime() > Date.now() + 2 * 60000) { toast("L'heure est dans le futur"); return; }
  const bad = s.reaction !== "none";
  const existing = s.id ? state.allergen_exposures.find((r) => r.id === s.id) : null;
  const row = { id: s.id || uuid(), baby_id: state.babyId, given_at: when.toISOString(), allergens: s.keys, food: $("#al-food")?.value.trim() || null,
    reaction: s.reaction, symptoms: bad ? s.symptoms : [], caregiver_id: existing ? existing.caregiver_id : me()?.id || null, deleted_at: null };
  if (!bad && (s.hasPhoto || s.photo)) row.photo = null;          // plus de réaction : plus de photo
  else if (s.photo !== undefined) row.photo = s.photo;
  commitRow("allergen_exposures", row);
  closeSheet();
  toast(s.id ? "Entrée modifiée" : s.keys.map((k) => alLabel(k)).join(", "), { kind: "ok" });
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
    feeds: state.feeds, diapers: state.diapers, growth: state.growth, firsts: state.firsts,
    nursings: state.nursings, pumpings: state.pumpings, allergen_exposures: state.allergen_exposures, older: state.older, syncedAt: state.syncedAt,
  });
}

/** Affiche les données de la dernière synchro. Faux s'il n'y en a pas pour ce compte. */
function showSnapshot() {
  const snap = snapshot.load();
  if (!snap || !state.user || snap.userId !== state.user.id || !snap.babies?.length) return false;
  state.babies = snap.babies; state.caregivers = snap.caregivers || [];
  state.feeds = applyQueue(snap.feeds || []);
  state.diapers = applyQueue(snap.diapers || [], "diapers");
  state.growth = stripPhotos(applyQueue(snap.growth || [], "growth"));
  state.firsts = stripPhotos(applyQueue(snap.firsts || [], "firsts"));
  state.nursings = applyQueue(snap.nursings || [], "nursings");
  state.pumpings = stripPhotos(applyQueue(snap.pumpings || [], "pumpings"));
  state.allergen_exposures = stripPhotos(applyQueue(snap.allergen_exposures || [], "allergen_exposures"));
  state.older = snap.older || {};
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

/** Une entrée de la file peut porter une photo : elle va dans le cache, pas dans l'état. */
function stripPhotos(rows) {
  return rows.map((r) => {
    if (!("photo" in r)) return r;
    const { photo, ...rest } = r;
    if (photo) photos.set(r.id, r.updated_at, photo);
    return { ...rest, has_photo: !!photo };
  });
}

async function fetchFeeds(since, table = "feeds", timeCol = "started_at", cols = "*") {
  const all = [];
  for (let page = 0; page < 6; page++) {       // Supabase rend 1000 lignes à la fois
    const { data, error } = await supabase.from(table).select(cols)
      .is("deleted_at", null).gte(timeCol, since)
      .order(timeCol, { ascending: false }).range(page * 1000, page * 1000 + 999);
    // Table d'un module pas encore créée (schema.sql pas repassé) : l'app reste utilisable, le module est vide.
    if (error && table !== "feeds" && /^(42P01|PGRST205)$/.test(String(error.code))) { console.warn(`table ${table} absente`, error.message); return []; }
    if (error) throw error;
    all.push(...data);
    if (data.length < 1000) break;
  }
  return all;
}

/** Total « depuis le début » : l'app ne charge que les derniers jours, donc la
 *  base additionne ce qui est plus vieux (RPC baby_totals) et l'app y ajoute les
 *  boires qu'elle a en main — le compteur bouge ainsi tout de suite, même hors
 *  ligne. Si la fonction n'existe pas encore dans la base, on garde l'ancien total. */
async function fetchOlderTotals(before) {
  const { data, error } = await supabase.rpc("baby_totals", { p_before: before });
  if (error) { console.warn("baby_totals", error.message); return null; }
  return Object.fromEntries((data || []).map((r) => [r.baby_id, { ml: Number(r.total_ml) || 0, count: Number(r.feeds) || 0, first: r.first_at }]));
}
function lifetime(babyId = state.babyId) {
  const older = state.older?.[babyId] || { ml: 0, count: 0, first: null };
  const mine = state.feeds.filter((f) => f.baby_id === babyId);
  const firstLocal = mine.length ? mine.reduce((a, f) => (f.started_at < a ? f.started_at : a), mine[0].started_at) : null;
  return {
    ml: older.ml + mine.reduce((t, f) => t + Number(f.amount_ml), 0),
    count: older.count + mine.length,
    first: older.first || firstLocal,
  };
}
/** « 12 345 ml » ; au-delà de 10 L on ajoute les litres. En oz : « 417 oz ». */
function lifetimeLabel(ml) {
  const group = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
  if (unit() === "oz") return `${group(Math.round(ml / ML_PER_OZ))} oz`;
  return `${group(Math.round(ml))} ml${ml >= 10000 ? ` · ${(Math.round(ml / 100) / 10).toString().replace(".", ",")} L` : ""}`;
}

let loading = null;
function loadAll(preferBabyId = null) {
  loading ||= (async () => {
    try {
      const since = new Date(Date.now() - HISTORY_DAYS * DAY).toISOString();
      const [b, c, feeds, older, diapers, growth, firsts, nursings, pumpings, exposures] = await Promise.all([
        supabase.from("babies").select("*").order("created_at"),
        supabase.from("caregivers").select("*").order("created_at"),
        fetchFeeds(since),
        fetchOlderTotals(since),
        fetchFeeds(since, "diapers", "changed_at"),
        fetchFeeds("1900-01-01", "growth", "measured_on", GROWTH_COLS),
        fetchFeeds("1900-01-01", "firsts", "happened_on", FIRSTS_COLS),
        fetchFeeds(since, "nursings"),
        fetchFeeds(since, "pumpings", "started_at", PUMP_COLS),
        fetchFeeds("1900-01-01", "allergen_exposures", "given_at", ALLERGEN_COLS),   // tout l'historique : l'état d'un allergène en dépend
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
      state.diapers = applyQueue(diapers, "diapers");
      state.growth = stripPhotos(applyQueue(growth, "growth"));
      state.firsts = stripPhotos(applyQueue(firsts, "firsts"));
      state.nursings = applyQueue(nursings, "nursings");
      state.pumpings = stripPhotos(applyQueue(pumpings, "pumpings"));
      state.allergen_exposures = stripPhotos(applyQueue(exposures, "allergen_exposures"));
      if (older) state.older = older;
      state.syncedAt = Date.now();
      state.offlineData = false; state.online = true;
      chooseBaby(preferBabyId);
      saveSnapshot();
      subscribeRealtime();
      if (state.view !== "app") render("app"); else { refreshHeader(); renderMain(); renderBanner(); }
      flushQueue();
      loadPhotos();
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

function onRowChange(table, payload) {
  if (payload.eventType === "DELETE") { scheduleReload(); return; }
  const row = payload.new;
  if (!row?.id) { scheduleReload(); return; }
  const pending = queue.all().find((q) => q.id === row.id);
  if (pending && Date.parse(pending.updated_at) > Date.parse(row.updated_at)) return;   // notre version est plus récente
  state[table] = state[table].filter((f) => f.id !== row.id);
  if (!row.deleted_at) state[table].push(row);
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
    .on("postgres_changes", { event: "*", schema: "public", table: "feeds" }, (p) => onRowChange("feeds", p))
    .on("postgres_changes", { event: "*", schema: "public", table: "diapers" }, (p) => onRowChange("diapers", p))
    .on("postgres_changes", { event: "*", schema: "public", table: "growth" }, scheduleReload)   // la photo n'est pas dans l'événement
    .on("postgres_changes", { event: "*", schema: "public", table: "firsts" }, scheduleReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "nursings" }, (p) => onRowChange("nursings", p))
    .on("postgres_changes", { event: "*", schema: "public", table: "pumpings" }, scheduleReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "allergen_exposures" }, scheduleReload)
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
      const { _t, ...row } = item;
      try { res = await supabase.from(_t || "feeds").upsert(row, { onConflict: "id" }); }
      catch (e) { res = { error: e }; }
      if (res.error) {
        if (!isFinalRefusal(res.error)) { state.online = false; break; }
        queue.remove(item); dropped = true;
        toast(`Une saisie n'a pas pu être enregistrée (${res.error.code}).`, { ms: 6000 });
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

/** « 2 boires » si la file n'a que des boires, sinon « 3 saisies ». */
function pendingLabel() {
  const all = queue.all();
  return plural(all.length, all.every((q) => !q._t || q._t === "feeds") ? "boire" : "saisie");
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
    html = `${icon("cloudOff")}<span>Hors ligne${since}${n ? ` · ${pendingLabel()} à envoyer` : ""}</span>`;
  } else if (n) html = `${icon("cloudUp")}<span>Envoi de ${pendingLabel()}…</span>`;
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

let joining = false;
async function createOrJoinBaby(join) {
  if (joining) return;
  joining = true;
  try { await createOrJoinBabyOnce(join); } finally { joining = false; }
}
async function createOrJoinBabyOnce(join) {
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
  if (state.pending && !confirm(`${pendingLabel()} pas encore envoyé${state.pending > 1 ? "s" : ""} : perdu si tu te déconnectes. Continuer quand même ?`)) return;
  if (state.channel) { supabase.removeChannel(state.channel); state.channel = null; }
  await supabase.auth.signOut();
  resetToSignedOut();
}

function resetToSignedOut() {
  snapshot.clear(); queue.clear(); photos.clear();
  timerMemory.clear("nursing"); timerMemory.clear("pump");
  Object.assign(state, { user: null, babies: [], caregivers: [], feeds: [], diapers: [], growth: [], firsts: [], nursings: [], pumpings: [], allergen_exposures: [], older: {}, babyId: null, pending: 0, offlineData: false, syncedAt: null, tab: "home", page: null, modulesDraft: null });
  if (state.sheet) closeSheet();
  render("auth");
}

// Hors ligne on peut tout faire sur les boires ; ce qui touche au compte, aux
// bébés et aux réglages partagés attend le réseau.
const ONLINE_ONLY = new Set(["remove-photo", "create-baby", "join-baby", "save-baby-name", "set-unit", "save-my-name", "forgot", "save-modules", "set-sex", "set-weight-unit", "set-length-unit"]);
const isOffline = () => !navigator.onLine || !state.online;
const offlineToast = () => toast("Hors ligne — possible dès que le réseau revient", { ms: 3200 });

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const a = btn.dataset.action;
  if (ONLINE_ONLY.has(a) && isOffline()) {
    offlineToast();
    if (navigator.onLine) wakeUp();      // peut-être revenu sans qu'on le sache
    return;
  }
  switch (a) {
    case "tab":
      state.tab = btn.dataset.tab; state.page = null; state.modulesDraft = null; renderApp(); window.scrollTo(0, 0); return;
    case "open-page":
      if (btn.dataset.page === "modules") return openModules();
      state.page = btn.dataset.page; if (btn.dataset.measure) state.measure = btn.dataset.measure;
      renderApp(); window.scrollTo(0, 0); return;
    case "close-page": state.page = null; state.modulesDraft = null; renderApp(); window.scrollTo(0, 0); return;
    case "measure": state.measure = btn.dataset.measure; state.growthSel = null; return renderMain();
    case "growth-point": state.growthSel = btn.dataset.id; return renderMain();

    // modules
    case "add-couches": return openDiaperSheet(null);
    case "edit-couches": { const d = state.diapers.find((x) => x.id === btn.dataset.id); if (d) openDiaperSheet(d); return; }
    case "add-croissance": return openGrowthSheet(null);
    case "edit-croissance": { const g = state.growth.find((x) => x.id === btn.dataset.id); if (g) openGrowthSheet(g); return; }
    case "add-premieres": return openFirstSheet(null);
    case "edit-premieres": { const f = state.firsts.find((x) => x.id === btn.dataset.id); if (f) openFirstSheet(f); return; }
    case "diaper-flag": {
      const k = btn.dataset.flag; state.sheet[k] = !state.sheet[k];
      if (k === "rash") { btn.setAttribute("aria-checked", state.sheet.rash); btn.querySelector(".switch").classList.toggle("on", state.sheet.rash); }
      else { btn.classList.toggle("on", state.sheet[k]); btn.setAttribute("aria-pressed", state.sheet[k]); }
      return;
    }
    case "sheet-photo-remove": state.sheet.photo = null; return renderSheetKeep();
    case "save-sheet": return saveSheet();
    case "delete-sheet": return deleteSheet();
    case "draft-module": {
      const m = state.modulesDraft.list.find((x) => x.id === btn.dataset.id); m.on = !m.on;
      return renderMain();
    }
    case "draft-kind": {
      const d = state.modulesDraft, k = btn.dataset.kind;
      d.kinds = d.kinds.includes(k) ? d.kinds.filter((x) => x !== k) : [...d.kinds, k];
      return renderMain();
    }
    case "save-modules": return saveModules();
    case "set-sex": return updateBaby({ sex: btn.dataset.sex === (currentBaby().sex || "") ? null : btn.dataset.sex });
    case "set-weight-unit": if (btn.dataset.unit !== weightUnit()) updateBaby({ weight_unit: btn.dataset.unit }); return;
    case "set-length-unit": if (btn.dataset.unit !== lengthUnit()) updateBaby({ length_unit: btn.dataset.unit }); return;
    case "range": state.range = btn.dataset.range; return renderMain();
    case "metric": state.metric = btn.dataset.metric; return renderMain();
    case "reload": return loadAll();
    case "retry": render("loading"); return boot();

    // boires
    case "add-feed":
      if (nursingOn() && bottleOn()) return openSheet({ type: "feedChoice" });
      if (nursingOn()) return openNursingSheet(null);
      if (bottleOn()) return openFeedSheet(null);
      return toast("Active l'allaitement ou le biberon dans « Gérer les modules »");
    case "choose-bottle": closeSheet(); return openFeedSheet(null);
    case "choose-nursing": closeSheet(); return openNursingSheet(null);
    case "edit-nursing": { const n = state.nursings.find((x) => x.id === btn.dataset.id); if (n) openNursingSheet(n); return; }
    case "nursing-toggle": timerToggle("nursing", btn.dataset.side); return renderSheet();
    // Passage à la saisie manuelle : on repart des minuteurs tels qu'ils sont (un minuteur parti compte au moins 1 min).
    case "nursing-manual": { const t = timerOf("nursing"); state.sheet.manual = true; state.sheet.left = Math.ceil(timerSeconds(t, "left") / 60); state.sheet.right = Math.ceil(timerSeconds(t, "right") / 60); state.sheet.lastSide = t?.lastSide || state.sheet.lastSide; renderSheet(); return focusField("n-left"); }
    case "nursing-last": state.sheet.lastSide = btn.dataset.side; return renderSheetKeep();
    case "nursing-abandon": timerMemory.clear("nursing"); closeSheet(); renderMain(); return toast("Tétée abandonnée");
    case "add-tirelait": return openPumpSheet(null);
    case "edit-tirelait": { const p = state.pumpings.find((x) => x.id === btn.dataset.id); if (p) openPumpSheet(p); return; }
    case "pump-toggle": timerToggle("pump", "all"); return renderSheetKeep();
    case "pump-manual": state.sheet.manual = true; state.sheet.minutes = Math.ceil(timerSeconds(timerOf("pump"), "all") / 60); renderSheetKeep(); return focusField("p-minutes");
    case "pump-mode": state.sheet.mode = btn.dataset.mode; return renderSheetKeep();
    case "pump-abandon": timerMemory.clear("pump"); closeSheet(); renderMain(); return toast("Séance abandonnée");

    // allergènes
    case "add-allergenes": return openAllergenSheet(null, state.page === "allergen" ? state.allergen : null);
    case "edit-allergenes": { const x = state.allergen_exposures.find((r) => r.id === btn.dataset.id); if (x) openAllergenSheet(x); return; }
    case "open-allergen": state.page = "allergen"; state.allergen = btn.dataset.key; renderApp(); window.scrollTo(0, 0); return;
    case "al-info": return openSheet({ type: "alInfo" });
    case "al-pick": return allergenPick(btn.dataset.key);
    case "al-custom": state.sheet.custom = true; redrawAllergen(); return $("#al-custom")?.focus({ preventScroll: true });
    case "al-custom-ok": return allergenCustom();
    case "al-reaction": state.sheet.reaction = btn.dataset.reaction; return redrawAllergen();
    case "al-symptom": {
      const k = btn.dataset.symptom, cur = state.sheet.symptoms;
      state.sheet.symptoms = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
      btn.classList.toggle("on"); btn.setAttribute("aria-pressed", state.sheet.symptoms.includes(k));
      return;
    }
    case "draft-nursing": state.modulesDraft.nursing = !state.modulesDraft.nursing; return renderMain();
    case "draft-bottle": state.modulesDraft.bottle = !state.modulesDraft.bottle; return renderMain();
    case "edit-feed": { const f = state.feeds.find((x) => x.id === btn.dataset.id); if (f) openFeedSheet(f); return; }
    case "feed-kind":
      state.sheet.kind = btn.dataset.kind;      // sans redessiner : la quantité en cours de saisie reste
      document.querySelectorAll('#sheet [data-action="feed-kind"]').forEach((b) => b.classList.toggle("on", b.dataset.kind === state.sheet.kind));
      return;
    case "use-last": $("#feed-amount").value = btn.dataset.value; $("#feed-suggest")?.remove(); return;
    case "toggle-wheel": return toggleWheel();
    case "close-sheet": return closeSheet();
    case "toggle-list": state.listOpen = !state.listOpen; return renderMain();

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
    case "remove-photo": return updateBaby({ photo: null }, "Photo retirée");
    case "save-my-name": return saveMyName();
    case "copy-code":
      try { await navigator.clipboard.writeText(currentBaby().join_code); toast("Code copié", { kind: "ok" }); }
      catch { toast("Copie impossible ici — note le code"); }
      return;
    case "share-code": {
      const b = currentBaby();
      navigator.share?.({ text: `Rejoins le suivi de ${b.name} dans Kenda (${location.origin}) avec le code ${b.join_code}.` }).catch(() => {});
      return;
    }
    case "forgot": return forgotPassword();
    case "signout": return signOut();
  }
});

/** Redessine la fiche ouverte sans perdre ce qui est tapé (note, titre, mesures). */
/** Ouvre le clavier sur un champ qu'on vient de dessiner. Doit rester dans le même geste que le toucher :
 *  iOS n'ouvre pas le clavier sur un focus() différé (setTimeout, requestAnimationFrame). */
function focusField(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.focus({ preventScroll: true });
  el.select();
}
function renderSheetKeep() {
  const s = state.sheet, keep = {};
  for (const el of document.querySelectorAll("#sheet input:not([type=file]), #sheet textarea")) keep[el.id] = el.value;
  if (s.type === "growth") { s.weight = keep["g-weight"] ?? s.weight; s.weightOz = keep["g-weight-oz"] ?? s.weightOz; s.height = keep["g-height"] ?? s.height; s.head = keep["g-head"] ?? s.head; }
  if (s.type === "first") s.title = keep["sheet-title"] ?? s.title;
  if (s.type === "allergen" && "al-food" in keep) s.food = keep["al-food"];
  if (s.type === "pump") { if ("p-left" in keep) s.left = keep["p-left"]; if ("p-right" in keep) s.right = keep["p-right"]; if ("p-total" in keep) s.total = keep["p-total"]; if ("p-minutes" in keep) s.minutes = keep["p-minutes"]; }
  if (s.type === "nursing") { if ("n-left" in keep) s.left = keep["n-left"]; if ("n-right" in keep) s.right = keep["n-right"]; }
  if ("sheet-note" in keep) s.note = keep["sheet-note"];
  if ("sheet-date" in keep) s.date = keep["sheet-date"];
  renderSheet();
}

document.addEventListener("change", (e) => {
  const kind = e.target?.dataset?.change;
  if (kind === "sheet-photo") {
    const file = e.target.files?.[0];
    if (!file || !state.sheet) return;
    shrinkPhoto(file).then((photo) => { if (state.sheet) { state.sheet.photo = photo; renderSheetKeep(); } })
      .catch(() => toast("Cette image n'a pas pu être lue"));
    return;
  }
  if (kind === "set-birth") {
    e.target.blur();          // renderMain ne redessine pas un champ actif
    if (isOffline()) { offlineToast(); renderMain(); return; }
    const v = e.target.value;
    if (v && v > todayKey()) { toast("La date de naissance est dans le futur"); renderMain(); return; }
    updateBaby({ birth_date: v || null });
    return;
  }
  if (kind === "baby-photo") {
    const file = e.target.files?.[0];
    if (!file) return;
    if (isOffline()) { offlineToast(); return; }
    shrinkPhoto(file, { size: 256, square: true, quality: 0.82 }).then((photo) => updateBaby({ photo }, "Photo mise à jour"))
      .catch(() => toast("Cette image n'a pas pu être lue"));
  }
  if (kind === "set-remind") {
    e.target.blur();
    if (isOffline()) { offlineToast(); renderMain(); return; }
    updateBaby({ remind_after_min: e.target.value ? Number(e.target.value) : null });
  }
});

document.addEventListener("focusin", (e) => {
  if (e.target?.matches?.("#sheet input:not([type=file]), #sheet textarea") && $("#wheel") && !$("#wheel").hidden) toggleWheel();
});

document.addEventListener("input", (e) => {
  if (e.target?.dataset?.input === "pump-amount") { const t = $("#pump-total"); if (t) t.textContent = pumpTotalLabel(); return; }
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

document.addEventListener("click", (e) => {
  const item = e.target.closest?.(".wheel-item");
  if (item) item.parentElement.scrollTo({ top: [...item.parentElement.children].indexOf(item) * WHEEL_ITEM, behavior: "smooth" });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.sheet) closeSheet();
  if (e.key === "Enter" && e.target?.id === "feed-amount") saveFeed();
  if (e.key === "Enter" && e.target?.id === "sheet-title") saveFirst();
  if (e.key === "Enter" && e.target?.id === "al-custom") allergenCustom();
  if (e.key === "Enter" && e.target?.id === "al-food") e.target.blur();
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
  photos.hydrate().then(() => { if (state.view === "app") renderMain(); });
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
