/*global UVServiceWorker*/
importScripts('/uv/uv.bundle.js', '/uv/uv.config.js', '/uv/uv.sw.js');

const uv = new UVServiceWorker();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  e.respondWith((async () => (uv.route(e) ? uv.fetch(e) : fetch(e.request)))());
});
