// Geo-Zebra 원격 브라우저 (탭 분할 + 팝업 + 소리 + 영구 프로필)
// 여러 탭을 동시에 스트리밍하고, 클라이언트에서 화면을 분할해 각 칸에 다른 탭을 띄운다.
// - 각 프레임에 탭 id를 붙여 전송 → 클라이언트가 칸별로 렌더
// - 입력은 대상 탭 id를 함께 보냄 → 클릭한 칸으로 전달
//
// 실행: node remote-server.js   접속: http://localhost:3001/remote.html

const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const { WebSocketServer } = require('ws');
const { chromium } = require('playwright');

const PORT = process.env.REMOTE_PORT || 3001;
const VIEWPORT = { width: 1280, height: 720 };
const START_URL = 'https://www.google.com';
const USER_DATA_DIR = path.join(__dirname, 'chrome-profile');
const AUDIO_DEVICE = process.env.AUDIO_DEVICE || 'CABLE Output(VB-Audio Virtual Cable)';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── 접속 비밀번호 (주소만 아는 사람이 쓰지 못하게) ──
// GEO_PASSWORD 환경변수 > secret.txt 파일 > 자동 생성 순
const SECRET_FILE = path.join(__dirname, 'secret.txt');
let ACCESS = (process.env.GEO_PASSWORD || '').trim();
if (!ACCESS) { try { ACCESS = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (_) {} }
if (!ACCESS) {
  ACCESS = Math.random().toString(36).slice(2, 10);
  try { fs.writeFileSync(SECRET_FILE, ACCESS); } catch (_) {}
}
console.log('[auth] 접속 비밀번호:', ACCESS, '  (secret.txt 파일이나 GEO_PASSWORD 로 변경 가능)');

// ── 공유 브라우저 상태 ──
let context = null;
const tabs = new Map();      // id → { id, page, cdp, streaming }
let nextTabId = 0;
const viewers = new Set();   // 각 ws 에 ws.visible(Set<tabId>) 를 둔다
let idleTimer = null;        // 접속자 없을 때 브라우저 종료 예약

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const ws of viewers) if (ws.readyState === 1) ws.send(s);
}

async function sendTabList() {
  const list = [];
  for (const t of tabs.values()) {
    let title = '';
    try { title = await t.page.title(); } catch (_) {}
    list.push({ id: t.id, title: title || t.page.url() || '새 탭', url: t.page.url() });
  }
  broadcast({ type: 'tabs', tabs: list });
}

// 어떤 뷰어든 보고 있는 탭만 스트리밍 (유니온)
function recomputeStreaming() {
  const wanted = new Set();
  for (const v of viewers) if (v.visible) for (const id of v.visible) wanted.add(id);
  for (const t of tabs.values()) {
    const should = wanted.has(t.id);
    if (should && !t.streaming) {
      t.streaming = true;
      t.cdp.send('Page.startScreencast', {
        format: 'jpeg', quality: 45,  // 터널(인터넷) 속도 위해 화질 다소 낮춤
        maxWidth: t.w || VIEWPORT.width, maxHeight: t.h || VIEWPORT.height, everyNthFrame: 1,
      }).catch(() => {});
    } else if (!should && t.streaming) {
      t.streaming = false;
      t.cdp.send('Page.stopScreencast').catch(() => {});
    }
  }
}

// 새 페이지(수동 새 탭 + 팝업) 등록
async function attachPage(page) {
  if (page.__attached) return;
  page.__attached = true;
  const id = ++nextTabId;
  let cdp;
  try { cdp = await context.newCDPSession(page); } catch (_) { return; }
  const entry = { id, page, cdp, streaming: false, w: VIEWPORT.width, h: VIEWPORT.height };
  tabs.set(id, entry);

  cdp.on('Page.screencastFrame', async (frame) => {
    const s = JSON.stringify({ type: 'frame', id, data: frame.data });
    for (const v of viewers) if (v.readyState === 1 && v.visible && v.visible.has(id)) v.send(s);
    try { await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }); } catch (_) {}
  });

  page.on('load', () => sendTabList());
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) sendTabList(); });
  page.on('close', () => {
    tabs.delete(id);
    recomputeStreaming();
    sendTabList();
    broadcast({ type: 'closed', id });
  });

  sendTabList();
  broadcast({ type: 'opened', id }); // 클라이언트가 빈 칸에 자동 배치 (팝업 보이게)
}

