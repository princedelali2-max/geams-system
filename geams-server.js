#!/usr/bin/env node
/* GEAMS backend — one small Node.js server (no npm packages needed).
 *
 *   node geams-server.js            (default port 8080; set PORT=... to change)
 *
 * It does two things:
 *   1. Serves the six GEAMS HTML apps from this folder.
 *   2. Provides the shared real-time store ("GeamsSync") over HTTP so that
 *      phones, tablets and computers all see the same incidents, officers,
 *      chats, alerts and station data, and shows how many devices are online.
 *
 * Data is saved to geams-data.json next to this file, so it survives restarts.
 *
 * IMPORTANT for phones: browsers only allow GPS, camera and Face ID on
 * https:// pages (or localhost). To use the apps on other devices, put this
 * server behind HTTPS — e.g. deploy it to any Node host (Render, Railway,
 * Fly.io, a VPS with Caddy/nginx), or run:  cloudflared tunnel --url http://localhost:8080
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const DIR = __dirname;
const DATA_FILE = process.env.GEAMS_DATA || path.join(DIR, 'geams-data.json');
const MAX_BODY = 8 * 1024 * 1024;
const MAX_BLOB = 60 * 1024 * 1024;               // per upload / append chunk
const BLOB_DIR = process.env.GEAMS_BLOBS || path.join(path.dirname(DATA_FILE), 'geams-blobs');
try { fs.mkdirSync(BLOB_DIR, { recursive: true }); } catch (e) {}
const safeSeg = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
const blobPath = (inc, name) => path.join(BLOB_DIR, safeSeg(inc), safeSeg(name));
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

let store = {};                       // key -> { value, v, ts }
try { store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { store = {}; }
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(DATA_FILE + '.tmp', JSON.stringify(store), (err) => {
      if (!err) fs.rename(DATA_FILE + '.tmp', DATA_FILE, () => {});
    });
  }, 500);
}

const presence = {};                  // deviceId -> { app, ts }
function devices() {
  const now = Date.now();
  let n = 0, byApp = {};
  for (const [id, p] of Object.entries(presence)) {
    if (now - p.ts < 20000) { n++; byApp[p.app] = (byApp[p.app] || 0) + 1; }
    else if (now - p.ts > 300000) delete presence[id];
  }
  return { devices: n, byApp };
}

const clients = new Set();            // SSE connections
function broadcast(obj) {
  const line = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const res of clients) { try { res.write(line); } catch (e) { clients.delete(res); } }
}
setInterval(() => { for (const res of clients) { try { res.write(': hb\n\n'); } catch (e) { clients.delete(res); } } }, 15000);

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon' };

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, X-Geams-Name, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}


/* ───────────────────────── HQ LOGIN ─────────────────────────
 * HQ operators sign in with a username and password. Passwords are never stored
 * in readable form (scrypt + random salt). The owner account comes from the
 * environment so it survives redeploys on hosts with a temporary disk:
 *     GEAMS_HQ_ADMIN_USER      (default: hqadmin)
 *     GEAMS_HQ_ADMIN_PASSWORD  (set this! if missing, a random one is printed in the log at every start)
 * The owner can add more HQ operators from the HQ screen; those are saved in
 * geams-hq-users.json next to the data file (keep a persistent disk to keep them).
 * Sensitive writes (creating LCRs, tactical orders) need a valid HQ sign-in, and
 * LCR passphrase hashes can never be read or written through the public store.
 */
