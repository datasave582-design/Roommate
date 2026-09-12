// service-worker.js — caches the static app shell only. All data goes through
// Firestore's own offline-capable SDK (see firebase-config.js persistentLocalCache);
// this worker never intercepts Firestore/Auth network calls, so a write only
// ever reports success once Firebase has actually confirmed it (spec §59).
const CACHE_NAME = "roommate-shell-v1";
// Relative (no leading "/") so these resolve against this file's own location —
// works whether the site is deployed at a domain root or under a sub-path
// (e.g. GitHub Project Pages: username.github.io/repo-name/).
const SHELL_FILES = [
  "index.html",
  "css/style.css",
  "js/firebase-config.js",
  "js/auth.js",
  "js/common.js",
  "js/room-data.js",
  "admin/dashboard.html",
  "admin/dashboard.js",
  "roommate/dashboard.html",
  "roommate/dashboard.js",
  "manifest.json",
  "icon-192.png",
  "icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Never cache/intercept Firebase or Google API calls — those must always hit the network
  // so the app can show a real offline state instead of stale/fake data.
  if (url.hostname.includes("googleapis.com") || url.hostname.includes("firebaseio.com") || url.hostname.includes("gstatic.com")) {
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).catch(() => caches.match("index.html")))
  );
});
