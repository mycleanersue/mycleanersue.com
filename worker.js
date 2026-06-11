/**
 * _worker.js — Cloudflare Pages "advanced mode" Function. This ONE file is the
 * whole front door for Sue's admin app:
 *   - serves the installable app (index.html, sw.js, icons) via env.ASSETS
 *   - gates access with a short code (APP_PIN), handing back a 90-day session
 *   - proxies /api to the Google backend (injecting the real token)
 *   - signs VAPID web-push so phones get native alerts
 *
 * Deploy: Cloudflare dashboard → Workers & Pages → Create → Pages → Upload
 * assets → drag this folder. Then Settings → Variables: add the secrets below.
 *
 * SIMPLE MODE: the backend token and access code are baked in below, so you
 * just drag this folder into Cloudflare Pages and it works — no variables to
 * set. This file is server-side code; Cloudflare never serves it to browsers,
 * and it is NOT in any public repo, so the baked values stay private.
 * (You can override either by setting GAS_TOKEN / APP_PIN as encrypted Pages
 * variables later; env values win over the baked ones.)
 *
 * VAPID_PRIVATE (optional) turns on native push; without it, alerts use ntfy.
 */

const GAS_URL = 'https://script.google.com/macros/s/AKfycbw4ZFrgh31VzrvWg9WGY5o13z1r7WpgVZ8L-lAMV0Bo9FuL3_qkwQair2W8myKQpQcz/exec';
const VAPID_PUBLIC = 'BHMZ3wbktbs7fMjYsF-oXOVENi_jxpfdv6jLaQ0hyUJTgOkwdjDEYEKvLALbFaj-cHEZ-LulL-4fAfJlF3kPX1E';
const VAPID_SUBJECT = 'mailto:info@mycleanersue.com';
const SESSION_DAYS = 90;

// Baked-in secrets (override anytime with Pages variables of the same name).
const BAKED_GAS_TOKEN = '9c51314c470237fff1f1e1a84d39e6d9bb9a3e0272e313d0';
const BAKED_APP_PIN = '495461';
const gasToken = (env) => env.GAS_TOKEN || BAKED_GAS_TOKEN;
const appPin = (env) => env.APP_PIN || BAKED_APP_PIN;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === '/health') return json({ ok: true });
      if (p === '/auth' && request.method === 'POST') return handleAuth(request, env);          // admin PIN
      if (p === '/auth/login' && request.method === 'POST') return handleLogin(request, env);    // client/employee
      if (p === '/auth/signup' && request.method === 'POST') return handleSignup(request, env);
      if (p === '/auth/reset-request' && request.method === 'POST') return handleAuthGas(request, env, 'auth_reset_request');
      if (p === '/auth/reset' && request.method === 'POST') return handleAuthGas(request, env, 'auth_reset');
      if (p === '/api' && request.method === 'POST') return handleApi(request, env, url);
      if (p === '/push/send' && request.method === 'POST') return handlePushSend(request, env);
      // Public, read-only feeds + embed widget for Sue's marketing website.
      if (p === '/public/reviews') return publicFeed(env, url, 'public_reviews');
      if (p === '/public/gallery') return publicFeed(env, url, 'public_gallery');
      if (p === '/embed.js') return embedWidget(url);
      if (p.startsWith('/calendar/')) return handleCalendar(env, url, p);     // .ics subscribe feed
      // Clean URLs for the role apps (/crew, /portal) → their html files.
      var alias = { '/crew': '/crew.html', '/portal': '/client.html', '/reset': '/reset.html' }[p];
      if (alias) return env.ASSETS.fetch(new Request(new URL(alias, url), request));
      return env.ASSETS.fetch(request); // the app + static files
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500);
    }
  }
};

/* ---------------- calendar (.ics) subscribe feed ---------------- */

