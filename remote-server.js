// Geo-Zebra 원격 브라우저 프로토타입 (MVP)
// 서버에서 실제 Chromium을 실행하고, 화면을 WebSocket으로 스트리밍한다.
// 입력(마우스/키보드)은 Playwright 고수준 API로 안정적으로 전달한다.
//
// 실행: node remote-server.js
// 접속: http://localhost:3001/remote.html

const express = require('express');
const path = require('path');
const { WebSocketServer } = require('ws');
const { chromium } = require('playwright');

const PORT = process.env.REMOTE_PORT || 3001;
const VIEWPORT = { width: 1280, height: 720 };
const START_URL = 'https://www.google.com';

// ── 브라우저는 서버당 1개만 띄우고 재사용 ──
let browser;
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    console.log('[remote] Chromium 실행...');
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browser;
}

// e.key(브라우저 키 이름) → Playwright 키 이름. 대부분 동일하므로 그대로 넘긴다.
function mapKey(key) {
  return key; // 'Enter', 'Backspace', 'ArrowLeft', 'Tab' 등 그대로 통함
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, () => {
  console.log(`Remote browser on http://localhost:${PORT}/remote.html`);
});

const wss = new WebSocketServer({ server, path: '/remote' });

wss.on('connection', async (ws) => {
  console.log('[remote] 클라이언트 연결됨');
  let context, page, cdp;

  try {
    const br = await getBrowser();
    // 탭(세션)별로 쿠키/로그인을 유지하려면 storageState 경로를 지정하면 됨 (MVP에선 생략)
    context = await br.newContext({
      viewport: VIEWPORT,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    page = await context.newPage();
    cdp = await context.newCDPSession(page);

    // 화면 스트리밍 시작 (CDP)
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: VIEWPORT.width,
      maxHeight: VIEWPORT.height,
      everyNthFrame: 1,
    });

    // 프레임이 오면 클라이언트로 전송하고 즉시 ack (ack 해야 다음 프레임이 옴)
    cdp.on('Page.screencastFrame', async (frame) => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'frame', data: frame.data }));
      }
      try {
        await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
      } catch (_) {}
    });

    // 페이지 로드 시 현재 URL/제목을 알려줌 (주소창 동기화)
    page.on('load', async () => {
      if (ws.readyState === 1) {
        ws.send(
          JSON.stringify({
            type: 'url',
            url: page.url(),
            title: await page.title().catch(() => ''),
          })
        );
      }
    });

    await page.goto(START_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  } catch (e) {
    console.error('[remote] 초기화 오류:', e.message);
    ws.close();
    return;
  }

  // ── 클라이언트 입력 수신 ──
  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      switch (msg.type) {
        case 'move':
          await page.mouse.move(msg.x, msg.y);
          break;
        case 'down':
          await page.mouse.move(msg.x, msg.y);
          await page.mouse.down({ button: msg.button || 'left' });
          break;
        case 'up':
          await page.mouse.up({ button: msg.button || 'left' });
          break;
        case 'wheel':
          await page.mouse.wheel(msg.dx || 0, msg.dy || 0);
          break;
        case 'text':
          // 인쇄 가능한 단일 문자 입력 (한글/영문/숫자/기호)
          await page.keyboard.insertText(msg.text);
          break;
        case 'press':
          // 특수키 (Enter, Backspace, 방향키 등)
          await page.keyboard.press(mapKey(msg.key));
          break;
        case 'navigate':
          await page.goto(msg.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
          break;
        case 'back':
          await page.goBack().catch(() => {});
          break;
        case 'forward':
          await page.goForward().catch(() => {});
          break;
        case 'reload':
          await page.reload().catch(() => {});
          break;
      }
    } catch (e) {
      console.error('[remote] 입력 처리 오류:', e.message);
    }
  });

  ws.on('close', async () => {
    console.log('[remote] 클라이언트 연결 해제');
    try {
      await context.close(); // 쿠키/세션 정리
    } catch (_) {}
  });
});

// 한 요청의 오류가 서버 전체를 죽이지 않게
process.on('uncaughtException', (e) => console.error('[uncaught]', e && e.message));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e && (e.message || e)));
