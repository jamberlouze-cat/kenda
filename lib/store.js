// Persistance locale : file d'attente hors ligne des boires + instantané des
// données pour démarrer sans réseau. Tout vit dans localStorage.

const QUEUE_KEY = "kenda.queue.v1";
const SNAP_KEY = "kenda.snapshot.v1";
const BABY_KEY = "kenda.baby.v1";
const NAME_KEY = "kenda.myname.v1";

function read(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
}

/** File des saisies à envoyer (ajouts, corrections, suppressions). Une seule
 *  entrée par ligne : la version la plus récente remplace la précédente.
 *  `_t` = table de destination (absent = « feeds », le format d'origine). */
export const queue = {
  all() { return read(QUEUE_KEY, []); },
  size() { return this.all().length; },
  push(feed) {
    const list = this.all().filter((x) => x.id !== feed.id);
    list.push(feed);
    write(QUEUE_KEY, list);
  },
  peek() { return this.all()[0] || null; },
  /** Retire l'entrée, sauf si une version plus récente l'a remplacée entre-temps. */
  remove(feed) {
    write(QUEUE_KEY, this.all().filter((x) => !(x.id === feed.id && x.updated_at === feed.updated_at)));
  },
  clear() { write(QUEUE_KEY, []); },
};

/** Instantané des données (bébés, parents, boires) pour un démarrage hors ligne. */
export const snapshot = {
  load() { return read(SNAP_KEY, null); },
  save(data) { write(SNAP_KEY, data); },
  clear() { try { localStorage.removeItem(SNAP_KEY); } catch { /* rien */ } },
};

/** Bébé affiché (un compte peut suivre plusieurs bébés). */
export const babyMemory = {
  get() { return read(BABY_KEY, null); },
  set(id) { write(BABY_KEY, id); },
};

/** Prénom du parent, pour ne pas le redemander au deuxième bébé. */
export const nameMemory = {
  get() { return read(NAME_KEY, ""); },
  set(name) { write(NAME_KEY, name); },
};

/** Rejoue la file par-dessus des boires venus du serveur : une saisie faite
 *  hors ligne ne doit pas disparaître de l'écran au prochain chargement. */
export function applyQueue(feeds, table = "feeds") {
  const byId = new Map(feeds.map((f) => [f.id, f]));
  for (const { _t, ...q } of queue.all()) {
    if ((_t || "feeds") !== table) continue;
    const cur = byId.get(q.id);
    // Dates comparées en millisecondes : le serveur écrit « +00:00 », l'appareil « Z ».
    if (!cur || !cur.updated_at || Date.parse(cur.updated_at) <= Date.parse(q.updated_at)) byId.set(q.id, { ...cur, ...q });
  }
  return [...byId.values()].filter((f) => !f.deleted_at);
}
