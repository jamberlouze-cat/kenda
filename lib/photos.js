// Photos des mesures et des premières. Elles ne vont PAS dans l'instantané
// (localStorage plafonne à ~5 Mo) : elles vivent en mémoire, avec une copie dans
// IndexedDB pour le démarrage hors ligne. Clé = id de la ligne ; `v` = son
// updated_at, pour savoir quand la copie est périmée.

const DB = "kenda-photos", STORE = "photos";
const memory = new Map();            // id → { v, photo }

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx(mode, fn) {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode), out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(out?.result);
      t.onerror = () => reject(t.error);
    });
  } catch { return undefined; }      // navigation privée, quota… : on se passe de la copie
}

export const photos = {
  get(id) { return memory.get(id)?.photo || null; },
  version(id) { return memory.get(id)?.v || null; },
  set(id, v, photo) { memory.set(id, { v, photo }); tx("readwrite", (s) => s.put({ v, photo }, id)); },
  remove(id) { memory.delete(id); tx("readwrite", (s) => s.delete(id)); },
  /** Au démarrage : recharge en mémoire ce que l'appareil a gardé. */
  async hydrate() {
    try {
      const db = await open();
      await new Promise((resolve) => {
        const req = db.transaction(STORE).objectStore(STORE).openCursor();
        req.onsuccess = () => { const c = req.result; if (!c) return resolve(); if (!memory.has(c.key)) memory.set(c.key, c.value); c.continue(); };
        req.onerror = () => resolve();
      });
    } catch { /* rien */ }
  },
  async clear() { memory.clear(); await tx("readwrite", (s) => s.clear()); },
};
