/**
 * Service worker: makes JARVIS installable and fully offline.
 *
 * The app shell (HTML, CSS, JS modules, icons) is precached on install and
 * served cache-first, so once installed JARVIS opens with no network at all.
 * API calls to Anthropic are never cached — they're always live.
 */
const CACHE = 'jarvis-v2';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/brain.js',
  './js/offline.js',
  './js/clap.js',
  './js/recognizer.js',
  './js/voice.js',
  './js/orb.js',
  './js/wave.js',
  './js/mind.js',
  './js/tools.js',
  './js/memory.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never touch the API or the local proxy — always live.
  if (url.hostname.endsWith('anthropic.com') || url.pathname.startsWith('/api/')) {
    return;
  }
  if (request.method !== 'GET') return;

  // Cache-first for the app shell, falling back to the network and caching new
  // same-origin GETs as they're seen.
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request)
        .then((res) => {
          if (res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => hit);
    }),
  );
});
