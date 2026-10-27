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
    if (fp.endsWith('.html') || fp.endsWith('sw.js') || fp.endsWith('.webmanifest')) {
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

function errPage(title, msg) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:system-ui,sans-serif;padding:2rem;color:#333;max-width:500px;margin:2rem auto"><h2 style="color:#c33">' + title + '</h2><p>' + msg + '</p></body></html>';
}

app.all('/p/*', async (req, res) => {
  const raw = req.originalUrl.slice(3);
  if (!raw) return res.status(400).type('html').send(errPage('URL 필요', '프록시 대상 URL을 지정하세요.'));

  let target;
  try {
    target = new URL(raw.startsWith('http') ? raw : 'https://' + raw);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') throw 0;
    if (!safeDest(target.hostname)) throw 0;
  } catch {
    return res.status(400).type('html').send(errPage('잘못된 URL', '유효한 https:// 주소를 입력하세요.'));
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
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'cross-site',
      },
      redirect: 'follow',
      signal: ac.signal,
    };

    if (req.headers.cookie) opts.headers['Cookie'] = req.headers.cookie;

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
      if (html.length > 10 * 1024 * 1024) return res.status(413).type('html').send(errPage('크기 초과', '10MB를 초과합니다.'));
      const finalUrl = resp.url || target.href;
      html = rewrite(html, finalUrl);
      res.setHeader('Content-Type', resp.headers.get('content-type') || 'text/html; charset=utf-8');
      res.send(html);
    } else {
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > 10 * 1024 * 1024) return res.status(413).type('html').send(errPage('크기 초과', '10MB를 초과합니다.'));
      res.send(buf);
    }
  } catch (e) {
    if (e.name === 'AbortError') return res.status(504).type('html').send(errPage('시간 초과', '사이트가 15초 내에 응답하지 않았습니다.'));
    res.status(502).type('html').send(errPage('프록시 오류', '사이트에 연결할 수 없습니다.'));
  }
});

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function rewrite(html, baseHref) {
  html = html.replace(/<base\s[^>]*>/gi, '');
  html = html.replace(/<meta[^>]*http-equiv\s*=\s*["']?\s*Content-Security-Policy\s*["']?[^>]*>/gi, '');

  const nav = `<base href="${esc(baseHref)}">
<script>(function(){try{var O=window.location.origin,B=document.baseURI;function px(h){if(!h||h[0]==="#")return h;if(/^(javascript|mailto|tel|data|blob):/i.test(h))return h;try{var u=new URL(h,B);if(u.protocol==="https:"||u.protocol==="http:")return O+"/p/"+u.href}catch(x){}return h}document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;var h=a.getAttribute("href");if(!h||h[0]==="#"||/^(javascript|mailto|tel|data):/i.test(h))return;e.preventDefault();e.stopPropagation();window.location.href=px(h)},true);document.addEventListener("submit",function(e){var f=e.target;if(!f||f.tagName!=="FORM")return;var a=f.getAttribute("action")||window.location.href;f.setAttribute("action",px(a))},true);var _s=HTMLFormElement.prototype.submit;HTMLFormElement.prototype.submit=function(){var a=this.getAttribute("action")||window.location.href;this.setAttribute("action",px(a));return _s.call(this)};var _o=window.open;window.open=function(u,t,f){if(u)u=px(u);return _o.call(window,u,t,f)};var _ps=history.pushState,_rs=history.replaceState;history.pushState=function(s,t,u){try{return _ps.call(this,s,t,u)}catch(e){try{return _ps.call(this,s,t)}catch(e2){}}};history.replaceState=function(s,t,u){try{return _rs.call(this,s,t,u)}catch(e){try{return _rs.call(this,s,t)}catch(e2){}}};var _f=window.fetch;if(_f)window.fetch=function(i,n){n=n?Object.assign({},n):{};if(typeof i==="string"){try{var u=new URL(i,B);if(u.origin!==O){i=O+"/p/"+u.href;if(n.mode==="same-origin")n.mode="cors"}}catch(x){}}else if(i&&typeof i.url==="string"){try{var u2=new URL(i.url,B);if(u2.origin!==O){n.method=n.method||i.method;n.mode="cors";if(!n.headers){var hd={};try{i.headers.forEach(function(v,k){hd[k]=v})}catch(e){}n.headers=hd}i=O+"/p/"+u2.href}}catch(x){}}return _f.call(window,i,n)};var _x=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,a,s,p){try{var r=new URL(u,B);if(r.origin!==O)u=O+"/p/"+r.href}catch(x){}return _x.call(this,m,u,a,s,p)}}catch(x){}})();<\/script>
`;

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
