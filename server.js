const express = require('express');
const path = require('path');
const app = express();

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, fp) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (fp.endsWith('.html')) {
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Permissions-Policy', 'interest-cohort=()');
    }
    if (fp.endsWith('sw.js') || fp.endsWith('.webmanifest')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

app.use('/p', express.raw({ type: '*/*', limit: '2mb' }));

function safeDest(h) {
  if (!h) return false;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return false;
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.)/.test(h)) return false;
  if (/^(fc|fd)/i.test(h)) return false;
  return true;
}

app.all('/p/*', async (req, res) => {
  const raw = req.params[0];
  if (!raw) return res.status(400).send('URL required');

  let target;
  try {
    target = new URL(raw.startsWith('http') ? raw : 'https://' + raw);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') throw 0;
    if (!safeDest(target.hostname)) throw 0;
  } catch {
    return res.status(400).send('Invalid URL');
  }

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);

    const opts = {
      method: req.method === 'POST' ? 'POST' : 'GET',
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': req.headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': req.headers['accept-language'] || 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'identity',
        'Referer': target.origin + '/',
      },
      redirect: 'follow',
      signal: ac.signal,
    };

    if (req.method === 'POST' && req.body && req.body.length) {
      opts.body = req.body;
      if (req.headers['content-type']) opts.headers['Content-Type'] = req.headers['content-type'];
    }

    const resp = await fetch(target.href, opts);
    clearTimeout(timer);

    const skip = new Set([
      'x-frame-options', 'content-security-policy',
      'content-security-policy-report-only', 'x-content-security-policy',
      'strict-transport-security', 'set-cookie',
      'transfer-encoding', 'content-encoding', 'content-length',
    ]);

    for (const [k, v] of resp.headers.entries()) {
      const kl = k.toLowerCase();
      if (skip.has(kl)) continue;
      if (kl === 'location') {
        try {
          const loc = new URL(v, target.href);
          res.setHeader(k, '/p/' + loc.href);
        } catch { res.setHeader(k, v); }
        continue;
      }
      try { res.setHeader(k, v); } catch {}
    }

    res.status(resp.status);
    const ct = (resp.headers.get('content-type') || '').toLowerCase();

    if (ct.includes('text/html')) {
      let html = await resp.text();
      if (html.length > 10 * 1024 * 1024) return res.status(413).send('Too large');
      html = rewrite(html, target);
      res.setHeader('Content-Type', resp.headers.get('content-type') || 'text/html; charset=utf-8');
      res.send(html);
    } else {
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > 10 * 1024 * 1024) return res.status(413).send('Too large');
      res.send(buf);
    }
  } catch (e) {
    if (e.name === 'AbortError') return res.status(504).send('Timeout');
    res.status(502).send('Proxy error');
  }
});

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function rewrite(html, base) {
  const href = base.href;

  html = html.replace(/<base\s[^>]*>/gi, '');

  const nav = `<base href="${esc(href)}">\n<script>(function(){document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;var h=a.getAttribute("href");if(!h||h[0]==="#"||/^(javascript|mailto|tel|data):/i.test(h))return;try{var u=new URL(h,document.baseURI);if(u.protocol==="https:"||u.protocol==="http:"){e.preventDefault();e.stopPropagation();window.location.href="/p/"+u.href}}catch(x){}},true);document.addEventListener("submit",function(e){var f=e.target;if(!f||f.tagName!=="FORM")return;var a=f.getAttribute("action")||window.location.href;try{var u=new URL(a,document.baseURI);if(u.protocol==="https:"||u.protocol==="http:")f.setAttribute("action","/p/"+u.href)}catch(x){}},true)})();</script>\n`;

  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/(<head[^>]*>)/i, '$1\n' + nav);
  } else if (/<html[^>]*>/i.test(html)) {
    html = html.replace(/(<html[^>]*>)/i, '$1\n<head>' + nav + '</head>\n');
  } else {
    html = nav + html;
  }

  return html;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('QuietSpace on port ' + PORT));