async function handleCalendar(env, url, p) {
  // /calendar/<role>/<token>.ics
  const m = p.match(/^\/calendar\/(client|employee)\/([A-Za-z0-9]+)\.ics$/);
  if (!m) return new Response('Not found', { status: 404 });
  const r = await gasCall(env, url.origin, { action: 'feed_data', feedRole: m[1], feedToken: m[2] });
  const data = (r && r.ok && r.data) ? r.data : { name: 'Cleanings', events: [] };
  const ics = buildIcs(data);
  return new Response(ics, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}

function buildIcs(data) {
  const z = (n) => String(n).padStart(2, '0');
  const fmt = (iso) => { const d = new Date(iso); return d.getUTCFullYear() + z(d.getUTCMonth() + 1) + z(d.getUTCDate()) + 'T' + z(d.getUTCHours()) + z(d.getUTCMinutes()) + z(d.getUTCSeconds()) + 'Z'; };
  const esc = (s) => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const now = fmt(new Date().toISOString());
  let out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//S.G. Cleaning//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + esc(data.name || 'S.G. Cleaning'), 'X-PUBLISHED-TTL:PT1H', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H'];
  (data.events || []).forEach((e) => {
    if (!e.start) return;
    out.push('BEGIN:VEVENT', 'UID:' + esc(e.uid), 'DTSTAMP:' + now, 'DTSTART:' + fmt(e.start), 'DTEND:' + fmt(e.end || e.start),
      'SUMMARY:' + esc(e.title), e.location ? 'LOCATION:' + esc(e.location) : '',
      'STATUS:' + (e.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'), 'END:VEVENT');
  });
  out.push('END:VCALENDAR');
  return out.filter(Boolean).join('\r\n');
}

/* ---------------- public website feeds + embed ---------------- */

async function publicFeed(env, url, action) {
  const r = await gasCall(env, url.origin, { action });
  const data = (r && r.ok && r.data) ? r.data : [];
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=120' }
  });
}

/** A tiny, dependency-free widget Sue pastes into her site once. It fills
 *  <div id="sg-reviews"></div> and/or <div id="sg-gallery"></div>. */
function embedWidget(url) {
  const base = url.origin;
  const js = `(function(){
  var BASE=${JSON.stringify(base)};
  var css='.sgw{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#22302e}'
   +'.sgw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px}'
   +'.sgw-card{border:1px solid #e6e2d8;border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 2px 10px rgba(20,40,38,.06)}'
   +'.sgw-card img{width:100%;display:block}'
   +'.sgw-src{font-size:13px;color:#1f8a78;font-weight:700;padding:8px 12px}'
   +'.sgw-ba{display:grid;grid-template-columns:1fr 1fr}'
   +'.sgw-ba figure{margin:0;position:relative}.sgw-ba figcaption{position:absolute;top:8px;left:8px;background:rgba(0,0,0,.55);color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px}'
   +'.sgw-cap{padding:8px 12px;font-size:14px;color:#6c7b78}';
  var s=document.createElement('style');s.textContent=css;document.head.appendChild(s);
  function img(u){return u?u.replace('/uc?id=','/thumbnail?sz=w1000&id=').replace('uc?id=','thumbnail?sz=w1000&id='):''}
  function load(id,path,render){var el=document.getElementById(id);if(!el)return;
    fetch(BASE+path).then(function(r){return r.json()}).then(function(items){
      if(!items||!items.length){el.style.display='none';return}
      el.classList.add('sgw');el.innerHTML='<div class="sgw-grid">'+items.map(render).join('')+'</div>';
    }).catch(function(){el.style.display='none'});}
  load('sg-reviews','/public/reviews',function(r){
    return '<div class="sgw-card">'+(r.source?'<div class="sgw-src">★ '+r.source+(r.name?' · '+r.name:'')+'</div>':'')
      +'<img loading="lazy" src="'+img(r.image)+'" alt="customer review">'+(r.caption?'<div class="sgw-cap">'+r.caption+'</div>':'')+'</div>';});
  load('sg-gallery','/public/gallery',function(g){
    return '<div class="sgw-card"><div class="sgw-ba">'
      +'<figure><figcaption>Before</figcaption><img loading="lazy" src="'+img(g.before)+'"></figure>'
      +'<figure><figcaption>After</figcaption><img loading="lazy" src="'+img(g.after)+'"></figure></div>'
      +(g.caption?'<div class="sgw-cap">'+g.caption+'</div>':'')+'</div>';});
})();`;
  return new Response(js, { headers: { 'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' } });
}

/** Proxy a body to the GAS backend with the shared token injected. */
async function gasCall(env, origin, payload) {
  const res = await fetch(GAS_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, token: gasToken(env), workerUrl: origin }), redirect: 'follow'
  });
  return JSON.parse(await res.text() || '{}');
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

/* ---------------- auth ---------------- */

// Admin sign-in (Sue's PIN).
async function handleAuth(request, env) {
  const { pin } = await request.json().catch(() => ({}));
  if (!pin || pin !== appPin(env)) return json({ ok: false, error: 'wrong code' }, 401);
  return json({ ok: true, token: await mintSession(env, { role: 'admin' }), role: 'admin' });
}

