const express = require('express');
const path = require('path');
const { WebSocketServer } = require('ws');
const { uvPath } = require('@titaniumnetwork-dev/ultraviolet');
const { baremuxPath } = require('@mercuryworkshop/bare-mux/node');
const { epoxyPath } = require('@mercuryworkshop/epoxy-transport');
const { server: wisp, logging } = require('@mercuryworkshop/wisp-js/server');
const { handleAgentConnection } = require('./agent');

// 한 요청·한 페이지의 예기치 않은 오류가 프로세스를 죽이면 모든 사용자의 WebSocket이
// 동시에 끊긴다. 프로세스를 살려 두어 다른 연결을 보호한다. (로깅만, 복구는 각 연결이 재시도)
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.message));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && (e.message || e)));

logging.set_level(logging.WARN);
wisp.options.allow_private_ips = false;
wisp.options.allow_loopback_ips = false;
wisp.options.allow_udp_streams = false;
wisp.options.port_whitelist = [80, 443];
// wisp는 DNS 결과 중 주소 하나에만 접속을 시도한다. IPv6가 먼저 오면 IPv6 송신이 없는 호스팅에서 실패하므로 IPv4 우선.
wisp.options.dns_result_order = 'ipv4first';

const app = express();
app.disable('x-powered-by');

const noCache = (res) => res.setHeader('Cache-Control', 'no-cache');

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, fp) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (fp.endsWith('.html')) {
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Permissions-Policy', 'interest-cohort=()');
    }
    if (fp.endsWith('.html') || fp.endsWith('.js') || fp.endsWith('.webmanifest')) noCache(res);
  }
}));
app.use('/uv/', express.static(uvPath, { setHeaders: noCache }));
app.use('/baremux/', express.static(baremuxPath, { setHeaders: noCache }));
app.use('/epoxy/', express.static(epoxyPath, { setHeaders: noCache }));

// 서비스 워커가 아직 활성화되지 않았을 때만 서버까지 도달한다.
app.get('/service/*', (req, res) => {
  res.status(503).type('html').send('<!DOCTYPE html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;padding:2rem;color:#333"><h2>프록시 준비 중</h2><p>Geo-Zebra의 새로고침 버튼을 눌러 다시 시도하세요.</p></body>');
});

// ── 서버 IP 확인 엔드포인트 (DNS 차단 대비 IP 캐싱용) ──
app.get('/api/server-info', (req, res) => {
  res.json({
    ts: Date.now(),
    // 클라이언트가 이 응답의 소스 IP를 캐시하면 DNS 없이 재연결 가능
    hint: 'Cache the IP from this connection for DNS-free reconnection',
  });
});

// ── 헬스체크(self-ping 대상) ──
app.get('/healthz', (req, res) => res.type('text').send('ok'));

const server = app.listen(process.env.PORT || 3000, () => {
  console.log('Geo-Zebra on port ' + server.address().port);
});

// ── 잠들기 방지 self-ping (한국 시간 21:20~24:00에만) ──
// Render 무료 플랜은 15분간 외부 요청이 없으면 다운된다. localhost 호출은 외부 트래픽으로
// 치지 않으므로 서버의 공개 URL(RENDER_EXTERNAL_URL)을 주기적으로 호출해 깨어 있게 한다.
// 학교 DNS 차단이 걸리는 밤 시간대에만 깨워 두어 무료 사용 시간을 아낀다.
// RENDER_EXTERNAL_URL은 Render가 자동 주입하므로, 로컬 개발에서는 self-ping이 켜지지 않는다.
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_PING_URL;
const KEEP_AWAKE = process.env.KEEP_AWAKE !== 'false'; // 끄려면 KEEP_AWAKE=false
// 활성 시간대(한국 시간, 분 단위). 기본 21:20(=1280)~24:00(=1440). env로 조정 가능.
const AWAKE_START = parseInt(process.env.KEEP_AWAKE_START || '1280', 10); // 21*60+20
const AWAKE_END = parseInt(process.env.KEEP_AWAKE_END || '1440', 10);     // 24*60

// 서버 타임존과 무관하게 한국 시간의 '자정 이후 분'을 구한다.
function koreaMinutes() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  let h = +parts.find((p) => p.type === 'hour').value;
  const m = +parts.find((p) => p.type === 'minute').value;
  if (h === 24) h = 0; // 일부 환경에서 자정을 24로 반환하는 경우 보정
  return h * 60 + m;
}
function inAwakeWindow() {
  const now = koreaMinutes();
  // [start, end). end가 start보다 작으면 자정을 넘는 구간으로 간주
  return AWAKE_START <= AWAKE_END
    ? (now >= AWAKE_START && now < AWAKE_END)
    : (now >= AWAKE_START || now < AWAKE_END);
}

if (SELF_URL && KEEP_AWAKE) {
  const pingUrl = SELF_URL.replace(/\/+$/, '') + '/healthz';
  const CHECK_INTERVAL = 5 * 60 * 1000; // 5분마다 시간대 확인 후, 창 안이면 ping
  setInterval(async () => {
    if (!inAwakeWindow()) return;
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 20000);
      await fetch(pingUrl, { signal: ac.signal, headers: { 'User-Agent': 'geo-keepawake' } });
      clearTimeout(t);
    } catch (e) {
      console.error('[keep-awake] ping failed:', e && e.message);
    }
  }, CHECK_INTERVAL).unref();
  const fmt = (m) => String((m / 60) | 0).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  console.log('[keep-awake] self-ping →', pingUrl, '(한국 시간', fmt(AWAKE_START), '~', fmt(AWAKE_END) + ')');
}

// ── WebSocket 업그레이드 라우팅 ──
// /wisp/  → 기존 Wisp 프록시 (YouTube, 치지직 등 스트리밍 가능)
// /agent/ → 에이전트 모드 (서버사이드 렌더링, 백업)
// 큰 페이지가 WebSocket 1프레임으로 들어오므로 payload 상한을 16MB로 올린다.
// perMessageDeflate는 ws 공식 문서가 메모리·성능 문제로 비권장 — Render 512MB에서
// 불안정을 유발하므로 끈다. 응답 크기는 agent.js의 인라인 예산(5MB)으로 이미 제한된다.
const agentWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });

agentWss.on('connection', handleAgentConnection);

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/wisp/')) {
    wisp.routeRequest(req, socket, head);
  } else if (req.url.startsWith('/agent/')) {
    agentWss.handleUpgrade(req, socket, head, (ws) => {
      agentWss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});
