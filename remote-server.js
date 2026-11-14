// Geo-Zebra 원격 브라우저 (탭 + 팝업 + 소리 + 영구 프로필)
// 서버에서 실제 Chrome을 띄우고 화면을 WebSocket으로 스트리밍한다.
// - 영구 프로필: 쿠키/기기신뢰 유지 → 네이버 등 "새 기기" 잠금 방지, 로그인 유지
// - 여러 탭 + 팝업(새 창) 자동 인식
// - 입력은 Playwright 고수준 API, 소리는 ffmpeg로 가상 케이블 캡처
//
// 실행: node remote-server.js   접속: http://localhost:3001/remote.html

const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { chromium } = require('playwright');

const PORT = process.env.REMOTE_PORT || 3001;
const VIEWPORT = { width: 1280, height: 720 };
const START_URL = 'https://www.google.com';
const USER_DATA_DIR = path.join(__dirname, 'chrome-profile'); // 영구 프로필 폴더
// 가상 오디오 케이블의 "녹음(출력)" 장치 이름. 다르면 AUDIO_DEVICE 환경변수로 지정.
const AUDIO_DEVICE = process.env.AUDIO_DEVICE || 'CABLE Output (VB-Audio Virtual Cable)';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── 공유 브라우저 상태 (단일 사용자: 하나의 브라우저를 여러 뷰어가 공유) ──
let context = null;              // 영구 컨텍스트 (브라우저)
const tabs = new Map();          // id → { id, page, cdp, streaming }
let activeId = null;
let nextTabId = 0;
const viewers = new Set();       // /remote WebSocket 클라이언트들

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const ws of viewers) if (ws.readyState === 1) ws.send(s);
}
function broadcastFrame(dataB64) {
  const s = JSON.stringify({ type: 'frame', data: dataB64 });
  for (const ws of viewers) if (ws.readyState === 1) ws.send(s);
}
function active() {
  return tabs.get(activeId);
}

async function sendTabList() {
  const list = [];
  for (const t of tabs.values()) {
    let title = '';
    try { title = await t.page.title(); } catch (_) {}
    const url = t.page.url();
    list.push({ id: t.id, title: title || url || '새 탭', url, active: t.id === activeId });
  }
  broadcast({ type: 'tabs', tabs: list, activeId });
}

async function setActive(id) {
  const entry = tabs.get(id);
  if (!entry) return;
  // 다른 탭 스트리밍 중지
  for (const t of tabs.values()) {
    if (t.id !== id && t.streaming) {
      t.streaming = false;
      try { await t.cdp.send('Page.stopScreencast'); } catch (_) {}
    }
  }
  activeId = id;
  entry.streaming = true;
  try {
    await entry.cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 60,
      maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1,
    });
  } catch (_) {}
  sendTabList();
}

// 새 페이지(수동 새 탭 + 팝업/새 창)를 모두 여기서 등록
async function attachPage(page) {
  if (page.__attached) return;
  page.__attached = true;
  const id = ++nextTabId;
  let cdp;
  try { cdp = await context.newCDPSession(page); } catch (_) { return; }
  const entry = { id, page, cdp, streaming: false };
  tabs.set(id, entry);

  cdp.on('Page.screencastFrame', async (frame) => {
    if (entry.streaming) broadcastFrame(frame.data);
    try { await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }); } catch (_) {}
  });

  page.on('load', () => sendTabList());
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) sendTabList(); });
  page.on('close', () => {
    tabs.delete(id);
    if (activeId === id) {
      const first = tabs.keys().next();
      if (!first.done) setActive(first.value);
    }
    sendTabList();
  });

  // 팝업/새 탭이 뜨면 자동으로 그 탭으로 전환해서 보이게
  await setActive(id);
}

async function getContext() {
  if (context) return context;
  const opts = {
    headless: false,            // 소리 출력 + 봇 탐지 완화를 위해 headful
    viewport: VIEWPORT,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    userAgent: UA,
    args: [
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  };
  try {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, { ...opts, channel: 'chrome' });
    console.log('[remote] 실제 Chrome + 영구 프로필로 실행');
  } catch (_) {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, opts);
    console.log('[remote] 번들 Chromium + 영구 프로필로 실행');
  }
  // 자동화 탐지 신호 숨기기
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  // 이후 생기는 모든 페이지(팝업 포함) 자동 등록
  context.on('page', attachPage);
  // 런치 시 이미 열려 있는 페이지 등록
  for (const p of context.pages()) await attachPage(p);
  return context;
}