// Client / employee sign-in (email + password, verified by GAS).
async function handleLogin(request, env) {
  const url = new URL(request.url);
  const b = await request.json().catch(() => ({}));
  const r = await gasCall(env, url.origin, { action: 'auth_login', authRole: b.role, email: b.email, password: b.password });
  if (!r.ok || !r.data || !r.data.ok) return json({ ok: false, error: (r.data && r.data.error) || 'Sign-in failed.' }, 401);
  const a = r.data.account;
  const token = await mintSession(env, { role: a.role, accountId: a.accountId, linkedId: a.linkedId });
  return json({ ok: true, token, role: a.role, name: a.name, accountId: a.accountId });
}

async function handleSignup(request, env) {
  const url = new URL(request.url);
  const b = await request.json().catch(() => ({}));
  const r = await gasCall(env, url.origin, { action: 'auth_signup', authRole: b.role, email: b.email, password: b.password, name: b.name, phone: b.phone });
  if (!r.ok || !r.data || !r.data.ok) return json({ ok: false, error: (r.data && r.data.error) || 'Sign-up failed.' }, 400);
  const a = r.data.account;
  const token = await mintSession(env, { role: a.role, accountId: a.accountId, linkedId: a.linkedId });
  return json({ ok: true, token, role: a.role, name: a.name, accountId: a.accountId });
}

async function handleAuthGas(request, env, action) {
  const url = new URL(request.url);
  const b = await request.json().catch(() => ({}));
  const r = await gasCall(env, url.origin, { action, authRole: b.role, email: b.email, resetToken: b.token, password: b.password });
  return json(r.data || { ok: false });
}

async function mintSession(env, claims) {
  const payload = b64url(enc(JSON.stringify({ ...claims, exp: Date.now() + SESSION_DAYS * 86400000 })));
  return `${payload}.${await hmac(gasToken(env), payload)}`;
}
async function validSession(token, env) {
  if (!token) return null;
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig) return null;
  if (sig !== await hmac(gasToken(env), payload)) return null;
  let claims;
  try { claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))); } catch (e) { return null; }
  if (!claims.exp || Number(claims.exp) < Date.now()) return null;
  return claims;
}
async function hmac(keyStr, msg) {
  const key = await crypto.subtle.importKey('raw', enc(keyStr), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc(msg))));
}

/* ---------------- API proxy ---------------- */

async function handleApi(request, env, url) {
  const incoming = await request.json().catch(() => ({}));
  const token = incoming.session || (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const claims = await validSession(token, env);
  if (!claims) return json({ ok: false, error: 'unauthorized' }, 401);
  delete incoming.session;
  // The role/identity comes from the signed session, NOT from the client — so a
  // client can't claim to be admin. GAS trusts these because the call carries
  // the shared token only the Worker holds.
  const body = { ...incoming, token: gasToken(env), workerUrl: url.origin,
    role: claims.role, accountId: claims.accountId || '', linkedId: claims.linkedId || '' };
  const res = await fetch(GAS_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'follow'
  });
  return new Response(await res.text(), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

/* ---------------- web push (VAPID, payload-less) ---------------- */

async function handlePushSend(request, env) {
  const { token, endpoints } = await request.json().catch(() => ({}));
  if (token !== gasToken(env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!env.VAPID_PRIVATE) return json({ ok: false, error: 'no vapid', sent: 0 }); // GAS falls back to ntfy
  const list = Array.isArray(endpoints) ? endpoints : [];
  let sent = 0;
  await Promise.all(list.map((ep) => sendOne(ep, env).then((r) => { if (r.status >= 200 && r.status < 300) sent++; }).catch(() => {})));
  return json({ ok: true, sent });
}
async function sendOne(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const jwt = await vapidJwt(aud, env);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Authorization': `vapid t=${jwt}, k=${VAPID_PUBLIC}`, 'TTL': '86400', 'Content-Length': '0' }
  });
  return { status: res.status };
}
async function vapidJwt(aud, env) {
  const header = b64url(enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(enc(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT })));
  const signingInput = `${header}.${payload}`;
  const key = await importVapidKey(env);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}
async function importVapidKey(env) {
  const pub = b64urlDecode(VAPID_PUBLIC);
  const jwk = { kty: 'EC', crv: 'P-256', x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), d: env.VAPID_PRIVATE, ext: true };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/* ---------------- encoding ---------------- */

function enc(s) { return new TextEncoder().encode(s); }
function b64url(bytes) {
  let s = ''; const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
