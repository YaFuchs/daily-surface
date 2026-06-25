// sw.js — service worker (Track B Phase 4): precache the app shell so the Surface works fully
// offline; cache-first for same-origin assets. NEVER touch api.github.com (auth + freshness +
// the access key must never be cached). Relative URLs so the SAME shell runs on localhost (test)
// and the GitHub Pages path (prod) with no rebuild (critique nice-to-have).

const CACHE = "daily-surface-v1";
const SHELL = [
  "./", "./index.html", "./app.css", "./manifest.webmanifest", "./icon.svg",
  "./app.js", "./ui.js", "./journal.js", "./events.js", "./journal_staging.js", "./reducer.js",
  "./db.js", "./outbox.js", "./secrets.js", "./github.js", "./sync.js", "./safe-render.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.hostname === "api.github.com") return;             // pass through — never cache the API
  if (e.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;           // only own-origin shell assets
  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit || fetch(e.request).then((resp) => {
        if (resp.ok) { const copy = resp.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return resp;
      }).catch(() => caches.match("./index.html")))
  );
});
