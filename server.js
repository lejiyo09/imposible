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

// ── 헬스체크 ──
app.get('/healthz', (req, res) => res.type('text').send('ok'));

const server = app.listen(process.env.PORT || 3000, () => {
  console.log('Geo-Zebra on port ' + server.address().port);
});

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
