/**
 * Geo-Zebra Agent — 서버사이드 웹페이지 프록시 에이전트
 *
 * 클라이언트와 단일 WebSocket으로 연결.
 * 클라이언트 요청 시 서버에서 페이지를 fetch → HTML/CSS/이미지 인라인화 → 전송.
 * DNS 차단 환경에서도 기존 WebSocket이 살아있으면 계속 서핑 가능.
 */

const { JSDOM } = require('jsdom');
const { URL } = require('url');

// ── 상수 ──
const MAX_RESOURCE_SIZE = 2 * 1024 * 1024;   // 개별 리소스 최대 2MB
const MAX_PAGE_SIZE = 8 * 1024 * 1024;        // 전체 페이지 최대 8MB
const FETCH_TIMEOUT = 15000;                   // 리소스 fetch 타임아웃 15초
const PAGE_TIMEOUT = 25000;                    // 전체 페이지 처리 타임아웃 25초
const HEARTBEAT_INTERVAL = 25000;              // 하트비트 간격 25초
const MAX_INLINE_IMAGES = 30;                  // 인라인할 이미지 최대 개수

// ── MIME 타입 매핑 ──
const MIME_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.css': 'text/css', '.js': 'text/javascript',
};

function guessMime(url, contentType) {
  if (contentType && !contentType.includes('octet-stream')) return contentType.split(';')[0].trim();
  try {
    const ext = new URL(url).pathname.match(/\.[a-z0-9]+$/i);
    if (ext && MIME_EXT[ext[0].toLowerCase()]) return MIME_EXT[ext[0].toLowerCase()];
  } catch {}
  return 'application/octet-stream';
}

