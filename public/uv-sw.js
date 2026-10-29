/*global UVServiceWorker*/

// ── HTML charset 자동 복구 ──
// UV·BareClient 번들이 Response.prototype.text 참조를 캡처할 수 있어 importScripts 전에 패치한다.
// 많은 한국 사이트는 Content-Type에 charset 없이 <meta charset="euc-kr">만 두는데,
// 그 경우 Response.text()는 UTF-8로 해석해 "占쏙엠" 깨짐이 생긴다.
// 응답 바이트 앞부분에서 meta charset을 찾아 올바른 코덱으로 다시 디코딩하고,
// HTML 안의 charset 선언을 UTF-8로 바꿔 브라우저가 재해석하지 못하게 한다.
const QS_CS_ALIAS = {
  'ks_c_5601-1987': 'euc-kr', 'ksc_5601': 'euc-kr', 'ks_c_5601': 'euc-kr',
  'x-windows-949': 'windows-949', 'cp949': 'windows-949',
  'ms949': 'windows-949', 'uhc': 'windows-949',
  'iso-8859-1': 'windows-1252', 'latin1': 'windows-1252',
};
function qsRewriteCharsetMeta(html) {
  // <meta charset="X"> 와 <meta http-equiv="Content-Type" content="...; charset=X"> 를 UTF-8로 바꾼다.
  return html
    .replace(/(<meta[^>]+charset\s*=\s*["']?)[A-Za-z0-9_\-]+/gi, '$1utf-8')
    .replace(/(<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*)[A-Za-z0-9_\-]+/gi, '$1utf-8');
}
const _qsOrigText = Response.prototype.text;
Response.prototype.text = async function qsFixedText() {
  const ct = (this.headers.get('content-type') || '').toLowerCase();
  if (/charset\s*=/.test(ct)) return _qsOrigText.call(this);
  const isHtml = ct.includes('html') || ct === '' || ct.startsWith('text/plain');
  if (!isHtml) return _qsOrigText.call(this);
  let buf;
  try { buf = await this.arrayBuffer(); } catch (e) { return ''; }
  const bytes = new Uint8Array(buf);
  if (!bytes.length) return '';
  const peekLen = Math.min(bytes.length, 4096);
  const head = String.fromCharCode.apply(null, bytes.subarray(0, peekLen));
  let m = head.match(/<meta[^>]+charset\s*=\s*["']?([A-Za-z0-9_\-]+)/i)
       || head.match(/<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([A-Za-z0-9_\-]+)/i);
  let cs = m ? m[1].toLowerCase() : 'utf-8';
  if (QS_CS_ALIAS[cs]) cs = QS_CS_ALIAS[cs];
  if (cs === 'utf-8' || cs === 'utf8') {
    return qsRewriteCharsetMeta(new TextDecoder('utf-8').decode(bytes));
  }
  let out;
  try { out = new TextDecoder(cs).decode(bytes); }
  catch (e) { out = new TextDecoder('utf-8').decode(bytes); }
  return qsRewriteCharsetMeta(out);
};

importScripts('/uv/uv.bundle.js', '/uv/uv.config.js', '/uv/uv.sw.js');

const uv = new UVServiceWorker();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  e.respondWith((async () => (uv.route(e) ? uv.fetch(e) : fetch(e.request)))());
});
