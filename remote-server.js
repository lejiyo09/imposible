// Geo-Zebra 원격 브라우저 프로토타입 (MVP)
// 서버에서 실제 Chromium을 실행하고, 화면을 WebSocket으로 스트리밍한다.
// 입력(마우스/키보드)은 Playwright 고수준 API로 안정적으로 전달한다.
//
// 실행: node remote-server.js
// 접속: http://localhost:3001/remote.html

const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { chromium } = require('playwright');

const PORT = process.env.REMOTE_PORT || 3001;
const VIEWPORT = { width: 1280, height: 720 };
const START_URL = 'https://www.google.com';
// 가상 오디오 케이블의 "녹음(출력)" 장치 이름. 다르면 AUDIO_DEVICE 환경변수로 지정.
// 장치 목록 확인: ffmpeg -list_devices true -f dshow -i dummy
const AUDIO_DEVICE = process.env.AUDIO_DEVICE || 'CABLE Output (VB-Audio Virtual Cable)';

// ── 브라우저는 서버당 1개만 띄우고 재사용 ──
let browser;
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    console.log('[remote] Chromium 실행...');
    const opts = {
      headless: false, // 소리를 오디오 장치로 내보내려면 headful 필요
      args: [
        '--disable-gpu',
        '--disable-dev-shm-usage',
        // 자동화 탐지 신호 제거 (navigator.webdriver 등) — 구글 등의 봇 차단 완화
        '--disable-blink-features=AutomationControlled',
      ],
    };
    try {
      // 번들 Chromium보다 실제 설치된 Chrome이 덜 탐지됨
      browser = await chromium.launch({ ...opts, channel: 'chrome' });
      console.log('[remote] 실제 Chrome으로 실행');
    } catch (_) {
      browser = await chromium.launch(opts); // Chrome 없으면 번들 Chromium으로 폴백
      console.log('[remote] 번들 Chromium으로 실행');
    }
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

// ── 오디오 캡처: ffmpeg로 가상 케이블의 소리를 받아 /audio 클라이언트로 중계 ──
const audioClients = new Set();
let ffmpeg = null;
function startAudioCapture() {
  if (ffmpeg) return;
  console.log('[audio] ffmpeg 시작 — 장치:', AUDIO_DEVICE);
  ffmpeg = spawn('ffmpeg', [
    '-f', 'dshow',
    '-i', 'audio=' + AUDIO_DEVICE,
    '-ac', '2', '-ar', '48000',
    '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-f', 's16le', '-', // 무압축 PCM을 표준출력으로
  ]);
  ffmpeg.stdout.on('data', (chunk) => {
    for (const c of audioClients) if (c.readyState === 1) c.send(chunk);
  });
  ffmpeg.stderr.on('data', () => {}); // ffmpeg 로그는 버림
  ffmpeg.on('close', (code) => { console.log('[audio] ffmpeg 종료', code); ffmpeg = null; });
  ffmpeg.on('error', (e) => {
    console.error('[audio] ffmpeg 오류:', e.message, '— ffmpeg 설치됐는지 확인');
    ffmpeg = null;
  });
}

// WebSocket 두 경로: /remote (화면·입력), /audio (소리)
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
  console.log('[remote] 클라이언트 연결됨');
  let context, page, cdp;

  try {
    const br = await getBrowser();
    // 탭(세션)별로 쿠키/로그인을 유지하려면 storageState 경로를 지정하면 됨 (MVP에선 생략)
    context = await br.newContext({
      viewport: VIEWPORT,
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    // 자동화 탐지 신호(navigator.webdriver) 숨기기
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
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
          // 놓는 위치를 정확히 맞춘 뒤 떼기 (클릭 정확도 + 드래그)
          if (typeof msg.x === 'number') await page.mouse.move(msg.x, msg.y);
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
