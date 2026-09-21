// Calculs de Kenda — fonctions pures (aucun accès à l'écran ni à Supabase).
// Un boire : { id, kind, amount_ml, started_at (ISO), caregiver_id }.
// Toutes les sommes sont en ml ; la conversion en oz se fait à l'affichage.

export const ML_PER_OZ = 29.5735;
const MIN = 60000, HOUR = 3600000, DAY = 86400000;

const t = (f) => new Date(f.started_at).getTime();
const sum = (list) => list.reduce((s, f) => s + Number(f.amount_ml), 0);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ------------------------------------------------------------------ unités ---
export function fromUnit(value, unit) {
  const ml = unit === "oz" ? value * ML_PER_OZ : value;
  return Math.round(ml * 10) / 10;
}
/** « 120 » en ml, « 3,5 » en oz (virgule française, pas de « ,0 » inutile). */
export function formatAmount(ml, unit) {
  if (unit !== "oz") return String(Math.round(ml));
  return (Math.round((ml / ML_PER_OZ) * 10) / 10).toFixed(1).replace(/\.0$/, "").replace(".", ",");
}

// ------------------------------------------------------------------- jours ---
export function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
export function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
export function dayKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

/** Du plus récent au plus ancien. */
export function sortDesc(feeds) { return [...feeds].sort((a, b) => t(b) - t(a)); }

// --------------------------------------------------------------- compteurs ---
/** Depuis minuit (heure de l'appareil) jusqu'à maintenant. */
export function totalToday(feeds, now) {
  const from = startOfDay(now).getTime(), to = now.getTime();
  return sum(feeds.filter((f) => t(f) >= from && t(f) <= to));
}
/** Fenêtre glissante : les 24 dernières heures, à la minute près. */
export function totalLast24h(feeds, now) {
  const to = now.getTime(), from = to - DAY;
  return sum(feeds.filter((f) => t(f) > from && t(f) <= to));
}
export function lastFeed(feeds, now) {
  return sortDesc(feeds).find((f) => t(f) <= now.getTime() + MIN) || null;
}

/** « 2 h 15 », « 8 min », « à l'instant ». */
export function formatElapsed(ms) {
  const m = Math.max(0, Math.floor(ms / MIN));
  if (m < 1) return "à l'instant";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h >= 48) return `${Math.floor(h / 24)} jours`;
  return r ? `${h} h ${String(r).padStart(2, "0")}` : `${h} h`;
}

// -------------------------------------------------------------- historique ---
/** Groupes par jour, du plus récent au plus ancien, boires du plus récent au plus ancien. */
export function groupByDay(feeds) {
  const map = new Map();
  for (const f of sortDesc(feeds)) {
    const key = dayKey(f.started_at);
    if (!map.has(key)) map.set(key, { key, date: startOfDay(f.started_at), feeds: [] });
    map.get(key).feeds.push(f);
  }
  return [...map.values()].map((g) => ({ ...g, total: sum(g.feeds), count: g.feeds.length }));
}

/** Écarts (ms) entre boires consécutifs ; un écart appartient au jour du 2e boire.
 *  Les trous de plus de 12 h (oubli de saisie, début du suivi) sont ignorés. */
function gaps(feeds) {
  const asc = [...feeds].sort((a, b) => t(a) - t(b));
  const out = [];
  for (let i = 1; i < asc.length; i++) {
    const gap = t(asc[i]) - t(asc[i - 1]);
    if (gap > 0 && gap <= 12 * HOUR) out.push({ at: t(asc[i]), key: dayKey(asc[i].started_at), gap });
  }
  return out;
}

/** Une entrée par jour pour les `days` derniers jours, aujourd'hui compris (à la fin). */
export function dailySeries(feeds, days, now) {
  const allGaps = gaps(feeds);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(startOfDay(now), -i), key = dayKey(date);
    const list = feeds.filter((f) => dayKey(f.started_at) === key);
    out.push({
      key, date, isToday: i === 0,
      total: sum(list), count: list.length,
      avgInterval: mean(allGaps.filter((g) => g.key === key).map((g) => g.gap)),
    });
  }
  return out;
}

/** Moyennes par jour sur `days` jours COMPLETS (aujourd'hui exclu : la journée
 *  n'est pas finie), comparées aux `days` jours d'avant. Les jours sans aucune
 *  saisie (avant le début du suivi) ne tirent pas la moyenne vers le bas. */
