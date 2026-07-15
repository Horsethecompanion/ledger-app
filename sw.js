// Ledger service worker
// Caches the app shell (HTML/CSS/JS) so the app opens instantly even offline.
// Note content itself is cached separately in IndexedDB by app.js, not here -
// that data needs richer read/write logic than a service worker cache handles well.

const CACHE_NAME = "ledger-shell-v2";
const SHELL_FILES = [
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never intercept GitHub API calls - those need live network handling
  // and proper online/offline logic inside app.js, not a blanket cache.
  if (url.hostname.includes("github.com") || url.hostname.includes("githubusercontent.com")) {
    return;
  }

  // App shell: network-first, so you always get the latest code when online;
  // falls back to cache only if the network is unreachable (offline use).
  if (SHELL_FILES.some((f) => event.request.url.endsWith(f.replace("./", "")))) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Everything else (fonts, jsdelivr libs): network-first, fall back to cache.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
