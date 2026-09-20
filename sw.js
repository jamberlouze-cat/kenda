// Service worker : rend l'app installable et la fait démarrer hors ligne.
// Stratégie « réseau d'abord, mais pas longtemps » : en ligne, on charge la
// dernière version des fichiers ; hors ligne — ou si le réseau ne répond pas en
// quelques secondes — on sert la dernière version mise en cache. Toute la
// coquille, librairie Supabase comprise, est mise en cache à l'installation.
// Les polices vivent dans un cache à part, qui survit aux mises à jour.
// Les données (API Supabase) ne passent jamais par ici : c'est app.js qui en
// garde une copie sur l'appareil.
// ⚠️ Augmenter CACHE à chaque changement de la liste SHELL.
const CACHE = "kenda-v15";
const FONT_CACHE = "kenda-fonts";
const NETWORK_TIMEOUT = 3000;
const SHELL = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./lib/config.js",
  "./lib/supabase.js",
  "./lib/vendor/supabase-js.js",
  "./lib/store.js",
  "./lib/stats.js",
  "./lib/growth.js",
  "./lib/lms.js",
  "./lib/photos.js",
  "./manifest.webmanifest",
  "./manifest-dev.webmanifest",
  "./assets/icon-180.png",
  "./assets/icon-192.png",
  "./assets/koala.png",
  "./assets/icon-dev-512.png",
  "./assets/icon-dev-192.png",
  "./assets/icon-dev-180.png",
];
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (e) => {
  // cache: "reload" → on contourne le cache HTTP du navigateur, pour ne pas
  // figer une vieille copie d'un fichier dans la nouvelle version du cache.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== FONT_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** Réseau, avec copie en cache au passage. */
function fromNetwork(request, cacheName) {
  return fetch(request).then((res) => {
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(cacheName).then((c) => c.put(request, copy)).catch(() => {});
    }
    return res;
  });
}

/** Polices : le cache d'abord (elles ne changent pas), sinon le réseau. */
async function fontFirst(request) {
  const hit = await caches.match(request, { cacheName: FONT_CACHE });
  return hit || fromNetwork(request, FONT_CACHE);
}

/** Coquille : le réseau d'abord ; le cache s'il échoue ou s'il traîne. */
async function networkFirst(request) {
  const cached = await caches.match(request, { cacheName: CACHE, ignoreSearch: true });
  const network = fromNetwork(request, CACHE);
  if (!cached) return network;
  network.catch(() => {});            // sa copie en cache continue en arrière-plan
  const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NETWORK_TIMEOUT));
  return Promise.race([network.catch(() => cached), timeout]);
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (FONT_HOSTS.includes(url.hostname)) { e.respondWith(fontFirst(e.request)); return; }
  if (url.origin !== location.origin) return;  // laisser passer l'API Supabase
  if (url.pathname.startsWith("/_")) return;    // /_ping, banc d'essai
  e.respondWith(networkFirst(e.request));
});
