const express = require('express');
const path = require('path');
const { uvPath } = require('@titaniumnetwork-dev/ultraviolet');
const { baremuxPath } = require('@mercuryworkshop/bare-mux/node');
const { epoxyPath } = require('@mercuryworkshop/epoxy-transport');
const { server: wisp, logging } = require('@mercuryworkshop/wisp-js/server');

logging.set_level(logging.WARN);
wisp.options.allow_private_ips = false;
wisp.options.allow_loopback_ips = false;
wisp.options.allow_udp_streams = false;
wisp.options.port_whitelist = [80, 443];

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

const server = app.listen(process.env.PORT || 3000, () => {
  console.log('QuietSpace on port ' + server.address().port);
});

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/wisp/')) wisp.routeRequest(req, socket, head);
  else socket.destroy();
});