async function launchCtx() {
  const opts = {
    headless: false,
    viewport: VIEWPORT,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    userAgent: UA,
    args: ['--disable-gpu', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  };
  try { return await chromium.launchPersistentContext(USER_DATA_DIR, { ...opts, channel: 'chrome' }); }
  catch (_) { return await chromium.launchPersistentContext(USER_DATA_DIR, opts); }
}

let contextPromise = null;
async function getContext() {
  if (context) return context;
  if (contextPromise) return contextPromise;        // 동시 실행 방지
  contextPromise = (async () => {
    let c;
    try {
      c = await launchCtx();
    } catch (e) {
      console.log('[remote] 실행 실패, 1초 후 재시도:', e.message);
      await new Promise((r) => setTimeout(r, 1000)); // 프로필 잠금 해제 대기
      c = await launchCtx();
    }
    console.log('[remote] Chrome 실행됨');
    await c.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      window.chrome = window.chrome || { runtime: {} };
    });
    c.on('page', attachPage);
    c.on('close', onContextClosed);   // Chrome 창이 닫히면 복구
    context = c;
    for (const p of c.pages()) await attachPage(p);
    return c;
  })();
  try { return await contextPromise; }
  finally { contextPromise = null; }
}

// Chrome 창이 닫히면(실수로 닫거나 크래시) 상태를 초기화하고, 보는 사람이 있으면 다시 띄운다
let relaunching = false;
async function onContextClosed() {
  console.log('[remote] Chrome 창 닫힘 — 상태 초기화');
  context = null;
  tabs.clear();
  nextTabId = 0;
  if (viewers.size > 0 && !relaunching) {
    relaunching = true;
    try {
      await new Promise((r) => setTimeout(r, 1000));
      await getContext();
      const p = await context.newPage();
      await p.goto(START_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    } catch (e) {
      console.error('[remote] 재실행 실패:', e.message);
    }
    relaunching = false;
  }
}

// 접속자가 모두 나가면 잠시 후 Chrome 종료 (로그인은 프로필에 저장돼 유지)
function scheduleShutdown() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    idleTimer = null;
    if (viewers.size > 0 || !context) return;
    console.log('[remote] 접속자 없음 — Chrome 종료 (대기만 유지)');
    try { await context.close(); } catch (_) {}
    context = null;
    tabs.clear();
    nextTabId = 0;
    if (ffmpeg) { try { ffmpeg.kill(); } catch (_) {} ffmpeg = null; }
  }, 30000); // 30초 유예 (끊겼다 바로 재접속하는 경우 대비)
}

// ── 오디오 (전체 소리 하나로 중계; 탭별 분리는 아님) ──
const audioClients = new Set();
let ffmpeg = null;
function startAudioCapture() {
  if (ffmpeg) return;
  console.log('[audio] ffmpeg 시작 — 장치:', AUDIO_DEVICE);
  ffmpeg = spawn('ffmpeg', [
    '-f', 'dshow', '-audio_buffer_size', '80', '-i', 'audio=' + AUDIO_DEVICE, // 캡처 버퍼 80ms로 지연 축소
    '-ac', '2', '-ar', '48000',
    '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-f', 's16le', '-',
  ]);
  ffmpeg.stdout.on('data', (chunk) => { for (const c of audioClients) if (c.readyState === 1) c.send(chunk); });
  ffmpeg.stderr.on('data', () => {});
  ffmpeg.on('close', (code) => { console.log('[audio] ffmpeg 종료', code); ffmpeg = null; });
  ffmpeg.on('error', (e) => { console.error('[audio] ffmpeg 오류:', e.message, '— ffmpeg 설치 확인'); ffmpeg = null; });
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = app.listen(PORT, () => console.log(`Remote browser on http://localhost:${PORT}/remote.html`));

const wss = new WebSocketServer({ noServer: true });
const audioWss = new WebSocketServer({ noServer: true });
audioWss.on('connection', (ws) => { audioClients.add(ws); startAudioCapture(); ws.on('close', () => audioClients.delete(ws)); });
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  const ok = (u.searchParams.get('token') || '') === ACCESS;  // 비밀번호 확인
  const target = u.pathname.startsWith('/audio') ? audioWss
               : u.pathname.startsWith('/remote') ? wss : null;
  if (!target) { socket.destroy(); return; }
  target.handleUpgrade(req, socket, head, (ws) => {
    if (!ok) { try { ws.close(4401, 'unauthorized'); } catch (_) {} return; } // 비번 틀리면 거절
    target.emit('connection', ws, req);
  });
});

