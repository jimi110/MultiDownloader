// MultiDownloader · service worker (permite instalar la app y abrirla aunque la red falle un momento).
// La API (/api/...) nunca se guarda en caché: las descargas siempre van al servidor.
const VERSION = "md-v2";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/favicon.svg"];
const CDN = ["cdn.tailwindcss.com", "cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: "reload" })).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.pathname.includes("/api/")) return;                 // API: siempre a la red

  // Páginas: red primero (así ves las actualizaciones) y, si no hay red, la copia guardada
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return r; })
        .catch(() => caches.match(req).then((m) => m || caches.match("./") || caches.match("index.html")))
    );
    return;
  }

  // Archivos de la app y librerías externas: copia guardada al instante y se actualiza en segundo plano
  if (url.origin === self.location.origin || CDN.includes(url.hostname)) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req)
          .then((r) => { if (r.ok || r.type === "opaque") { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return r; })
          .catch(() => hit);
        return hit || net;
      })
    );
  }
});
