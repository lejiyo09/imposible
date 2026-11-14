// Geo-Zebra Remote — 최소 서비스 워커
// PWA 설치 가능 요건을 충족시키기 위한 용도. 화면은 실시간 스트리밍이라
// 캐싱하지 않고, fetch 핸들러만 둬서 네트워크로 그대로 통과시킨다.
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => self.clients.claim());
self.addEventListener('fetch', (e) => {
  // 네트워크 우선 (원격 브라우저는 항상 서버와 실시간 통신)
  e.respondWith(fetch(e.request).catch(() => new Response('오프라인', { status: 503 })));
});
