const CACHE = "plannipro-shell-v22";
const APP_SHELL = [
  "./",
  "./index.html",
  "./pointeuse.html",
  "./pointeuse.js",
  "./pointeuse.webmanifest",
  "./pointeuse-icon.svg",
  "./supabase-config.js",
  "./plannipro-cloud.js?v=logout2",
  "./plannipro-vault.js?v=logout2",
  "./plannipro-vault.css",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then(async (cache) => {
    await Promise.all(APP_SHELL.map((asset) => cache.add(asset).catch(() => undefined)));
    await self.skipWaiting();
  }));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  // Do not cache API responses: authorization and fresh RLS checks must always
  // come from Supabase. The offline cache is explicitly managed in IndexedDB.
  if (requestUrl.hostname.endsWith("supabase.co")) return;

  const cacheResponse = async (response) => {
    if (response && response.ok && (requestUrl.origin === self.location.origin || requestUrl.hostname === "cdn.jsdelivr.net")) {
      const copy = response.clone();
      const cache = await caches.open(CACHE);
      await cache.put(event.request, copy);
    }
    return response;
  };

  const isNavigation = event.request.mode === "navigate" || event.request.destination === "document";
  if (isNavigation) {
    event.respondWith(
      fetch(event.request)
        .then(cacheResponse)
        .catch(async () => (await caches.match(event.request)) || caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(cacheResponse)
      .catch(() => caches.match(event.request))
  );
});
