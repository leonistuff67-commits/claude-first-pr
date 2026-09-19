/**
 * Service worker: makes JARVIS installable and fully offline.
 *
 * Strategy matters here. An earlier version cached the app shell cache-first
 * with a fixed cache name, which meant an installed copy kept serving the old
 * app forever and never picked up updates. So:
 *
 *   - Same-origin app files (HTML/CSS/JS/manifest): NETWORK-FIRST. Online you
 *     always get the current build; offline you fall back to the cached copy.
 *   - Icons and other immutable assets: cache-first, they rarely change.
 *   - Cross-origin (the API, CDN libraries, model weights): never touched.
 *
 * Bump CACHE whenever the shell changes shape; old caches are purged on
 * activate.
 */
const CACHE = 'jarvis-v3';

const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/brain.js',
  './js/offline.js',
  './js/localbrain.js',
  './js/connectors.js',
  './js/providers.js',
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

/** Assets safe to serve straight from cache. */
const isImmutable = (pathname) => /\/icons\/|\.(png|svg|woff2?)$/i.test(pathname);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Don't let one missing file abort the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  // Lets the page force an update without waiting for a second reload.
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // The API, CDN libraries and model weights are never our business.
  if (url.origin !== self.location.origin) return;

  if (isImmutable(url.pathname)) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return res;
      })),
    );
    return;
  }

  // Network-first for everything else, so updates land immediately.
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('./index.html'))),
  );
});
