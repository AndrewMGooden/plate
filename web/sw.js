/* Plate service worker.
   The app shell is cached so Plate opens with no connection at all.
   Open Food Facts calls always go to the network and are never cached —
   a stale nutrition panel is worse than no answer. */
const VERSION = "plate-v1";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "foods.js",
  "app.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(VERSION).then(c => {
      // cache.addAll() goes through the browser's HTTP cache, and GitHub Pages
      // sets a ten-minute max-age — so a fresh deploy would cache the OLD files
      // and viewers would stay a version behind. Force each one to the network.
      return Promise.all(SHELL.map(url =>
        fetch(new Request(url, {cache: "reload"}))
          .then(res => res && res.ok ? c.put(url, res) : null)
          .catch(() => null)
      ));
    })
    .then(() => self.skipWaiting())
    .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if(req.method !== "GET") return;

  const url = new URL(req.url);

  // Never cache the product database or the font CDN responses we can't version.
  if(url.hostname.indexOf("openfoodfacts") > -1) return;

  // App shell: serve from cache, refresh in the background.
  if(url.origin === self.location.origin){
    event.respondWith(
      caches.match(req).then(hit => {
        const live = fetch(req).then(res => {
          if(res && res.status === 200 && res.type === "basic"){
            const copy = res.clone();
            caches.open(VERSION).then(c => c.put(req, copy)).catch(()=>{});
          }
          return res;
        }).catch(() => hit);
        return hit || live;
      })
    );
    return;
  }

  // Fonts and anything else third-party: network, falling back to whatever we have.
  event.respondWith(
    fetch(req).then(res => {
      if(res && res.status === 200){
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(req, copy)).catch(()=>{});
      }
      return res;
    }).catch(() => caches.match(req))
  );
});
