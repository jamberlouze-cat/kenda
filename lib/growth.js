// Croissance — fonctions pures : méthode LMS de l'OMS (score Z, percentile,
// courbes), âge du bébé et conversions d'unités. En base, tout est métrique
// (grammes, centimètres) ; la conversion se fait à l'affichage et à la saisie.

import { LMS } from "./lms.js";

const DAY = 86400000;
export const G_PER_LB = 453.59237, G_PER_OZ = 28.349523125, CM_PER_IN = 2.54;
export const MAX_AGE_DAYS = 1826;                       // les tables couvrent 0 à 5 ans
export const PERCENTILES = [3, 15, 50, 85, 97];         // convention canadienne / québécoise
const Z_OF = { 3: -1.880794, 15: -1.036433, 50: 0, 85: 1.036433, 97: 1.880794 };

/** Les mesures : clé = colonne en base, valeur OMS = unité de la table LMS. */
export const MEASURES = {
  weight: { col: "weight_g", label: "Poids", toLms: (g) => g / 1000, fromLms: (kg) => kg * 1000 },
  height: { col: "height_cm", label: "Taille", toLms: (x) => x, fromLms: (x) => x },
  head: { col: "head_cm", label: "Tour de tête", toLms: (x) => x, fromLms: (x) => x },
};

// -------------------------------------------------------------------- dates ---
/** « 2026-09-19 » → date locale à midi (jamais de glissement de fuseau). */
export function parseDay(s) {
  const [y, m, d] = String(s).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}
export function ageInDays(birth, on) {
  return Math.round((parseDay(on) - parseDay(birth)) / DAY);
}
/** Âge façon Nara : « 5m 1s 4j » (mois de calendrier, puis semaines et jours). */
export function ageLabel(birth, on) {
  const b = parseDay(birth), d = parseDay(on);
  if (d < b) return "";
  let months = (d.getFullYear() - b.getFullYear()) * 12 + d.getMonth() - b.getMonth();
  const anchor = (n) => {                                // le même quantième, n mois plus tard (fin de mois respectée)
    const x = new Date(b.getFullYear(), b.getMonth() + n, 1, 12);
    x.setDate(Math.min(b.getDate(), new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate()));
    return x;
  };
  if (anchor(months) > d) months--;
  const rest = Math.round((d - anchor(months)) / DAY);
  const parts = [];
  if (months >= 24) { parts.push(`${Math.floor(months / 12)}a`); if (months % 12) parts.push(`${months % 12}m`); }
  else if (months) parts.push(`${months}m`);
  if (months < 24) {
    if (Math.floor(rest / 7)) parts.push(`${Math.floor(rest / 7)}s`);
    if (rest % 7 || !parts.length) parts.push(`${rest % 7}j`);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------- LMS ---
/** L, M, S à un âge donné (interpolation linéaire entre deux lignes de la table). */
export function lmsAt(measure, sex, days) {
  const t = LMS[measure]?.[sex];
  if (!t || days < 0 || days > MAX_AGE_DAYS) return null;
  let lo = 0, hi = t.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid][0] <= days) lo = mid; else hi = mid; }
  const a = t[lo], b = t[hi];
  if (days <= a[0]) return { L: a[1], M: a[2], S: a[3] };
  if (days >= b[0]) return { L: b[1], M: b[2], S: b[3] };
  const k = (days - a[0]) / (b[0] - a[0]);
  return { L: a[1] + k * (b[1] - a[1]), M: a[2] + k * (b[2] - a[2]), S: a[3] + k * (b[3] - a[3]) };
}

/** Valeur (unité de la table) correspondant à un score Z. */
export function valueAtZ({ L, M, S }, z) {
  return Math.abs(L) < 1e-9 ? M * Math.exp(S * z) : M * Math.pow(1 + L * S * z, 1 / L);
}

/** Score Z d'une valeur. Pour le poids, l'OMS redresse les extrêmes (|Z| > 3). */
export function zScore(lms, value, measure) {
  const { L, M, S } = lms;
  let z = Math.abs(L) < 1e-9 ? Math.log(value / M) / S : (Math.pow(value / M, L) - 1) / (L * S);
  if (measure === "weight" && Math.abs(z) > 3) {
    const sd = (k) => valueAtZ(lms, k);
    z = z > 3 ? 3 + (value - sd(3)) / (sd(3) - sd(2)) : -3 + (value - sd(-3)) / (sd(-2) - sd(-3));
  }
  return z;
}

/** Fonction de répartition de la loi normale (Abramowitz-Stegun 26.2.17, erreur < 7,5e-8). */
export function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804 * Math.exp(-z * z / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/** Percentile d'une mesure (valeur en base : g ou cm). null hors des tables. */
export function percentileOf(measure, sex, days, stored) {
  const lms = lmsAt(measure, sex, days);
  if (!lms || !(stored > 0)) return null;
  return normalCdf(zScore(lms, MEASURES[measure].toLms(stored), measure)) * 100;
}
/** « 62e », « < 1er », « > 99e ». */
export function percentileLabel(p) {
  if (p == null) return "";
  if (p < 1) return "< 1er";
  if (p > 99) return "> 99e";
  const n = Math.round(p);
  return n === 1 ? "1er" : `${n}e`;
}

/** Courbe d'un percentile entre deux âges : [{ days, value (g ou cm) }]. */
export function percentileCurve(measure, sex, p, fromDays, toDays, steps = 48) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const days = fromDays + ((toDays - fromDays) * i) / steps;
    const lms = lmsAt(measure, sex, days);
    if (lms) out.push({ days, value: MEASURES[measure].fromLms(valueAtZ(lms, Z_OF[p])) });
  }
  return out;
}

// ------------------------------------------------------------------- unités ---
const comma = (n, digits) => n.toFixed(digits).replace(".", ",");
/** Poids : « 4,35 kg » ou « 9 lb 9 oz ». */
export function formatWeight(g, unit) {
  if (unit !== "lb") return `${comma(g / 1000, g < 10000 ? 2 : 1)} kg`;
  let lb = Math.floor(g / G_PER_LB), oz = Math.round((g - lb * G_PER_LB) / G_PER_OZ);
  if (oz === 16) { lb++; oz = 0; }
  return `${lb} lb ${oz} oz`;
}
/** Taille et tour de tête : « 54,5 cm » ou « 21,5 po ». */
export function formatLength(cm, unit) {
  return unit === "po" ? `${comma(cm / CM_PER_IN, 1).replace(/,0$/, "")} po` : `${comma(cm, 1).replace(/,0$/, "")} cm`;
}
export const lbOzToG = (lb, oz) => Math.round((lb || 0) * G_PER_LB + (oz || 0) * G_PER_OZ);
export function gToLbOz(g) {
  let lb = Math.floor(g / G_PER_LB), oz = Math.round(((g - lb * G_PER_LB) / G_PER_OZ) * 10) / 10;
  if (oz >= 16) { lb++; oz = 0; }
  return { lb, oz };
}
export const lengthToCm = (v, unit) => Math.round((unit === "po" ? v * CM_PER_IN : v) * 10) / 10;
export const cmToLength = (cm, unit) => Math.round((unit === "po" ? cm / CM_PER_IN : cm) * 10) / 10;
