/**
 * Geo-Zebra Agent — 서버사이드 웹페이지 프록시 에이전트
 *
 * 클라이언트와 단일 WebSocket으로 연결.
 * 클라이언트 요청 시 서버에서 페이지를 fetch → HTML/CSS/이미지 인라인화 → 전송.
 * DNS 차단 환경에서도 기존 WebSocket이 살아있으면 계속 서핑 가능.
 *
 * ★ "항상 성공" 전략:
 *   HTML fetch만 성공하면 반드시 페이지를 전송한다.
 *   CSS/이미지 인라인은 남은 시간 예산 안에서 최선을 다하되,
 *   시간이 부족하면 인라인 없이 기본 HTML을 보낸다. (못생겨도 링크는 작동)
 */

const { JSDOM } = require('jsdom');
const { URL } = require('url');

// ── 상수 ──
const MAX_RESOURCE_SIZE = 2 * 1024 * 1024;   // 개별 리소스 최대 2MB
const MAX_PAGE_SIZE = 8 * 1024 * 1024;        // 전체 페이지 최대 8MB
const FETCH_TIMEOUT = 6000;                    // 리소스 fetch 타임아웃 6초
const PAGE_TIMEOUT = 15000;                    // HTML fetch 타임아웃 15초
const TOTAL_DEADLINE = 25000;                  // 전체 처리 데드라인 25초
const INLINE_BUDGET = 12000;                   // CSS/이미지 인라인 시간 예산 12초
const MIN_INLINE_BUDGET = 2000;                // 최소 인라인 예산 2초 (이하면 건너뜀)
const HEARTBEAT_INTERVAL = 25000;              // 하트비트 간격 25초
const MAX_INLINE_IMAGES = 15;                  // 인라인할 이미지 최대 개수
const MAX_INLINE_CSS = 6;                      // 인라인할 CSS 최대 개수
const MAX_CSS_URL_REFS = 10;                   // CSS 내 url() 인라인 최대 개수

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

// ── 데드라인 레이스: promise vs 시간 제한. 시간 초과 시 fallback 값 반환 ──
function raceDeadline(promise, ms, fallback) {
  if (ms <= 0) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(fallback); }
    );
  });
}

// ── CSS 내 url() 참조를 인라인 (개수 제한) ──
async function inlineCssUrls(css, baseUrl) {
  const urlPattern = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
  const matches = [...css.matchAll(urlPattern)].slice(0, MAX_CSS_URL_REFS);
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

// ── 외부 CSS를 인라인 <style>로 변환 (병렬 + 개수 제한) ──
async function inlineStylesheets(doc, baseUrl) {
  const links = [...doc.querySelectorAll('link[rel="stylesheet"], link[rel="preload"][as="style"]')].slice(0, MAX_INLINE_CSS);
  // 남은 CSS link는 절대 URL로 변환 (제한 초과분도 로드는 시도할 수 있게)
  doc.querySelectorAll('link[rel="stylesheet"], link[rel="preload"][as="style"]').forEach((el, i) => {
    if (i >= MAX_INLINE_CSS) {
      const href = el.getAttribute('href');
      if (href) {
        try { el.setAttribute('href', new URL(href, baseUrl).href); } catch {}
      }
    }
  });

  await Promise.all(links.map(async (link) => {
    const href = link.getAttribute('href');
    if (!href) { link.remove(); return; }
    try {
      const abs = new URL(href, baseUrl).href;
      const res = await safeFetch(abs, { accept: 'text/css' });
      let css = await res.text();
      css = await inlineCssUrls(css, abs);
      const style = doc.createElement('style');
      style.textContent = css;
      link.replaceWith(style);
    } catch {
      // 실패한 CSS는 절대 URL로 남겨둠 (브라우저가 직접 로드 시도할 수 있게)
      try { link.setAttribute('href', new URL(href, baseUrl).href); } catch {}
    }
  }));
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
      else img.setAttribute('src', abs); // 실패해도 절대 URL로
    } catch {
      // 절대 URL로 남겨둠
      try { img.setAttribute('src', new URL(src, baseUrl).href); } catch {}
    }
  }));

  // srcset → 절대 URL로 변환 (인라인 불가능하지만 URL은 살려둠)
  doc.querySelectorAll('[srcset]').forEach(el => {
    const srcset = el.getAttribute('srcset');
    try {
      const updated = srcset.replace(/(\S+)(\s+[\d.]+[wx])/g, (match, url, descriptor) => {
        try { return new URL(url, baseUrl).href + descriptor; } catch { return match; }
      });
      el.setAttribute('srcset', updated);
    } catch {
      el.removeAttribute('srcset');
    }
  });
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
  // <link> (favicon 등)
  doc.querySelectorAll('link[href]').forEach(link => {
    const href = link.getAttribute('href');
    if (href && !href.startsWith('data:')) {
      try { link.setAttribute('href', new URL(href, baseUrl).href); } catch {}
    }
  });
  // <img> src (아직 절대가 아닌 것들)
  doc.querySelectorAll('img[src]').forEach(img => {
    const src = img.getAttribute('src');
    if (src && !src.startsWith('data:') && !src.startsWith('http')) {
      try { img.setAttribute('src', new URL(src, baseUrl).href); } catch {}
    }
  });
}

