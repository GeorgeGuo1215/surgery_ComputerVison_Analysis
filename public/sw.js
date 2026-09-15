const CACHE_PREFIX = 'petor-monitor-';
const CACHE_NAME = `${CACHE_PREFIX}shell-v5-timestamp-autosave`;
const CORE_PATHS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './petor-mark.svg',
  './apple-touch-icon.png',
  './petor-icon-192.png',
  './petor-icon-512.png',
  './petor-maskable-512.png',
  './vendor/tesseract/worker.min.js',
  './vendor/tesseract/core/tesseract-core-lstm.wasm.js',
  './vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js',
  './vendor/tesseract/lang/eng.traineddata.gz',
];

async function cacheApplicationShell() {
  const cache = await caches.open(CACHE_NAME);
  const rootUrl = new URL('./', self.registration.scope);
  const response = await fetch(rootUrl, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Unable to cache application shell: ${response.status}`);
  const html = await response.clone().text();
  await cache.put(rootUrl, response);
  const generatedAssets = [...html.matchAll(/(?:src|href)=["'](\.\/assets\/[^"']+)["']/g)]
    .map((match) => match[1]);
  await cache.addAll([...new Set([...CORE_PATHS.slice(1), ...generatedAssets])]);
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheApplicationShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !['http:', 'https:'].includes(url.protocol) || url.pathname.endsWith('/sw.js')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.ok) (await caches.open(CACHE_NAME)).put(request, response.clone());
          return response;
        })
        .catch(async () => (
          (await caches.match(request)) ||
          (await caches.match(new URL('./', self.registration.scope))) ||
          Response.error()
        )),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then(async (response) => {
      if (response.ok) (await caches.open(CACHE_NAME)).put(request, response.clone());
      return response;
    })),
  );
});