// ── 오디오 캡처: ffmpeg로 가상 케이블의 소리를 받아 /audio 로 중계 ──
const audioClients = new Set();
let ffmpeg = null;
function startAudioCapture() {
  if (ffmpeg) return;
  console.log('[audio] ffmpeg 시작 — 장치:', AUDIO_DEVICE);
  ffmpeg = spawn('ffmpeg', [
    '-f', 'dshow', '-i', 'audio=' + AUDIO_DEVICE,
    '-ac', '2', '-ar', '48000',
    '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-f', 's16le', '-',
  ]);
  ffmpeg.stdout.on('data', (chunk) => {
    for (const c of audioClients) if (c.readyState === 1) c.send(chunk);
  });
  ffmpeg.stderr.on('data', () => {});
  ffmpeg.on('close', (code) => { console.log('[audio] ffmpeg 종료', code); ffmpeg = null; });
  ffmpeg.on('error', (e) => { console.error('[audio] ffmpeg 오류:', e.message, '— ffmpeg 설치 확인'); ffmpeg = null; });
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = app.listen(PORT, () => {
  console.log(`Remote browser on http://localhost:${PORT}/remote.html`);
});

const wss = new WebSocketServer({ noServer: true });
const audioWss = new WebSocketServer({ noServer: true });

audioWss.on('connection', (ws) => {
  audioClients.add(ws);
  startAudioCapture();
  ws.on('close', () => audioClients.delete(ws));
});

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/audio')) {
    audioWss.handleUpgrade(req, socket, head, (ws) => audioWss.emit('connection', ws, req));
  } else if (req.url.startsWith('/remote')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', async (ws) => {
  console.log('[remote] 뷰어 연결됨');
  viewers.add(ws);
  try {
    await getContext();
    if (tabs.size === 0) {
      const p = await context.newPage();      // 'page' 이벤트로 attachPage 실행됨
      await p.goto(START_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    } else {
      // 빈 탭이면 시작 페이지로
      const a = active();
      if (a && a.page.url().startsWith('about:')) {
        await a.page.goto(START_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
      await setActive(activeId); // 새 뷰어에게 즉시 프레임 보내기 (키프레임 강제)
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
    const a = active();
    try {
      switch (msg.type) {
        // ── 입력 (활성 탭에 적용) ──
        case 'move':
          if (a) await a.page.mouse.move(msg.x, msg.y);
          break;
        case 'down':
          if (a) { await a.page.mouse.move(msg.x, msg.y); await a.page.mouse.down({ button: msg.button || 'left' }); }
          break;
        case 'up':
          if (a) { if (typeof msg.x === 'number') await a.page.mouse.move(msg.x, msg.y); await a.page.mouse.up({ button: msg.button || 'left' }); }
          break;
        case 'wheel':
          if (a) await a.page.mouse.wheel(msg.dx || 0, msg.dy || 0);
          break;
        case 'text':
          if (a) await a.page.keyboard.insertText(msg.text);
          break;
        case 'press':
          if (a) await a.page.keyboard.press(msg.key);
          break;
        // ── 탐색 (활성 탭) ──
        case 'navigate':
          if (a) await a.page.goto(msg.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
          break;
        case 'back':
          if (a) await a.page.goBack().catch(() => {});
          break;
        case 'forward':
          if (a) await a.page.goForward().catch(() => {});
          break;
        case 'reload':
          if (a) await a.page.reload().catch(() => {});
          break;
        // ── 탭 ──
        case 'newtab': {
          const p = await context.newPage();
          await p.goto(msg.url || START_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
          break;
        }
        case 'switchtab':
          if (tabs.has(msg.id)) await setActive(msg.id);
          break;
        case 'closetab': {
          const t = tabs.get(msg.id);
          if (t) await t.page.close().catch(() => {});
          break;
        }
      }
    } catch (e) {
      console.error('[remote] 처리 오류:', e.message);
    }
  });

  ws.on('close', () => {
    viewers.delete(ws);
    console.log('[remote] 뷰어 연결 해제');
    // 뷰어가 모두 나가도 브라우저는 유지 (로그인/탭 보존). 스트리밍만 멈춤.
    if (viewers.size === 0) {
      for (const t of tabs.values()) {
        if (t.streaming) { t.streaming = false; t.cdp.send('Page.stopScreencast').catch(() => {}); }
      }
    }
  });
});

process.on('uncaughtException', (e) => console.error('[uncaught]', e && e.message));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e && (e.message || e)));
