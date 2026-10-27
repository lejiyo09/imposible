/*global Ultraviolet*/
// 출처(scheme://host:port)만 인코딩하고 경로는 그대로 둔다. 경로의 '/'가 살아 있어야
// new URL('./x.js', import.meta.url) 같은 런타임 상대 경로 계산이 올바른 주소를 만든다.
const QS_PREFIX = '/service/';
const QS_PROXY_BASE = self.location.origin + QS_PREFIX;
const qsCodec = {
  encode(s) {
    if (!s) return s;
    let u;
    try { u = new URL(s); } catch (e) { return Ultraviolet.codec.xor.encode(s); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return Ultraviolet.codec.xor.encode(s);
    // 이미 프록시 주소인 경우(사이트가 import.meta.url 기준으로 계산한 주소 등) 다시 감싸지 않는다.
    if (u.href.startsWith(QS_PROXY_BASE)) return u.href.slice(QS_PROXY_BASE.length);
    return Ultraviolet.codec.xor.encode(u.origin) + u.pathname + u.search + u.hash;
  },
  decode(s) {
    if (!s) return s;
    const i = s.indexOf('/');
    if (i < 0) return Ultraviolet.codec.xor.decode(s);
    return Ultraviolet.codec.xor.decode(s.slice(0, i)) + s.slice(i);
  },
};

self.__uv$config = {
  prefix: QS_PREFIX,
  encodeUrl: qsCodec.encode,
  decodeUrl: qsCodec.decode,
  // UV 3.2.10은 import(x)를 __uv.rewriteImport(모듈주소, x)로 바꾸지만 기본 구현은 (x, 기준) 순서로 받아
  // 동적 import가 자기 자신을 다시 불러온다. 인자 순서를 맞춘 구현으로 교체한다.
  rewriteImport(base, url, meta = this.meta) {
    return this.rewriteUrl(url, { ...meta, base });
  },
  handler: '/uv/uv.handler.js',
  client: '/uv/uv.client.js',
  bundle: '/uv/uv.bundle.js',
  config: '/uv/uv.config.js',
  sw: '/uv/uv.sw.js',
};