const USERS_FILE = process.env.GEAMS_HQ_USERS || path.join(path.dirname(DATA_FILE), 'geams-hq-users.json');
let hqUsers = {};
try { hqUsers = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) { hqUsers = {}; }
function saveUsers() { try { fs.writeFileSync(USERS_FILE, JSON.stringify(hqUsers)); } catch (e) { console.log('Could not save HQ users:', e.message); } }
const OWNER = String(process.env.GEAMS_HQ_ADMIN_USER || 'hqadmin').toLowerCase();
let ownerPass = process.env.GEAMS_HQ_ADMIN_PASSWORD, ownerGenerated = false;
if (!ownerPass) { ownerPass = crypto.randomBytes(9).toString('base64url'); ownerGenerated = true; }
const OWNER_SALT = crypto.randomBytes(16).toString('hex');
const pwHash = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const OWNER_HASH = pwHash(ownerPass, OWNER_SALT);
function eq(a, b) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function checkLogin(user, pw) {
  user = String(user || '').trim().toLowerCase();
  if (user === OWNER) return eq(pwHash(pw, OWNER_SALT), OWNER_HASH) ? { user, role: 'admin' } : null;
  const u = hqUsers[user]; if (!u) { pwHash(pw, OWNER_SALT); return null; }
  return eq(pwHash(pw, u.salt), u.hash) ? { user, role: u.role || 'operator' } : null;
}
const sessions = new Map();                      // token -> { user, role, exp }
const SESSION_MS = 12 * 3600 * 1000;
function newSession(who) { const t = crypto.randomBytes(32).toString('hex'); sessions.set(t, { ...who, exp: Date.now() + SESSION_MS }); return t; }
function sessionOf(req) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(String(req.headers.authorization || '')); if (!m) return null;
  const s = sessions.get(m[1]); if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(m[1]); return null; }
  return s;
}
setInterval(() => { const n = Date.now(); for (const [t, s] of sessions) if (s.exp < n) sessions.delete(t); }, 60000);
const fails = new Map();                         // ip|user -> { n, until }
function lockedOut(k) { const f = fails.get(k); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; }
function noteFail(k) { const f = fails.get(k) || { n: 0, until: 0 }; f.n++; if (f.n >= 5) { f.until = Date.now() + 5 * 60000; f.n = 0; } fails.set(k, f); }
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const SECRET_KEY = 'registry:stationAuth';       // LCR passphrase hashes: server-side only
const HQ_WRITE_KEYS = new Set(['registry:stations', 'hq:tacticalOps']);
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newPassphrase() { const b = crypto.randomBytes(12); const c = [...b].map(x => ALPHA[x % ALPHA.length]).join(''); return c.slice(0, 4) + '-' + c.slice(4, 8) + '-' + c.slice(8, 12); }

/* Ghana Post GPS lookup. Ghana Post GPS publishes no open, documented API, so this
 * server only calls a lookup service YOU configure (an agreement with Ghana Post / its
 * operator, or a licensed reseller). Set:
 *   GHANAPOST_LOOKUP_URL    e.g. https://provider.example/lookup?address={address}   ({address} is replaced)
 *   GHANAPOST_LOOKUP_METHOD GET (default) or POST (sends form field "address")
 *   GHANAPOST_API_KEY       sent as the header named below
 *   GHANAPOST_API_KEY_HEADER header name (default: Authorization)
 * The reply must be JSON containing a latitude and longitude (common field names are recognised). */