export function comparePeriods(feeds, days, now) {
  const series = dailySeries(feeds, days * 2 + 1, now).slice(0, -1);
  const summarize = (part) => {
    const used = part.filter((d) => d.count > 0);
    return {
      days: used.length,
      total: mean(used.map((d) => d.total)),
      count: mean(used.map((d) => d.count)),
      interval: mean(used.map((d) => d.avgInterval).filter((x) => x != null)),
    };
  };
  return { current: summarize(series.slice(days)), previous: summarize(series.slice(0, days)) };
}

// ---------------------------------------------------------------- patterns ---
/** Horaire type sur les `days` derniers jours complets.
 *  Méthode : on prend le nombre médian de boires par jour (k), on place toutes
 *  les heures de boire sur une horloge de 24 h, on coupe l'horloge au plus grand
 *  creux (souvent la nuit), puis on regroupe en k paquets (k-moyennes 1-D).
 *  Un créneau n'est gardé que s'il revient au moins 4 jours sur 10. */
export function findPatterns(feeds, now, days = 14) {
  const end = startOfDay(now).getTime(), start = end - days * DAY;
  const recent = feeds.filter((f) => t(f) >= start && t(f) < end);
  const perDay = new Map();
  for (const f of recent) perDay.set(dayKey(f.started_at), (perDay.get(dayKey(f.started_at)) || 0) + 1);
  const nDays = perDay.size;
  const intervalMs = median(gaps(feeds.filter((f) => t(f) >= start)).map((g) => g.gap));
  if (nDays < 3 || recent.length < 8) return { ready: false, nDays, slots: [], intervalMs };

  const k = Math.max(1, Math.round(median([...perDay.values()])));
  const minuteOf = (f) => { const d = new Date(f.started_at); return d.getHours() * 60 + d.getMinutes(); };
  const pts = recent.map((f) => ({ m: minuteOf(f), ml: Number(f.amount_ml), key: dayKey(f.started_at) }))
    .sort((a, b) => a.m - b.m);

  // Coupe au plus grand creux de l'horloge, pour qu'un créneau de minuit ne soit pas scindé.
  let cut = 0, best = -1;
  for (let i = 0; i < pts.length; i++) {
    const next = i + 1 < pts.length ? pts[i + 1].m : pts[0].m + 1440;
    if (next - pts[i].m > best) { best = next - pts[i].m; cut = (i + 1) % pts.length; }
  }
  const base = pts[cut].m;
  const line = pts.map((p) => ({ ...p, x: (p.m - base + 1440) % 1440 })).sort((a, b) => a.x - b.x);

  let centers = Array.from({ length: k }, (_, i) => line[Math.floor(((i + 0.5) * line.length) / k)].x);
  let groups = [];
  for (let iter = 0; iter < 25; iter++) {
    groups = centers.map(() => []);
    for (const p of line) {
      let bi = 0;
      centers.forEach((c, i) => { if (Math.abs(p.x - c) < Math.abs(p.x - centers[bi])) bi = i; });
      groups[bi].push(p);
    }
    const next = groups.map((g, i) => (g.length ? mean(g.map((p) => p.x)) : centers[i]));
    if (next.every((c, i) => Math.abs(c - centers[i]) < 0.5)) break;
    centers = next;
  }

  const slots = groups
    .map((g, i) => ({
      minute: Math.round((centers[i] + base) % 1440),
      days: new Set(g.map((p) => p.key)).size,
      avgMl: mean(g.map((p) => p.ml)),
      spread: g.length ? Math.sqrt(mean(g.map((p) => (p.x - centers[i]) ** 2))) : 0,
    }))
    .filter((s) => s.days / nDays >= 0.4)
    .sort((a, b) => a.minute - b.minute);

  return { ready: true, nDays, perDay: k, slots, intervalMs };
}

/** Nombre de boires par heure de la journée (24 cases) sur les `days` derniers jours. */
export function hourHistogram(feeds, now, days = 14) {
  const from = now.getTime() - days * DAY;
  const bins = new Array(24).fill(0);
  for (const f of feeds) if (t(f) >= from && t(f) <= now.getTime()) bins[new Date(f.started_at).getHours()]++;
  return bins;
}
