/*
 * QuietSpace 서비스 워커
 * - 앱 자체 파일(아래 APP_FILES)만 캐시한다.
 * - 같은 출처가 아닌 요청(사용자가 iframe으로 여는 외부 사이트 등)은 건드리지 않고 캐시하지도 않는다.
 * - 따라서 방문한 사이트의 주소나 내용은 Cache Storage에 저장되지 않는다.
 */
const CACHE_NAME = 'quietspace-v1';
const APP_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n.startsWith('quietspace-') && n !== CACHE_NAME).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

function isAppFile(url) {
  if (url.origin !== self.location.origin) return false;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return false;
  const rel = './' + url.pathname.slice(scope.pathname.length);
  return APP_FILES.includes(rel);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!isAppFile(url)) return; // 외부 사이트·기타 요청은 브라우저 기본 동작에 맡김

  if (req.mode === 'navigate') {
    // 앱 화면: 네트워크 우선(업데이트 반영), 오프라인이면 캐시 사용
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }
  // 아이콘·매니페스트: 캐시 우선
  event.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});