const GP_RE = /^[A-Z]{2,3}-?\d{3,4}-?\d{4}$/;
function findLatLng(o, depth) {
  if (!o || typeof o !== 'object' || (depth || 0) > 4) return null;
  const pick = (names) => { for (const k of Object.keys(o)) if (names.includes(k.toLowerCase())) { const v = parseFloat(o[k]); if (!isNaN(v)) return v; } return null; };
  const lat = pick(['lat', 'latitude', 'centerlatitude', 'centrelatitude', 'center_lat']), lng = pick(['lng', 'lon', 'long', 'longitude', 'centerlongitude', 'centrelongitude', 'center_lng']);
  if (lat !== null && lng !== null) return { lat, lng };
  const n = pick(['northlat', 'nlat']), so = pick(['southlat', 'slat']), e = pick(['eastlong', 'elong', 'eastlng']), w = pick(['westlong', 'wlong', 'westlng']);
  if (n !== null && so !== null && e !== null && w !== null) return { lat: (n + so) / 2, lng: (e + w) / 2 };
  for (const k of Object.keys(o)) { const r = findLatLng(o[k], (depth || 0) + 1); if (r) return r; }
  return null;
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  try {
    if (p === '/api/health') return json(res, 200, { ok: true, version: 2, time: Date.now(), ...devices(), keys: Object.keys(store).length });
    if (p === '/api/ping' && req.method === 'GET') {
      const d = u.searchParams.get('d');
      if (d) presence[d.slice(0, 64)] = { app: String(u.searchParams.get('a') || '?').slice(0, 24), ts: Date.now() };
      return json(res, 200, { ok: true, ...devices() });
    }

    if (p === '/api/presence' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.deviceId) presence[String(b.deviceId).slice(0, 64)] = { app: String(b.app || '?').slice(0, 24), ts: Date.now() };
      return json(res, 200, { ok: true, ...devices() });
    }

    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    // ── files / recordings: /api/blob/<incident>/<name> ──
    if (p.startsWith('/api/blob/')) {
      const parts = p.slice(10).split('/').map(decodeURIComponent);
      if (parts.length !== 2 || !parts[0] || !parts[1]) return json(res, 400, { error: 'bad blob path' });
      const fp = blobPath(parts[0], parts[1]);
      if (req.method === 'PUT' || req.method === 'POST') {
        const buf = await readRaw(req, MAX_BLOB);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        if (u.searchParams.get('append') === '1') fs.appendFileSync(fp, buf); else fs.writeFileSync(fp, buf);
        const ct = String(req.headers['content-type'] || 'application/octet-stream').slice(0, 100);
        try { fs.writeFileSync(fp + '.type', ct); } catch (e) {}
        return json(res, 200, { ok: true, size: fs.statSync(fp).size });
      }
      if (req.method === 'GET') {
        let st; try { st = fs.statSync(fp); } catch (e) { res.writeHead(404); return res.end('Not found'); }
        let ct = 'application/octet-stream'; try { ct = fs.readFileSync(fp + '.type', 'utf8'); } catch (e) {}
        const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
        const hdr = { 'Content-Type': ct, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
        if (u.searchParams.get('dl')) hdr['Content-Disposition'] = 'attachment; filename="' + safeSeg(parts[1]) + '"';
        if (range) {
          let a = range[1] === '' ? Math.max(0, st.size - parseInt(range[2], 10)) : parseInt(range[1], 10);
          let b = range[1] === '' || range[2] === '' ? st.size - 1 : Math.min(parseInt(range[2], 10), st.size - 1);
          if (a > b || a >= st.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
          res.writeHead(206, { ...hdr, 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Content-Length': b - a + 1 });
          return fs.createReadStream(fp, { start: a, end: b }).pipe(res);
        }
        res.writeHead(200, { ...hdr, 'Content-Length': st.size });
        return fs.createReadStream(fp).pipe(res);
      }
    }
    if (p.startsWith('/api/blobs/') && req.method === 'GET') {
      const inc = decodeURIComponent(p.slice(11));
      const dir = path.join(BLOB_DIR, safeSeg(inc));
      let list = [];
      try {
        list = fs.readdirSync(dir).filter(n => !n.endsWith('.type')).map(n => {
          const st = fs.statSync(path.join(dir, n));
          let type = ''; try { type = fs.readFileSync(path.join(dir, n + '.type'), 'utf8'); } catch (e) {}
          return { name: n, size: st.size, type, ts: st.mtimeMs };
        });
      } catch (e) {}
      return json(res, 200, { files: list });
    }


    // ── HQ sign-in ──
    if (p === '/api/hq/login' && req.method === 'POST') {
      const b = await readBody(req), k = clientIp(req) + '|' + String(b.username || '').toLowerCase();
      const wait = lockedOut(k); if (wait) return json(res, 429, { error: 'Too many failed attempts. Try again in ' + Math.ceil(wait / 60) + ' min.' });
      const who = checkLogin(b.username, b.password);
      if (!who) { noteFail(k); return json(res, 401, { error: 'Wrong username or password' }); }
      fails.delete(k);
      return json(res, 200, { token: newSession(who), user: who.user, role: who.role, expires: Date.now() + SESSION_MS });
    }
    if (p === '/api/hq/me' && req.method === 'GET') { const s = sessionOf(req); return s ? json(res, 200, { user: s.user, role: s.role }) : json(res, 401, { error: 'Not signed in' }); }
    if (p === '/api/hq/logout' && req.method === 'POST') { const m = /^Bearer ([a-f0-9]{64})$/.exec(String(req.headers.authorization || '')); if (m) sessions.delete(m[1]); return json(res, 200, { ok: true }); }
    if (p === '/api/hq/users') {
      const s = sessionOf(req); if (!s) return json(res, 401, { error: 'Not signed in' });
      if (s.role !== 'admin') return json(res, 403, { error: 'Only the HQ owner can manage operators' });
      if (req.method === 'GET') return json(res, 200, { owner: OWNER, ownerPasswordFromEnv: !ownerGenerated, users: Object.entries(hqUsers).map(([u, v]) => ({ username: u, role: v.role, created: v.created })) });
      if (req.method === 'POST') {
        const b = await readBody(req), name = String(b.username || '').trim().toLowerCase();
        if (b.remove) { delete hqUsers[name]; saveUsers(); for (const [t, x] of sessions) if (x.user === name) sessions.delete(t); return json(res, 200, { ok: true }); }
        if (!/^[a-z0-9._-]{3,32}$/.test(name) || name === OWNER) return json(res, 400, { error: 'Username: 3-32 letters, digits, dot, dash or underscore' });
        if (String(b.password || '').length < 10) return json(res, 400, { error: 'Password must be at least 10 characters' });
        const salt = crypto.randomBytes(16).toString('hex');
        hqUsers[name] = { salt, hash: pwHash(b.password, salt), role: 'operator', created: Date.now() }; saveUsers();
        for (const [t, x] of sessions) if (x.user === name) sessions.delete(t);
        return json(res, 200, { ok: true });
      }
    }
    // ── LCR credentials: issued by HQ, verified here, never readable by clients ──
    if (p === '/api/hq/lcr/credential' && req.method === 'POST') {
      const s = sessionOf(req); if (!s) return json(res, 401, { error: 'Not signed in' });
      const b = await readBody(req), id = String(b.stationId || '');
      const reg = store['registry:stations'] && store['registry:stations'].value || {};
      if (!reg[id]) return json(res, 404, { error: 'Unknown station' });
      const pass = newPassphrase(), salt = crypto.randomBytes(16).toString('hex');
      const cur = store[SECRET_KEY], map = (cur && cur.value) || {};
      map[id] = { salt, hash: pwHash(pass, salt), issuedAt: Date.now(), by: s.user };
      store[SECRET_KEY] = { value: map, v: (cur ? cur.v : 0) + 1, ts: Date.now() }; scheduleSave();
      return json(res, 200, { passphrase: pass });
    }
    if (p === '/api/lcr/login' && req.method === 'POST') {
      const b = await readBody(req), id = String(b.stationId || ''), k = clientIp(req) + '|' + id;
      const wait = lockedOut(k); if (wait) return json(res, 429, { error: 'Too many failed attempts. Try again in ' + Math.ceil(wait / 60) + ' min.' });
      const reg = store['registry:stations'] && store['registry:stations'].value || {};
      const st = reg[id]; const a = store[SECRET_KEY] && store[SECRET_KEY].value && store[SECRET_KEY].value[id];
      if (!st || !a) return json(res, 404, { error: 'Not an HQ-issued control room' });
      if (st.disabled) return json(res, 403, { error: 'This control room has been disabled by HQ' });
      if (!eq(pwHash(b.passphrase || '', a.salt), a.hash)) { noteFail(k); return json(res, 401, { error: 'Incorrect passphrase for this Station ID' }); }
      fails.delete(k);
      return json(res, 200, { ok: true });
    }
    // ── Ghana Post GPS digital address → coordinates (needs a configured lookup service) ──
    if (p === '/api/ghanapost/resolve' && req.method === 'POST') {
      if (!sessionOf(req)) return json(res, 401, { error: 'Not signed in' });
      const b = await readBody(req), addr = String(b.address || '').toUpperCase().replace(/\s+/g, '');
      if (!GP_RE.test(addr)) return json(res, 400, { error: 'That is not a Ghana Post GPS address. Expected a form like AK-039-5028.' });
      const url = process.env.GHANAPOST_LOOKUP_URL;
      if (!url) return json(res, 501, { configured: false, error: 'Ghana Post GPS lookup is not set up on this server.' });
      const norm = addr.includes('-') ? addr : addr.replace(/^([A-Z]{2,3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
      try {
        const headers = {}; if (process.env.GHANAPOST_API_KEY) headers[process.env.GHANAPOST_API_KEY_HEADER || 'Authorization'] = process.env.GHANAPOST_API_KEY;
        const post = String(process.env.GHANAPOST_LOOKUP_METHOD || 'GET').toUpperCase() === 'POST';
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
        const r = await fetch(url.replace('{address}', encodeURIComponent(norm)), post
          ? { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'address=' + encodeURIComponent(norm), signal: ctl.signal }
          : { headers, signal: ctl.signal });
        clearTimeout(t);
        if (!r.ok) return json(res, 502, { configured: true, error: 'The lookup service answered ' + r.status });
        const ll = findLatLng(await r.json());
        if (!ll || ll.lat < 4 || ll.lat > 11.5 || ll.lng < -3.5 || ll.lng > 1.5) return json(res, 404, { configured: true, error: 'No valid location was returned for ' + norm });
        return json(res, 200, { address: norm, lat: ll.lat, lng: ll.lng, source: 'ghanapost-lookup' });
      } catch (e) { return json(res, 502, { configured: true, error: 'Could not reach the lookup service: ' + (e.name === 'AbortError' ? 'timed out' : e.message) }); }
    }

    if (p.startsWith('/api/kv/')) {
      const key = decodeURIComponent(p.slice(8));
      if (!key || key.length > 300) return json(res, 400, { error: 'bad key' });
      if (key === SECRET_KEY) return json(res, 403, { error: 'This key is private to the server' });
      if (req.method === 'PUT' && HQ_WRITE_KEYS.has(key) && !sessionOf(req)) return json(res, 401, { error: 'HQ sign-in required' });
      if (req.method === 'GET') {
        const e = store[key];
        return json(res, 200, e ? { found: true, value: e.value, v: e.v } : { found: false, v: 0 });
      }
      if (req.method === 'PUT') {
        const b = await readBody(req);
        const cur = store[key];
        const curV = cur ? cur.v : 0;
        if (b.ifVersion !== undefined && b.ifVersion !== curV) {
          return json(res, 409, { conflict: true, v: curV });
        }
        store[key] = { value: b.value, v: curV + 1, ts: Date.now() };
        scheduleSave();
        broadcast({ key, v: curV + 1 });
        return json(res, 200, { ok: true, v: curV + 1 });
      }
    }

    // static files (the HTML apps)
    if (req.method === 'GET') {
      let rel = decodeURIComponent(p === '/' ? '/index' : p);
      if (rel === '/index') {
        const files = fs.readdirSync(DIR).filter(f => f.endsWith('.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>GEAMS</title><body style="font-family:system-ui;background:#06121f;color:#e6f1ff;padding:24px"><h2>GEAMS apps</h2><ul>' +
          files.map(f => `<li style="margin:10px 0"><a style="color:#38bdf8" href="/${f}">${f.replace(/\.html$/, '')}</a></li>`).join('') + '</ul>');
      }
      const file = path.normalize(path.join(DIR, rel));
      if (!file.startsWith(DIR + path.sep) || /geams-data|geams-server|geams-blobs|geams-hq-users/.test(file)) { res.writeHead(403); return res.end('Forbidden'); }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
      return;
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    json(res, 400, { error: String(e.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  const ips = [].concat(...Object.values(nets)).filter(n => n.family === 'IPv4' && !n.internal).map(n => n.address);
  console.log('GEAMS backend running');
  console.log('  This computer:  http://localhost:' + PORT + '/');
  ips.forEach(ip => console.log('  Same network:   http://' + ip + ':' + PORT + '/   (GPS/camera on phones need https — see top of this file)'));
  console.log('  Data file:      ' + DATA_FILE);
  console.log('  HQ login:       user "' + OWNER + '"' + (ownerGenerated ? ' password ' + ownerPass + '   <-- generated for this run; set GEAMS_HQ_ADMIN_PASSWORD to choose your own' : ' (password from GEAMS_HQ_ADMIN_PASSWORD)'));
  console.log('  Ghana Post GPS: ' + (process.env.GHANAPOST_LOOKUP_URL ? 'lookup service configured' : 'lookup not configured (HQ can still enter coordinates or search a place)'));
});
