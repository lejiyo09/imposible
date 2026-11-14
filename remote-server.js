// Geo-Zebra 원격 브라우저 (탭 분할 + 팝업 + 소리 + 영구 프로필)
// 여러 탭을 동시에 스트리밍하고, 클라이언트에서 화면을 분할해 각 칸에 다른 탭을 띄운다.
// - 각 프레임에 탭 id를 붙여 전송 → 클라이언트가 칸별로 렌더
// - 입력은 대상 탭 id를 함께 보냄 → 클릭한 칸으로 전달
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
const USER_DATA_DIR = path.join(__dirname, 'chrome-profile');
const AUDIO_DEVICE = process.env.AUDIO_DEVICE || 'CABLE Output(VB-Audio Virtual Cable)';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── 공유 브라우저 상태 ──
let context = null;
const tabs = new Map();      // id → { id, page, cdp, streaming }
let nextTabId = 0;
const viewers = new Set();   // 각 ws 에 ws.visible(Set<tabId>) 를 둔다

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
        format: 'jpeg', quality: 55,
        maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1,
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
  const entry = { id, page, cdp, streaming: false };
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

async function getContext() {
  if (context) return context;
  const opts = {
    headless: false,
    viewport: VIEWPORT,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    userAgent: UA,
    args: ['--disable-gpu', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  };
  try {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, { ...opts, channel: 'chrome' });
    console.log('[remote] 실제 Chrome + 영구 프로필로 실행');
  } catch (_) {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, opts);
    console.log('[remote] 번들 Chromium + 영구 프로필로 실행');
  }
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
  });
  context.on('page', attachPage);
  for (const p of context.pages()) await attachPage(p);
  return context;
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
  if (req.url.startsWith('/audio')) audioWss.handleUpgrade(req, socket, head, (ws) => audioWss.emit('connection', ws, req));
  else if (req.url.startsWith('/remote')) wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  else socket.destroy();
});

wss.on('connection', async (ws) => {
  console.log('[remote] 뷰어 연결됨');
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
  });
});

process.on('uncaughtException', (e) => console.error('[uncaught]', e && e.message));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e && (e.message || e)));
