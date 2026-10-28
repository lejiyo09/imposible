const CACHE='qs-shell-v5';
const SHELL=['/','/index.html','/manifest.webmanifest','/icons/icon-32.png','/icons/icon-180.png','/icons/icon-192.png','/icons/icon-512.png','/icons/icon-maskable-512.png'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',e=>{
  e.waitUntil(
    caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('qs-')&&k!==CACHE).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(u.origin!==self.location.origin||e.request.method!=='GET'||!SHELL.includes(u.pathname))return;
  e.respondWith(
    fetch(e.request,{cache:'no-store'}).then(nr=>{
      if(nr.ok){const copy=nr.clone();caches.open(CACHE).then(c=>c.put(e.request,copy))}
      return nr;
    }).catch(()=>caches.match(e.request))
  );
});