// ── 안전한 fetch (타임아웃 + 크기 제한) ──
async function safeFetch(url, opts = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeout || FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': opts.accept || '*/*',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // 크기 제한 체크
    const cl = parseInt(res.headers.get('content-length') || '0', 10);
    if (cl > (opts.maxSize || MAX_RESOURCE_SIZE)) throw new Error('Too large');

    return res;
  } finally {
    clearTimeout(timeout);
  }
}

// ── 리소스를 data URI로 변환 ──
async function toDataUri(url) {
  try {
    const res = await safeFetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_RESOURCE_SIZE) return null;
    const mime = guessMime(url, res.headers.get('content-type'));
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

// ── CSS 내 url() 참조를 인라인 ──
async function inlineCssUrls(css, baseUrl) {
  const urlPattern = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
  const matches = [...css.matchAll(urlPattern)];
  const replacements = new Map();

  await Promise.all(matches.map(async (m) => {
    const raw = m[1];
    if (raw.startsWith('data:')) return;
    try {
      const abs = new URL(raw, baseUrl).href;
      const dataUri = await toDataUri(abs);
      if (dataUri) replacements.set(m[0], `url("${dataUri}")`);
    } catch {}
  }));

  let result = css;
  for (const [from, to] of replacements) {
    result = result.split(from).join(to);
  }
  return result;
}

// ── 외부 CSS를 인라인 <style>로 변환 ──
async function inlineStylesheets(doc, baseUrl) {
  const links = [...doc.querySelectorAll('link[rel="stylesheet"], link[rel="preload"][as="style"]')];
  for (const link of links) {
    const href = link.getAttribute('href');
    if (!href) continue;
    try {
      const abs = new URL(href, baseUrl).href;
      const res = await safeFetch(abs, { accept: 'text/css' });
      let css = await res.text();
      css = await inlineCssUrls(css, abs);
      const style = doc.createElement('style');
      style.textContent = css;
      link.replaceWith(style);
    } catch {
      link.remove(); // 실패한 CSS는 제거
    }
  }
}

// ── 이미지를 data URI로 인라인 ──
async function inlineImages(doc, baseUrl) {
  const imgs = [...doc.querySelectorAll('img[src]')].slice(0, MAX_INLINE_IMAGES);
  await Promise.all(imgs.map(async (img) => {
    const src = img.getAttribute('src');
    if (!src || src.startsWith('data:')) return;
    try {
      const abs = new URL(src, baseUrl).href;
      const dataUri = await toDataUri(abs);
      if (dataUri) img.setAttribute('src', dataUri);
      else img.removeAttribute('src');
    } catch {
      img.removeAttribute('src');
    }
  }));

  // srcset도 제거 (인라인 불가능)
  doc.querySelectorAll('[srcset]').forEach(el => el.removeAttribute('srcset'));
}

// ── 스크립트 제거 (보안 + 가벼움) ──
function stripScripts(doc) {
  doc.querySelectorAll('script, noscript').forEach(el => el.remove());
  // 인라인 이벤트 핸들러 제거
  const allEls = doc.querySelectorAll('*');
  allEls.forEach(el => {
    const attrs = [...el.attributes];
    attrs.forEach(a => {
      if (a.name.startsWith('on')) el.removeAttribute(a.name);
    });
  });
}

// ── 상대 URL을 절대 URL로 변환 (남은 href들) ──
function absolutifyUrls(doc, baseUrl) {
  // <a> 태그의 href를 절대 경로로
  doc.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('data:')) return;
    try {
      a.setAttribute('href', new URL(href, baseUrl).href);
    } catch {}
  });
  // <form> action
  doc.querySelectorAll('form[action]').forEach(f => {
    try { f.setAttribute('action', new URL(f.getAttribute('action'), baseUrl).href); } catch {}
  });
}

// ── 메인: URL을 인라인 HTML로 변환 ──
async function renderPage(url) {
  const start = Date.now();

  // 1. 페이지 fetch
  const res = await safeFetch(url, {
    accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    timeout: PAGE_TIMEOUT,
  });

  const finalUrl = res.url || url; // 리다이렉트 후 최종 URL
  const contentType = res.headers.get('content-type') || '';

  // HTML이 아닌 경우 (이미지, PDF 등)
  if (!contentType.includes('html') && !contentType.includes('xhtml')) {
    // 이미지면 직접 보여주기
    if (contentType.startsWith('image/')) {
      const buf = Buffer.from(await res.arrayBuffer());
      const dataUri = `data:${contentType.split(';')[0]};base64,${buf.toString('base64')}`;
      return {
        html: `<!DOCTYPE html><html><body style="margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#111"><img src="${dataUri}" style="max-width:100%;max-height:100vh;object-fit:contain"></body></html>`,
        title: new URL(finalUrl).pathname.split('/').pop() || 'Image',
        url: finalUrl,
        elapsed: Date.now() - start,
      };
    }
    // 그 외는 다운로드 불가 안내
    return {
      html: `<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem;color:#ccc;background:#111"><h2>이 형식은 에이전트 모드에서 표시할 수 없습니다</h2><p>Content-Type: ${contentType}</p><p><a href="${finalUrl}" style="color:#7af">${finalUrl}</a></p></body></html>`,
      title: 'Unsupported',
      url: finalUrl,
      elapsed: Date.now() - start,
    };
  }

  const html = await res.text();
  if (html.length > MAX_PAGE_SIZE) {
    return {
      html: `<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem;color:#ccc;background:#111"><h2>페이지가 너무 큽니다</h2><p>${(html.length / 1024 / 1024).toFixed(1)}MB — 에이전트 모드 제한 ${MAX_PAGE_SIZE / 1024 / 1024}MB</p></body></html>`,
      title: 'Too Large',
      url: finalUrl,
      elapsed: Date.now() - start,
    };
  }

  // 2. DOM 파싱
  const dom = new JSDOM(html, { url: finalUrl });
  const doc = dom.window.document;

  // 3. 가공
  stripScripts(doc);
  await Promise.all([
    inlineStylesheets(doc, finalUrl),
    inlineImages(doc, finalUrl),
  ]);
  absolutifyUrls(doc, finalUrl);

  // 4. <base> 태그 추가 (남은 상대 경로 대비)
  let base = doc.querySelector('base');
  if (!base) {
    base = doc.createElement('base');
    const head = doc.querySelector('head') || doc.documentElement;
    head.prepend(base);
  }
  base.setAttribute('href', finalUrl);

  // 5. 결과 추출
  const title = (doc.querySelector('title')?.textContent || new URL(finalUrl).hostname).trim();
  const output = dom.serialize();

  return {
    html: output,
    title,
    url: finalUrl,
    elapsed: Date.now() - start,
    size: Buffer.byteLength(output, 'utf8'),
  };
}

// ── WebSocket 에이전트 핸들러 ──
function handleAgentConnection(ws) {
  let alive = true;
  let hbTimer = null;

  // 하트비트
  hbTimer = setInterval(() => {
    if (!alive) { ws.terminate(); return; }
    alive = false;
    ws.ping();
  }, HEARTBEAT_INTERVAL);

  ws.on('pong', () => { alive = true; });

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      return;
    }

    if (msg.type === 'navigate') {
      const id = msg.id || Date.now().toString(36);
      try {
        // 진행 알림
        ws.send(JSON.stringify({ type: 'loading', id, url: msg.url }));
        const result = await renderPage(msg.url);
        ws.send(JSON.stringify({ type: 'page', id, ...result }));
      } catch (err) {
        ws.send(JSON.stringify({
          type: 'error', id, url: msg.url,
          message: err.message || 'Fetch failed',
        }));
      }
      return;
    }

    if (msg.type === 'resolve') {
      // 서버 IP 확인 요청 — 클라이언트가 DNS 차단 대비로 IP를 캐시하기 위함
      try {
        const dns = require('dns').promises;
        const { address } = await dns.lookup(msg.hostname || 'localhost');
        ws.send(JSON.stringify({ type: 'resolved', hostname: msg.hostname, ip: address }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'resolve-error', hostname: msg.hostname, message: err.message }));
      }
      return;
    }
  });

  ws.on('close', () => {
    clearInterval(hbTimer);
  });

  ws.on('error', () => {
    clearInterval(hbTimer);
  });

  // 연결 확인 메시지
  ws.send(JSON.stringify({ type: 'connected', ts: Date.now(), version: '1.0.0' }));
}

module.exports = { handleAgentConnection, renderPage };