// ── 메인: URL을 인라인 HTML로 변환 (항상 성공 전략) ──
async function renderPage(url) {
  const start = Date.now();
  const deadline = start + TOTAL_DEADLINE;
  let lite = false; // CSS/이미지 인라인을 건너뛴 경우

  // ═══ 1단계: HTML fetch (필수 — 이게 실패하면 진짜 에러) ═══
  const res = await safeFetch(url, {
    accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    timeout: PAGE_TIMEOUT,
  });

  const finalUrl = res.url || url;
  const contentType = res.headers.get('content-type') || '';

  // HTML이 아닌 경우 (이미지, PDF 등)
  if (!contentType.includes('html') && !contentType.includes('xhtml')) {
    if (contentType.startsWith('image/')) {
      const buf = Buffer.from(await res.arrayBuffer());
      const dataUri = `data:${contentType.split(';')[0]};base64,${buf.toString('base64')}`;
      return {
        html: `<!DOCTYPE html><html><body style="margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#111"><img src="${dataUri}" style="max-width:100%;max-height:100vh;object-fit:contain"></body></html>`,
        title: new URL(finalUrl).pathname.split('/').pop() || 'Image',
        url: finalUrl, elapsed: Date.now() - start,
      };
    }
    return {
      html: `<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem;color:#ccc;background:#111"><h2>이 형식은 에이전트 모드에서 표시할 수 없습니다</h2><p>Content-Type: ${contentType}</p><p><a href="${finalUrl}" style="color:#7af">${finalUrl}</a></p></body></html>`,
      title: 'Unsupported', url: finalUrl, elapsed: Date.now() - start,
    };
  }

  const html = await res.text();
  if (html.length > MAX_PAGE_SIZE) {
    return {
      html: `<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem;color:#ccc;background:#111"><h2>페이지가 너무 큽니다</h2><p>${(html.length / 1024 / 1024).toFixed(1)}MB — 에이전트 모드 제한 ${MAX_PAGE_SIZE / 1024 / 1024}MB</p></body></html>`,
      title: 'Too Large', url: finalUrl, elapsed: Date.now() - start,
    };
  }

  // ═══ 2단계: DOM 파싱 + 필수 처리 (빠름, 항상 실행) ═══
  const dom = new JSDOM(html, { url: finalUrl });
  const doc = dom.window.document;

  stripScripts(doc);
  absolutifyUrls(doc, finalUrl);

  // <base> 태그 추가 (남은 상대 경로 대비)
  let base = doc.querySelector('base');
  if (!base) {
    base = doc.createElement('base');
    const head = doc.querySelector('head') || doc.documentElement;
    head.prepend(base);
  }
  base.setAttribute('href', finalUrl);

  // ═══ 3단계: CSS/이미지 인라인 (시간 예산 내에서 최선) ═══
  const remaining = deadline - Date.now();
  const inlineBudget = Math.min(remaining - 2000, INLINE_BUDGET); // 직렬화에 2초 여유

  if (inlineBudget >= MIN_INLINE_BUDGET) {
    // 시간 예산이 있으면 CSS와 이미지를 병렬로 인라인 시도
    // raceDeadline: 예산 내에 끝나면 결과 사용, 아니면 무시하고 진행
    const inlineWork = Promise.all([
      inlineStylesheets(doc, finalUrl),
      inlineImages(doc, finalUrl),
    ]);
    const result = await raceDeadline(inlineWork, inlineBudget, 'timeout');
    if (result === 'timeout') {
      lite = true;
      console.log('[Agent] 인라인 예산 초과, 라이트 모드로 전송:', finalUrl);
    }
  } else {
    // 시간이 거의 없으면 인라인 건너뜀
    lite = true;
    console.log('[Agent] 인라인 예산 부족, 라이트 모드로 전송:', finalUrl);
  }

  // ═══ 4단계: 직렬화 + 결과 반환 (항상 성공) ═══
  const title = (doc.querySelector('title')?.textContent || new URL(finalUrl).hostname).trim();
  const output = dom.serialize();

  return {
    html: output,
    title,
    url: finalUrl,
    elapsed: Date.now() - start,
    size: Buffer.byteLength(output, 'utf8'),
    lite, // 클라이언트에게 라이트 모드 여부 전달
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
        const message = err.message || 'Fetch failed';
        console.error('[Agent] renderPage error for', msg.url, ':', message);
        ws.send(JSON.stringify({
          type: 'error', id, url: msg.url, message,
        }));
      }
      return;
    }

    if (msg.type === 'resolve') {
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
  ws.send(JSON.stringify({ type: 'connected', ts: Date.now(), version: '1.1.0' }));
}

module.exports = { handleAgentConnection, renderPage };
