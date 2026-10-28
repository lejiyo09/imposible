const express = require('express');
const path = require('path');
const { WebSocketServer } = require('ws');
const { uvPath } = require('@titaniumnetwork-dev/ultraviolet');
const { baremuxPath } = require('@mercuryworkshop/bare-mux/node');
const { epoxyPath } = require('@mercuryworkshop/epoxy-transport');
const { server: wisp, logging } = require('@mercuryworkshop/wisp-js/server');
const { handleAgentConnection } = require('./agent');

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
  res.status(503).type('html').send('<!DOCTYPE html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;padding:2rem;color:#333"><h2>프록시 준비 중</h2><p>QuietSpace의 새로고침 버튼을 눌러 다시 시도하세요.</p></body>');
});

// ── 서버 IP 확인 엔드포인트 (DNS 차단 대비 IP 캐싱용) ──
app.get('/api/server-info', (req, res) => {
  res.json({
    ts: Date.now(),
    // 클라이언트가 이 응답의 소스 IP를 캐시하면 DNS 없이 재연결 가능
    hint: 'Cache the IP from this connection for DNS-free reconnection',
  });
});

const server = app.listen(process.env.PORT || 3000, () => {
  console.log('QuietSpace on port ' + server.address().port);
});

// ── WebSocket 업그레이드 라우팅 ──
// /wisp/  → 기존 Wisp 프록시 (YouTube, 치지직 등 스트리밍 가능)
// /agent/ → 에이전트 모드 (서버사이드 렌더링, 백업)
const agentWss = new WebSocketServer({ noServer: true });

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