wss.on('connection', async (ws) => {
  console.log('[remote] 뷰어 연결됨');
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } // 종료 예약 취소
  viewers.add(ws);
  ws.visible = new Set();
  let lastCursorCheck = 0;
  try {
    await getContext();
    if (tabs.size === 0) {
      const p = await context.newPage();
      await p.goto(START_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    } else {
      const first = [...tabs.values()][0];
      if (first && first.page.url().startsWith('about:')) {
        await first.page.goto(START_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
    }
    sendTabList();
  } catch (e) {
    console.error('[remote] 초기화 오류:', e.message);
    ws.close();
    return;
  }

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      // 뷰어가 보고 있는 탭 집합 갱신
      if (msg.type === 'setvisible') {
        ws.visible = new Set(msg.ids || []);
        for (const id of ws.visible) { const t = tabs.get(id); if (t) t.streaming = false; } // 키프레임 강제
        recomputeStreaming();
        return;
      }
      if (msg.type === 'newtab') {
        const p = await context.newPage();
        await p.goto(msg.url || START_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
        return;
      }
      if (msg.type === 'closetab') {
        const t = tabs.get(msg.id);
        if (t) await t.page.close().catch(() => {});
        return;
      }
      if (msg.type === 'resize') {
        const t = tabs.get(msg.tab);
        if (t) {
          const w = Math.max(400, Math.min(1920, msg.width | 0));
          const h = Math.max(300, Math.min(1080, msg.height | 0));
          t.w = w; t.h = h;
          try { await t.page.setViewportSize({ width: w, height: h }); } catch (_) {}
          if (t.streaming) {               // 새 크기로 다시 스트리밍
            try { await t.cdp.send('Page.stopScreencast'); } catch (_) {}
            t.streaming = false;
            recomputeStreaming();
          }
        }
        return;
      }
      // 이하 입력/탐색은 대상 탭(msg.tab)에 적용
      const t = tabs.get(msg.tab);
      if (!t) return;
      const page = t.page;
      switch (msg.type) {
        case 'move':
          await page.mouse.move(msg.x, msg.y);
          {
            const now = Date.now();
            if (now - lastCursorCheck > 120) {
              lastCursorCheck = now;
              try {
                let cur = await page.evaluate(({ x, y }) => {
                  const el = document.elementFromPoint(x, y);
                  return el ? getComputedStyle(el).cursor : 'default';
                }, { x: msg.x, y: msg.y });
                if (!cur || cur.includes('url(')) cur = 'default';
                if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'cursor', id: msg.tab, cursor: cur }));
              } catch (_) {}
            }
          }
          break;
        case 'down': await page.mouse.move(msg.x, msg.y); await page.mouse.down({ button: msg.button || 'left' }); break;
        case 'up': if (typeof msg.x === 'number') await page.mouse.move(msg.x, msg.y); await page.mouse.up({ button: msg.button || 'left' }); break;
        case 'wheel': await page.mouse.wheel(msg.dx || 0, msg.dy || 0); break;
        case 'text': await page.keyboard.insertText(msg.text); break;
        case 'press': await page.keyboard.press(msg.key); break;
        case 'navigate': await page.goto(msg.url, { waitUntil: 'domcontentloaded' }).catch(() => {}); break;
        case 'back': await page.goBack().catch(() => {}); break;
        case 'forward': await page.goForward().catch(() => {}); break;
        case 'reload': await page.reload().catch(() => {}); break;
      }
    } catch (e) {
      console.error('[remote] 처리 오류:', e.message);
    }
  });

  ws.on('close', () => {
    viewers.delete(ws);
    recomputeStreaming(); // 아무도 안 보는 탭은 스트리밍 중지
    console.log('[remote] 뷰어 연결 해제');
    // 브라우저는 종료하지 않고 유지 (재실행 시 프로필 잠금 충돌 방지). 스트리밍만 멈춤.
  });
});

// 자동 업데이트: GitHub에 새 커밋이 있고 접속자가 없으면 종료 → 배치가 git pull 후 재시작
setInterval(() => {
  try {
    execSync('git fetch', { cwd: __dirname, stdio: 'ignore', timeout: 20000 });
    const local = execSync('git rev-parse HEAD', { cwd: __dirname }).toString().trim();
    const remote = execSync('git rev-parse origin/main', { cwd: __dirname }).toString().trim();
    if (local !== remote && viewers.size === 0) {
      console.log('[update] 새 버전 발견 — 재시작하여 적용');
      process.exit(0);
    }
  } catch (_) {}
}, 5 * 60 * 1000); // 5분마다 확인

process.on('uncaughtException', (e) => console.error('[uncaught]', e && e.message));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e && (e.message || e)));
