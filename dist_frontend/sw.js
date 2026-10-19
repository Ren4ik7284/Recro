const CACHE_NAME = 'recro-pwa-v50';
const OFFLINE_AUDIO_CACHE = 'recro-offline-tracks-v1';

const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/manifest.json',
  '/favicon.svg',
  '/favicon.ico',
  '/icons/icon-32.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== OFFLINE_AUDIO_CACHE)
          .map((key) => {
            console.log('[SW] Purging old cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Bypass chunk slices and range requests so they never get trapped in SW
  if (url.searchParams.has('slice') || event.request.headers.get('range')) {
    return;
  }

  // Do not intercept non-GET requests or backend API requests
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) {
    return;
  }

  // 1. Handle offline cached audio requests
  if (url.pathname.startsWith('/offline-audio/')) {
    event.respondWith(
      caches.open(OFFLINE_AUDIO_CACHE).then((cache) => {
        return cache.match(event.request.url).then((cached) => {
          return cached || fetch(event.request);
        });
      })
    );
    return;
  }

  // 2. Do not cache live audio streams in the main PWA cache
  if (
    url.pathname.includes('/api/stream') ||
    url.pathname.endsWith('.mp3') ||
    url.pathname.endsWith('.aac') ||
    url.pathname.endsWith('.m4a') ||
    url.pathname.endsWith('.opus')
  ) {
    return;
  }

  // 3. For Navigation / HTML: Network-First with short timeout, fallback to cache
  if (
    event.request.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname === '/index.html'
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
          // Fetch fresh HTML from network with a 2-second timeout so slow network or offline still works
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 2000);

          const networkResponse = await fetch(event.request, { signal: controller.signal });
          clearTimeout(timeoutId);

          if (networkResponse && networkResponse.status === 200) {
            cache.put(event.request, networkResponse.clone());
            cache.put('/index.html', networkResponse.clone());
            return networkResponse;
          }
        } catch (_err) {
          // Network failed or timed out -> fall back to cache below
        }

        const cached = (await cache.match('/index.html')) || (await cache.match('/'));
        if (cached) {
          return cached;
        }

        // Final fallback if nothing in cache
        return fetch(event.request);
      })()
    );
    return;
  }

  // 4. For static assets (JS, CSS, Icons): Cache-First for instant loads, network fallback
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          } else if (
            networkResponse &&
            networkResponse.status === 404 &&
            (url.pathname.endsWith('.js') || url.pathname.endsWith('.css'))
          ) {
            // A requested chunk is missing (likely after a new deployment).
            // Invalidate cached index.html so next navigation fetches the latest index.html
            caches.open(CACHE_NAME).then((cache) => {
              cache.delete('/index.html');
              cache.delete('/');
            });
          }
          return networkResponse;
        });
      })
    );
  }
});
