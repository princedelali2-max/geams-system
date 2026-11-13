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
/* Storage: files by default; with GEAMS_DATABASE_URL everything is also kept in a database and restored from it on a fresh disk */
const PERSIST = require('./geams-persist.js');
if (PERSIST.DB_URL) {
  const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'geams-persist.js'), 'preboot'], { env: process.env, stdio: 'inherit' });
  if (r.status !== 0 && process.env.GEAMS_DB_OPTIONAL !== '1') { console.log('GEAMS cannot start: the database is configured but could not be reached or read (see above). Fix GEAMS_DATABASE_URL, or set GEAMS_DB_OPTIONAL=1 to start on local files only.'); process.exit(1); }
}
const WRITER = PERSIST.createWriter();
const mirror = (...fps) => { for (const fp of fps) WRITER.markFile(fp); };
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
const saveState = { ok: true, lastError: null, lastOkAt: null, failedSince: null, loadNote: null };
function loadStore() {
  const tryRead = (f) => { const t = fs.readFileSync(f, 'utf8'); const o = JSON.parse(t); if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('not a data object'); return o; };
  if (!fs.existsSync(DATA_FILE) && !fs.existsSync(DATA_FILE + '.tmp')) return {};
  try { return tryRead(DATA_FILE); } catch (e) {
    // Never start empty over a damaged file: keep it, try the half-finished save, and say so loudly.
    let kept = null; try { if (fs.existsSync(DATA_FILE)) { kept = DATA_FILE + '.corrupt-' + Date.now(); fs.copyFileSync(DATA_FILE, kept); } } catch (e2) {}
    try { const o = tryRead(DATA_FILE + '.tmp'); saveState.loadNote = 'The data file was damaged; recovered from the last complete save copy. Damaged file kept as ' + (kept || '(none)') + '.'; console.log('!! ' + saveState.loadNote); return o; } catch (e3) {}
    saveState.loadNote = 'The data file could not be read (' + e.message + '). Starting EMPTY. The damaged file was kept as ' + (kept || '(not present)') + '. Restore from a backup: node geams-persist.js restore <backup>.';
    console.log('!! ' + saveState.loadNote); return {};
  }
}
try { store = loadStore(); } catch (e) { store = {}; }
WRITER.attach(() => store);
let saveTimer = null;
function writeStoreNow(cb) {
  const tmp = DATA_FILE + '.tmp'; let fd = null;
  const fail = (err) => {
    if (saveState.ok) { saveState.failedSince = Date.now(); console.log('!! SAVE FAILED: ' + err.message + ' — new changes are NOT on disk yet. Retrying every 5 s.'); }
    saveState.ok = false; saveState.lastError = err.message; if (fd != null) { try { fs.closeSync(fd); } catch (e) {} }
    if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; writeStoreNow(); }, 5000);
    if (cb) cb(err);
  };
  try {
    const data = JSON.stringify(store);
    fd = fs.openSync(tmp, 'w'); fs.writeSync(fd, data); fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) { return fail(err); }
  if (!saveState.ok) console.log('Saving works again.');
  saveState.ok = true; saveState.lastError = null; saveState.failedSince = null; saveState.lastOkAt = Date.now(); if (cb) cb(null);
}
function scheduleSave(key) {
  WRITER.markKV(key);
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeStoreNow(); }, 500);
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


/* The version of an app is a short fingerprint of its file, added to the page when it is served. */
const buildOf = (file) => { try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 8); } catch (e) { return ''; } };
function injectBuild(file, buf) {
  const b = buildOf(file), s = buf.toString('utf8');
  return Buffer.from(s.replace(/<\/head>/i, '<script>window.GEAMS_BUILD="' + b + '";window.GEAMS_FILE=' + JSON.stringify(path.basename(file)) + ';</script><script src="vendor/geams-diag.js"></script>' + (/vendor\/geams-i18n\.js/.test(s) ? '' : '<script src="vendor/geams-i18n.js"></script>') + '<script src="vendor/geams-guide.js"></script><script src="vendor/geams-a11y.js"></script><script src="vendor/geams-loginclear.js"></script>' + (/geams-(dispatch-app|fire-service|ambulance-service)\.html$/.test(file) ? '<script src="vendor/geams-roster.js"></script>' : '') + (/geams-(station|hq)-dashboard__1_\.html$/.test(file) ? '<script src="vendor/geams-bulk.js"></script>' : '') + (/geams-hq-dashboard__1_\.html$/.test(file) ? '<script src="vendor/geams-agency-admin.js"></script>' : '') + (/geams-(fire|ambulance)-service\.html$/.test(file) ? '<script src="vendor/geams-agency-banner.js"></script>' : '') + '</head>'), 'utf8');
}

/* Staff action log: who changed what and when. It records field names and status words, never names, phones or locations. */
const STAFF_ROLES = ['hq', 'lcr', 'officer', 'fire', 'ambulance'];
const whoOf = (ses) => ses ? (ses.role + ':' + (ses.cu || ses.u || ses.user || ses.badge || '?')) : 'system';
function staffLog(ses, action, ref, detail, station) {
  try { const lg = kvGet('registry:staffLog', []).slice(-2999); lg.push({ at: Date.now(), by: whoOf(ses), role: ses && ses.role, station: station || (ses && (ses.sid || ses.lcr)) || null, action, ref: ref ? String(ref).slice(0, 60) : null, detail: detail ? String(detail).slice(0, 200) : '' }); kvSet('registry:staffLog', lg); } catch (e) {}
}
const TRACK = ['status', 'officerStatus', 'priority', 'type', 'officerName', 'officerBadge', 'assignedTo', 'resolvedAt', 'drill', 'legalHold'];
const SHORT = (v) => v === undefined || v === null ? '-' : (typeof v === 'object' ? (v.by ? 'set' : 'yes') : String(v).slice(0, 30));
function logCrewChanges(ses, key, prev, next) {
  if (!ses || !isObj(next)) return; const m = /^lcr:([^:]+):(handovers|roster)$/.exec(key); if (!m) return; const p = isObj(prev) ? prev : {};
  for (const [id, r] of Object.entries(next)) { const o = p[id]; if (o && JSON.stringify(o) === JSON.stringify(r)) continue;
    if (m[2] === 'handovers') staffLog(ses, o ? 'handover.read' : 'handover.filed', id, '', m[1]);
    else staffLog(ses, o ? 'roster.update' : 'roster.add', id, o ? ['shift', 'avail'].filter(k => o[k] !== r[k]).map(k => k + ': ' + o[k] + ' → ' + r[k]).join('; ') : r.kind, m[1]); }
  for (const id of Object.keys(p)) if (!(id in next)) staffLog(ses, 'roster.remove', id, '', m[1]);
}
function logIncidentChanges(ses, key, prev, next) {
  if (!ses || !STAFF_ROLES.includes(ses.role) || !/^(lcr|fire|ambulance):([^:]+):incidents$/.test(key) || !isObj(next)) return;
  const st = key.split(':')[1] === undefined ? null : key.split(':')[1], kind = key.split(':')[0], p = isObj(prev) ? prev : {};
  for (const [id, r] of Object.entries(next)) { if (!isObj(r)) continue; const o = p[id];
    if (!o) { staffLog(ses, 'incident.created', id, kind + ' ' + SHORT(r.type) + (r.drill ? ' (drill)' : ''), st); continue; }
    if (o === r) continue; const ch = TRACK.filter(k => JSON.stringify(o[k]) !== JSON.stringify(r[k]));
    if (ch.length) staffLog(ses, 'incident.update', id, ch.map(k => k + ': ' + SHORT(o[k]) + ' → ' + SHORT(r[k])).join('; '), st); }
  for (const id of Object.keys(p)) if (!(id in next)) staffLog(ses, 'incident.removed', id, kind, st);
}

/* Content-Security-Policy for the app pages.
 * The apps still use inline scripts and click handlers, so script-src keeps 'unsafe-inline'. What this policy does stop: loading
 * scripts from any other site, run text as code (no 'unsafe-eval'; GEAMS_CSP_EVAL=1 puts it back if some phone's face check needs it), sending data to any other site (connect-src), plugins, extra <base> tags, framing by other sites and
 * form posts elsewhere. GEAMS_CSP = enforce (default) | report (log only) | off. */
function cspHeader() {
  const mode = (process.env.GEAMS_CSP || 'enforce').toLowerCase(); if (mode === 'off') return null;
  const origin = (u) => { try { return new URL(String(u).replace(/\{[^}]*\}/g, 'x')).origin; } catch (e) { return null; } };
  const cfgHosts = [process.env.GEAMS_TILE_URL, process.env.GEAMS_ROUTE_URL, process.env.GEAMS_GEOCODE_URL].map(origin).filter(Boolean);
  const extra = String(process.env.GEAMS_CSP_EXTRA_HOSTS || '').split(/[\s,]+/).filter(Boolean);
  const tiles = ['https://server.arcgisonline.com', 'https://*.tile.openstreetmap.org', 'https://tile.openstreetmap.org'].concat(cfgHosts, extra);
  const connect = ["'self'", 'https://photon.komoot.io', 'https://router.project-osrm.org', 'https://server.arcgisonline.com'].concat(cfgHosts, extra);
  const d = ["default-src 'self'", "script-src 'self' 'unsafe-inline' " + (process.env.GEAMS_CSP_EVAL === '1' ? "'unsafe-eval' " : '') + 'blob:', "style-src 'self' 'unsafe-inline'", 'img-src \'self\' data: blob: ' + tiles.join(' '), 'connect-src ' + connect.join(' ') + ' blob: data:', "font-src 'self' data:", "media-src 'self' blob: data:", "worker-src 'self' blob:", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'", 'report-uri /api/csp-report'];
  return { name: mode === 'report' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy', value: d.join('; ') };
}
const CSP = cspHeader();
function cors(res) {
  const rq = res.req || {}, hd = rq.headers || {}, ALLOW = process.env.GEAMS_ALLOWED_ORIGIN;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(self), payment=(), usb=()');
  if ((rq.socket && rq.socket.encrypted) || String(hd['x-forwarded-proto'] || '').split(',')[0] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (ALLOW) { const list = ALLOW.split(',').map(x => x.trim()); if (hd.origin && list.includes(hd.origin)) { res.setHeader('Access-Control-Allow-Origin', hd.origin); res.setHeader('Vary', 'Origin'); } }
  else res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, X-Geams-Name, Authorization, X-Geams-Device');
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
function saveUsers() { try { fs.writeFileSync(USERS_FILE, JSON.stringify(hqUsers)); mirror(USERS_FILE); } catch (e) { console.log('Could not save HQ users:', e.message); } }
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
/* ── Signed tokens ──
 * Every sign-in (HQ, control room, officer, fire, ambulance, civilian) returns a token signed with a
 * server secret (GEAMS_TOKEN_SECRET, else a random one saved next to the data file so tokens survive a
 * restart). The token says WHO the caller is and WHICH ROLE they hold; the server decides access from it.
 * It is sent as "Authorization: Bearer ..." and, for images/video/audio tags that cannot send headers,
 * as an HttpOnly cookie that is accepted for reading files only. */
const SECRET_FILE = path.join(path.dirname(DATA_FILE), 'geams-secret.key');
let TOKEN_SECRET = process.env.GEAMS_TOKEN_SECRET;
if (!TOKEN_SECRET) { try { TOKEN_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (e) {} }
if (!TOKEN_SECRET) { TOKEN_SECRET = crypto.randomBytes(32).toString('hex'); try { fs.writeFileSync(SECRET_FILE, TOKEN_SECRET, { mode: 0o600 }); mirror(SECRET_FILE); } catch (e) {} }
const revoked = new Set();
const SESSION_MS = 12 * 3600 * 1000, LONG_MS = 7 * 24 * 3600 * 1000;
function signToken(payload, ms) {
  const p = Object.assign({}, payload, { iat: Date.now(), exp: Date.now() + ms, jti: crypto.randomBytes(8).toString('hex') });
  const body = Buffer.from(JSON.stringify(p)).toString('base64url');
  return 'v1.' + body + '.' + crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
}
const CMD_KEY = 'registry:commanderAuth', AGENCY_KEY = 'registry:agencyHq';
const commanderAccts = (sid) => { const m = store[CMD_KEY] && store[CMD_KEY].value; return (m && m[sid]) || {}; };
function verifyToken(t) {
  const m = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(t || '')); if (!m) return null;
  const want = crypto.createHmac('sha256', TOKEN_SECRET).update(m[1]).digest('base64url'); if (!eq(want, m[2])) return null;
  let p; try { p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!p || p.exp < Date.now() || revoked.has(p.jti)) return null;
  if (p.r !== 'hq' && p.r !== 'civilian') { const ep = store['registry:authEpoch'] && store['registry:authEpoch'].value; if (ep && ep.at && p.iat < ep.at) return null; }   // HQ rotated every station-side token
  if (p.r === 'hq' && p.hr !== 'admin') { const u = hqUsers[p.u]; if (!u || (u.changed && u.changed > p.iat)) return null; }
  if (p.r === 'officer' || p.r === 'fire' || p.r === 'ambulance') { const ua = (store['registry:unitAuth'] && store['registry:unitAuth'].value || {})[p.r + ':' + p.b]; if (ua && ((ua.changed && ua.changed > p.iat) || ua.disabled)) return null; }   // password changed or reset, or account disabled by its HQ: older sign-ins end
  if (p.r === 'fire_hq' || p.r === 'ambulance_hq') { const a = (store[AGENCY_KEY] && store[AGENCY_KEY].value || {})[p.ak + ':' + p.u]; if (!a || a.disabled || (a.changed && a.changed > p.iat)) return null; }   // password changed or reset: older sign-ins end
  if (p.r === 'lcr') {
    const st = (store['registry:stations'] && store['registry:stations'].value || {})[p.s]; if (st && st.disabled) return null;
    const accts = commanderAccts(p.s);
    if (p.cu) { const a = accts[p.cu]; if (!a || a.disabled || (a.changed && a.changed > p.iat)) return null; }
    else if (Object.values(accts).some(a => !a.disabled)) return null;   // once HQ creates commander accounts, a station sign-in without one stops working
  }
  return p;
}
function rawToken(req, allowCookie) {
  const m = /^Bearer (v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(String(req.headers.authorization || '')); if (m) return m[1];
  if (allowCookie) { const c = /(?:^|;\s*)geams_t=(v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(String(req.headers.cookie || '')); if (c) return c[1]; }
  return null;
}
function sessionOf(req, allowCookie) {
  const p = verifyToken(rawToken(req, allowCookie)); if (!p) return null;
  return { dev: p.d, role: p.r, user: p.u, cmd: p.cu ? { user: p.cu, name: p.cn, rank: p.cr } : null, hqRole: p.hr, sid: p.s, lcr: p.l, badge: p.b, id: p.i, phone: p.p, verified: !!p.v, jti: p.jti, agency: p.ak, mc: !!p.mc, name: p.cn };
}
function issue(res, req, payload, ms) {
  const t = signToken(payload, ms);
  const secure = /https/i.test(String(req.headers['x-forwarded-proto'] || '')) ? '; Secure' : '';
  res.setHeader('Set-Cookie', 'geams_t=' + t + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(ms / 1000) + secure);
  return t;
}
const otps = new Map();                          // phone -> { salt, hash, exp, tries }
setInterval(() => { const n = Date.now(); for (const [k, v] of otps) if (v.exp < n) otps.delete(k); }, 60000);
const fails = new Map();                         // ip|user -> { n, until }
function lockedOut(k) { const f = fails.get(k); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; }
function bump(k, max, ms) { const f = fails.get(k) || { n: 0, until: 0 }; if (f.until > Date.now()) return false; f.n++; if (f.n > max) { f.until = Date.now() + ms; f.n = 0; fails.set(k, f); return false; } fails.set(k, f); return true; }
function noteFail(k) { const f = fails.get(k) || { n: 0, until: 0 }; f.n++; if (f.n >= 5) { f.until = Date.now() + 5 * 60000; f.n = 0; } fails.set(k, f); }
// X-Forwarded-For is believed only when the request comes from this machine (your Caddy/nginx) or GEAMS_TRUST_PROXY=1; otherwise anyone could fake an address to dodge the rate limits.
const clientIp = (req) => { const ra = String(req.socket.remoteAddress || ''); const loop = /^(::1|127\.|::ffff:127\.)/.test(ra); return String((loop || process.env.GEAMS_TRUST_PROXY === '1') && req.headers['x-forwarded-for'] || ra).split(',')[0].trim(); };

/* ── Tamper-evident evidence ──
 * Every stored file gets a seal (SHA-256 of the whole file, size, time, who wrote it) signed by this server,
 * and a chain-of-custody log in which each entry is signed together with the one before it.
 * Changing a file, a seal or a log line afterwards is detected when the evidence is verified.
 * Honest limit: the signing key lives on this server, so this proves the file is unchanged since GEAMS stored it,
 * not that an outside authority timestamped it. */
const EV_KEY = crypto.createHmac('sha256', TOKEN_SECRET).update('geams-evidence-seal-v1').digest();
const evSign = (str) => crypto.createHmac('sha256', EV_KEY).update(str).digest('hex');
const ZERO = '0'.repeat(64);
const sealStr = (x) => ['GEAMS-EVIDENCE', 'v1', x.inc, x.name, x.size, x.sha256, x.sealedAt, x.writes].join('|');
const readSeal = (fp) => { try { return JSON.parse(fs.readFileSync(fp + '.seal', 'utf8')); } catch (e) { return null; } };
const hashStates = new Map(), lastChain = new Map(), viewSeen = new Map();
function sha256File(fp) { return new Promise((resolve, reject) => { const h = crypto.createHash('sha256'); fs.createReadStream(fp).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject); }); }
function custodyAdd(fp, ev) {
  let prev = lastChain.get(fp);
  if (!prev) { prev = ZERO; try { const ls = fs.readFileSync(fp + '.log', 'utf8').trim().split('\n'); prev = JSON.parse(ls[ls.length - 1]).h; } catch (e) {} }
  ev.prev = prev; ev.h = evSign(prev + '|' + JSON.stringify(ev));
  try { fs.appendFileSync(fp + '.log', JSON.stringify(ev) + '\n'); mirror(fp + '.log'); } catch (e) {}
  lastChain.set(fp, ev.h);
}
function readCustody(fp) {
  let lines = []; try { lines = fs.readFileSync(fp + '.log', 'utf8').trim().split('\n').filter(Boolean); } catch (e) {}
  const out = []; let prev = ZERO, ok = true;
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch (x) { ok = false; break; }
    const h = e.h; delete e.h;
    if (e.prev !== prev || evSign(prev + '|' + JSON.stringify(e)) !== h) ok = false;
    e.h = h; prev = h; out.push(e);
  }
  return { entries: out, chainOk: ok };
}
const actorOf = (ses, req) => ({ role: ses.role, user: ses.user || '', dev: String(req.headers['x-geams-device'] || '').slice(0, 60) });
async function sealWrite(fp, inc, name, buf, append, ses, req, ct) {
  const prevSeal = readSeal(fp), actor = actorOf(ses, req), now = Date.now();
  let h, size;
  const st = hashStates.get(fp), curSize = (() => { try { return fs.statSync(fp).size; } catch (e) { return 0; } })();
  if (append && st && st.size === curSize) { h = st.h; h.update(buf); size = curSize + buf.length; }
  else if (append && curSize) { h = crypto.createHash('sha256'); await new Promise((ok, no) => fs.createReadStream(fp).on('data', d => h.update(d)).on('end', ok).on('error', no)); h.update(buf); size = curSize + buf.length; }
  else { h = crypto.createHash('sha256'); h.update(buf); size = buf.length; }
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  if (append) fs.appendFileSync(fp, buf); else fs.writeFileSync(fp, buf);
  if (hashStates.size > 300) hashStates.clear();
  hashStates.set(fp, { h, size });
  const seal = { inc, name, size, sha256: h.copy().digest('hex'), sealedAt: now, writes: (prevSeal && append ? prevSeal.writes : 0) + 1, by: prevSeal && append ? prevSeal.by : actor, type: ct };
  seal.sig = evSign(sealStr(seal));
  fs.writeFileSync(fp + '.seal', JSON.stringify(seal)); mirror(fp, fp + '.seal');
  scheduleTimestamp(fp);
  custodyAdd(fp, { t: now, ev: !append || !prevSeal ? 'stored' : 'appended', role: actor.role, user: actor.user, dev: actor.dev, ip: clientIp(req), bytes: buf.length, size, sha256: seal.sha256 });
  return seal;
}
function noteView(fp, ses, req, dl) {
  const k = fp + '|' + ses.role + '|' + (ses.user || '') + '|' + (dl ? 'd' : 'v'), n = Date.now();
  if (viewSeen.get(k) && n - viewSeen.get(k) < 60000) return; viewSeen.set(k, n);
  if (viewSeen.size > 5000) viewSeen.clear();
  const sl = readSeal(fp);
  custodyAdd(fp, { t: n, ev: dl ? 'downloaded' : 'viewed', role: ses.role, user: ses.user || '', ip: clientIp(req), sha256: sl ? sl.sha256 : null });
}
async function verifyEvidence(fp, inc, name, ses, req) {
  let st; try { st = fs.statSync(fp); } catch (e) { return { status: 'missing', message: 'The file is not on the server' }; }
  const seal = readSeal(fp), cust = readCustody(fp);
  let sha = null; try { sha = await sha256File(fp); } catch (e) {}
  let status = 'intact', message = 'The file is exactly as GEAMS stored it.';
  if (!seal) { status = 'unsealed'; message = 'This file was stored before sealing existed, so it cannot be proven unchanged.'; }
  else if (evSign(sealStr(seal)) !== seal.sig) { status = 'seal-forged'; message = 'The seal does not carry a valid GEAMS signature.'; }
  else if (sha !== seal.sha256 || st.size !== seal.size) { status = 'modified'; message = 'The file no longer matches its seal. It was changed after it was stored.'; }
  else if (!cust.chainOk) { status = 'log-broken'; message = 'The file matches its seal, but the chain-of-custody log has been altered.'; }
  const timestamp = await checkTimestamp(fp, seal);
  if (timestamp.state === 'invalid' && status === 'intact') { status = 'timestamp-invalid'; message = 'The file matches its seal, but the outside timestamp does not verify.'; }
  custodyAdd(fp, { t: Date.now(), ev: 'verified', role: ses.role, user: ses.user || '', ip: clientIp(req), result: status, sha256: sha });
  return { status, message, timestamp, intact: status === 'intact', sha256: sha, size: st.size, sealedAt: seal && seal.sealedAt, by: seal && seal.by, writes: seal && seal.writes, chainOk: cust.chainOk, events: cust.entries.length + 1, verifiedAt: Date.now() };
}
const SECRET_KEY = 'registry:stationAuth';       // LCR passphrase hashes: server-side only
const HQ_WRITE_KEYS = new Set(['registry:stations', 'hq:tacticalOps']);
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newPassphrase() { const b = crypto.randomBytes(12); const c = [...b].map(x => ALPHA[x % ALPHA.length]).join(''); return c.slice(0, 4) + '-' + c.slice(4, 8) + '-' + c.slice(8, 12); }

const AUTO_APPROVE = process.env.GEAMS_AUTO_APPROVE_UNITS === '1';       // 1 = crews work at once, without approval
const REQUIRE_VERIFIED = process.env.GEAMS_REQUIRE_VERIFIED_CIVILIANS === '1'; // 1 = civilian accounts need a verified phone
function approverName(kind) { return kind === 'fire' ? 'your Fire HQ' : kind === 'ambulance' ? 'your Ambulance HQ' : 'your control room'; }
function normPhone(p) {                                                    // Ghana numbers: 024xxxxxxx / 233xxxxxxxxx / +233...
  let d = String(p || '').replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (/^0\d{9}$/.test(d)) d = '233' + d.slice(1);
  return /^233\d{9}$/.test(d) ? '+' + d : null;
}
const BUILTIN_STATIONS = ['GH-GA-ACC-001-B9C1','GH-GA-ACC-007-F2A3','GH-AS-KUM-001-A4F2','GH-AS-KUM-002-C7D9','GH-WR-TAK-001-D2E8','GH-CR-CAP-001-E5F1','GH-NR-TAM-001-G3H6','GH-UE-BOL-001-H8I2','GH-VR-HO-001-J4K7','GH-VR-HOH-001-P3Q7','GH-BA-SUN-001-K9L3','GH-AH-KOF-001-L1M5','GH-SW-SEK-001-M6N9'];
/* Demo only: GEAMS_SEED_DEFAULT_STATIONS=1 gives the 13 built-in stations their old documented passphrases so a
 * test install works at once. Leave it OFF in real use and issue each login from HQ (Stations -> Issue login). */
const DEFAULT_PASS = ['accra2024','tema2024','kumasi2024','suame2024','takoradi2024','capecoast2024','tamale2024','bolga2024','ho2024','hohoe2024','sunyani2024','koforidua2024','sekondi2024'];
function seedDefaultStations() {
  if (process.env.GEAMS_SEED_DEFAULT_STATIONS !== '1') return 0;
  const cur = store[SECRET_KEY], map = (cur && cur.value) || {}; let n = 0;
  BUILTIN_STATIONS.forEach((id, i) => { if (!map[id]) { const salt = crypto.randomBytes(16).toString('hex'); map[id] = { salt, hash: pwHash(DEFAULT_PASS[i], salt), issuedAt: Date.now(), by: 'seed' }; n++; } });
  if (n) { store[SECRET_KEY] = { value: map, v: (cur ? cur.v : 0) + 1, ts: Date.now() }; scheduleSave(SECRET_KEY); }
  return n;
}

/* ── Who may read and write what ──
 * One rule per family of shared records. 'public' = no sign-in needed (read only),
 * 'server' = only the server itself, otherwise the list of roles that may do it.
 * Honest limit: a record is one shared map, so the server decides by ROLE (and, for a control room's own
 * roster, by station), not field by field. Officers, fire and ambulance crews are fenced to their own control room's
 * records: another area's incidents and roster answer 403 (checked by t_agency.js). */
const AGENCY_ROLES = ['fire_hq', 'ambulance_hq'];
const ALL_R = ['hq', 'lcr', 'officer', 'fire', 'ambulance', 'civilian'];
const RULES = [
  [/^registry:(stationAuth|unitAuth|unitPending|pushSubs|commanderAuth|authEpoch|faces|faceAudit|civRecovery|retentionLog|consents|feedback|clientErrors|staffLog|blocks|escalations|agencyHq|agencyEscalations|agencyChat)$/, { r: 'server', w: 'server' }],
  [/^hq:lockdown$/, { r: ALL_R, w: 'server' }],
  [/^hq:pilot$/, { r: ALL_R, w: 'server' }],
  [/^registry:stations$/, { r: 'public', w: ['hq'] }],
  [/^registry:stationLocations$/, { r: 'public', w: ['hq', 'lcr'] }],
  [/^registry:lcrCommanders$/, { r: ['hq', 'lcr', 'officer'], w: ['hq', 'lcr'] }],
  [/^registry:officers$/, { r: ['hq', 'lcr', 'officer', 'fire', 'ambulance'], w: 'server' }],
  [/^registry:fire$/, { r: ['hq', 'lcr', 'officer', 'fire', 'ambulance', 'fire_hq'], w: 'server' }],
  [/^registry:ambulance$/, { r: ['hq', 'lcr', 'officer', 'fire', 'ambulance', 'ambulance_hq'], w: 'server' }],
  [/^agency:fire:broadcast$/, { r: ['hq', 'lcr', 'fire', 'fire_hq'], w: 'server' }],
  [/^agency:ambulance:broadcast$/, { r: ['hq', 'lcr', 'ambulance', 'ambulance_hq'], w: 'server' }],
  [/^registry:civilians$/, { r: ['hq', 'lcr'], w: 'server' }],
  [/^hq:tacticalOps$/, { r: ['hq', 'lcr'], w: ['hq'] }],
  [/^hq:lcr_status$/, { r: ['hq', 'lcr'], w: ['hq', 'lcr'] }],
  [/^public:alerts$/, { r: ALL_R, w: ['hq'] }],
  [/^hq:smsInbox$/, { r: ['hq'], w: ['hq'] }],
  [/^public:ack:[^:]+$/, { r: ['hq', 'lcr'], w: ALL_R }],
  [/^lcr:([^:]+):incidents$/, { r: ALL_R, w: ['hq', 'lcr', 'officer', 'civilian'], fence: true }],
  [/^lcr:([^:]+):intel$/, { r: ['hq', 'lcr'], w: ['hq', 'lcr'], fence: true }],
  [/^lcr:([^:]+):handovers$/, { r: ['hq', 'lcr'], w: ['hq', 'lcr'], fence: true, fenceRead: true }],
  [/^lcr:([^:]+):roster$/, { r: ['hq', 'lcr', 'officer', 'fire', 'ambulance'], w: ['hq', 'lcr', 'officer', 'fire', 'ambulance'], fence: true, fenceRead: true }],
  [/^lcr:([^:]+):officers$/, { r: ['hq', 'lcr', 'officer', 'fire', 'ambulance'], w: ['hq', 'lcr', 'officer'], own: true, fence: true }],
  [/^lcr:([^:]+):officerAlerts$/, { r: ['hq', 'lcr', 'officer'], w: ['hq', 'lcr', 'officer'], own: true, fence: true }],
  [/^fire:([^:]+):incidents$/, { r: ['hq', 'lcr', 'fire', 'fire_hq'], w: ['hq', 'lcr', 'fire'], fence: true }],
  [/^ambulance:([^:]+):incidents$/, { r: ['hq', 'lcr', 'ambulance', 'ambulance_hq'], w: ['hq', 'lcr', 'ambulance'], fence: true }],
  [/^mutualaid:(fire|ambulance):requests$/, { r: ['hq', 'lcr', 'fire', 'ambulance'], w: ['hq', 'lcr', 'fire', 'ambulance'] }],
  [/^backup:/, { r: ['hq', 'lcr'], w: ['hq', 'lcr'] }],
  [/^(chat|evidence|archive|rtc):/, { r: ALL_R, w: ALL_R }],
];
function authorize(req, key, action, allowCookie) {
  let rule = { r: 'auth', w: 'auth' }, m = null, matched = false;
  for (const [re, rl] of RULES) { m = re.exec(key); if (m) { rule = rl; matched = true; break; } }
  const need = rule[action];
  if (need === 'server') return { code: 403, error: 'This data is private to the server' };
  if (need === 'public' && action === 'r') return { ses: sessionOf(req, allowCookie) };
  const ses = sessionOf(req, allowCookie);
  if (!ses) return { code: 401, error: 'Sign in required' };
  if (AGENCY_ROLES.includes(ses.role)) {            // a fire or ambulance HQ reads only the records named for it, never the catch-all
    if (ses.mc) return { code: 403, error: 'Choose your own password first' };
    if (!matched) return { code: 403, error: 'Your role (' + ses.role + ') cannot ' + (action === 'r' ? 'read' : 'write') + ' this data' };
  }
  if (Array.isArray(need) && !need.includes(ses.role)) return { code: 403, error: 'Your role (' + ses.role + ') cannot ' + (action === 'r' ? 'read' : 'write') + ' this data' };
  if (action === 'w' && rule.own && ses.role === 'lcr' && m && m[1] && ses.sid !== m[1]) return { code: 403, error: 'A control room can only change its own roster' };
  // a control room writes only its own station's incident, intel and service maps (reading across stations stays allowed for archives)
  if (action === 'w' && rule.fence && ses.role === 'lcr' && m && m[1] && ses.sid !== m[1]) return { code: 403, error: 'A control room can only change its own station\'s records' };
  if (action === 'r' && rule.fenceRead && ses.role === 'lcr' && m && m[1] && ses.sid !== m[1]) return { code: 403, error: 'That belongs to another control room' };
  // officers, fire and ambulance crews only reach their own station's data
  if (rule.fence && m && m[1] && ['officer', 'fire', 'ambulance'].includes(ses.role) && ses.lcr !== m[1]) return { code: 403, error: 'That belongs to another control room' };
  { const iid = incIdOfKey(key); if (iid && !staffMayUse(ses, iid, action === 'w')) return { code: 403, error: 'That belongs to another control room' }; }
  if (ses.role === 'civilian') { const iid = incIdOfKey(key); if (iid && !civMayUse(ses, iid, action === 'w')) return { code: 403, error: 'That belongs to someone else' }; }
  return { ses, rule, m };
}

/* ── Civilian devices: a civilian token carries a device id (hash of a secret only that phone knows).
 * It is how a phone proves an incident, a face record or a profile is its own. */
const devHash = (secret) => /^[A-Za-z0-9_-]{16,128}$/.test(String(secret || '')) ? crypto.createHash('sha256').update('geams-dev|' + secret).digest('hex').slice(0, 32) : crypto.randomBytes(16).toString('hex');
const canSee = (rec, dev) => !!(rec && dev && (rec.ownerDev === dev || (Array.isArray(rec.reporterDevs) && rec.reporterDevs.includes(dev))));
const PRIV_FIELDS = ['abuseFlag', 'ownerDev', 'reporterDevs'];
function civView(rec) { const o = Object.assign({}, rec); for (const f of PRIV_FIELDS) delete o[f]; return o; }
function incidentKeys() { return Object.keys(store).filter(k => /^lcr:[^:]+:incidents$/.test(k)); }
function findIncident(id) { for (const k of incidentKeys()) { const m = store[k].value; if (isObj(m) && m[id]) return { key: k, sid: /^lcr:([^:]+):/.exec(k)[1], rec: m[id], map: m }; } return null; }
// may this civilian device open evidence / chat / signalling for that incident? Unknown incidents are allowed only for writing (queued uploads can arrive before the alert does)
function civMayUse(ses, incId, forWrite) {
  if (!ses || ses.role !== 'civilian') return true;
  const f = findIncident(incId);
  if (!f) return !!forWrite;
  return canSee(f.rec, ses.dev);
}
// officers, fire and ambulance crews: evidence, chat and signalling only for incidents of their own control room (any other station's is refused)
function staffMayUse(ses, incId, forWrite) {
  if (!ses || !['officer', 'fire', 'ambulance'].includes(ses.role)) return true;
  const f = findIncident(incId);
  if (f) return f.sid === ses.lcr;
  for (const k of Object.keys(store)) { const m = /^(?:fire|ambulance):([^:]+):incidents$/.exec(k); if (m && m[1] === ses.lcr && isObj(store[k].value) && store[k].value[incId]) return true; }
  return !!forWrite;   // unknown incident: queued uploads may arrive before the record does
}
const incIdOfKey = (key) => { const m = /^(?:chat|evidence|archive|rtc):([^:]+)/.exec(key); return m ? m[1] : null; };

/* ── Field-level checks on what a write may change ──
 * The server compares the old and new value of a record and refuses changes the caller's role may not make.
 * It can also stamp facts the caller must not choose (who issued an order, whether a civilian's phone is verified). */

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
/* ── Outside trusted timestamp (RFC 3161), optional ──
 * GEAMS_TSA_URL  = address of a timestamp authority. When set, each sealed file's fingerprint is also sent there
 * and the signed reply is stored. GEAMS_TSA_CA = the authority's certificate file; with it (and openssl installed)
 * the server verifies the reply itself. Without it the reply is stored for anyone to check with openssl. */
const TSA_URL = process.env.GEAMS_TSA_URL || '', TSA_CA = process.env.GEAMS_TSA_CA || '';
const dlen = (n) => n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]);
const der = (tag, ...parts) => { const b = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), dlen(b.length), b]); };
function tlv(buf, off) { const tag = buf[off]; let l = buf[off + 1], p = off + 2; if (l & 0x80) { const n = l & 0x7f; l = 0; for (let i = 0; i < n; i++) l = l * 256 + buf[p++]; } return { tag, start: p, end: p + l }; }
function tsQuery(hashHex) {
  const nonce = crypto.randomBytes(8); nonce[0] = 1 + (nonce[0] % 126);
  const imprint = der(0x30, der(0x30, Buffer.from('0609608648016503040201', 'hex'), Buffer.from('0500', 'hex')), der(0x04, Buffer.from(hashHex, 'hex')));
  return der(0x30, Buffer.from('020101', 'hex'), imprint, der(0x02, nonce), Buffer.from('0101ff', 'hex'));
}
function tsStatus(reply) { try { const a = tlv(reply, 0), b = tlv(reply, a.start), c = tlv(reply, b.start); return reply[c.start]; } catch (e) { return -1; } }
const readJson = (fp) => { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { return null; } };
const tsTimers = new Map();
function scheduleTimestamp(fp) {
  if (!TSA_URL) return;
  clearTimeout(tsTimers.get(fp));
  tsTimers.set(fp, setTimeout(() => { tsTimers.delete(fp); timestampSeal(fp).catch(() => {}); }, 4000));
}
async function timestampSeal(fp) {
  const seal = readSeal(fp); if (!seal) return false;
  const old = readJson(fp + '.tsa'); if (old && old.sha256 === seal.sha256) return true;
  const tsq = tsQuery(seal.sha256), ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(TSA_URL, { method: 'POST', headers: { 'Content-Type': 'application/timestamp-query' }, body: tsq, signal: ctl.signal });
    const reply = Buffer.from(await r.arrayBuffer());
    if (!r.ok || ![0, 1].includes(tsStatus(reply))) return false;
    mirror(fp + '.tsa'); fs.writeFileSync(fp + '.tsa', JSON.stringify({ sha256: seal.sha256, at: Date.now(), tsa: new URL(TSA_URL).host, tsq: tsq.toString('base64'), tsr: reply.toString('base64') }));
    custodyAdd(fp, { t: Date.now(), ev: 'timestamped', role: 'server', user: new URL(TSA_URL).host, sha256: seal.sha256 });
    return true;
  } catch (e) { return false; } finally { clearTimeout(t); }
}
function opensslTs(args) { return new Promise((resolve) => require('child_process').execFile('openssl', args, { timeout: 15000 }, (err, out, errout) => resolve({ ok: !err, out: String(out || '') + String(errout || '') }))); }
async function checkTimestamp(fp, seal) {
  if (!TSA_URL) return { state: 'off' };
  const ts = readJson(fp + '.tsa');
  if (!ts) return { state: 'pending', message: 'Waiting for the outside timestamp' };
  if (!seal || ts.sha256 !== seal.sha256) return { state: 'stale', tsa: ts.tsa, at: ts.at, message: 'The file grew after its last outside timestamp; a new one is on the way' };
  if (!TSA_CA) return { state: 'stored', tsa: ts.tsa, at: ts.at, message: 'Outside timestamp stored (this server is not set up to check it; anyone can with openssl)' };
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'geams-ts-')), a = path.join(dir, 'r.tsr'), q = path.join(dir, 'q.tsq');
  try {
    fs.writeFileSync(a, Buffer.from(ts.tsr, 'base64')); fs.writeFileSync(q, Buffer.from(ts.tsq, 'base64'));
    const v = await opensslTs(['ts', '-verify', '-in', a, '-queryfile', q, '-CAfile', TSA_CA]);
    if (!v.ok || !/Verification: OK/.test(v.out)) return { state: 'invalid', tsa: ts.tsa, at: ts.at, message: 'The outside timestamp does not verify' };
    const txt = await opensslTs(['ts', '-reply', '-in', a, '-text']); const m = /Time stamp: (.+)/.exec(txt.out);
    return { state: 'verified', tsa: ts.tsa, at: m ? new Date(m[1].trim()).getTime() || ts.at : ts.at, message: 'Independently timestamped and verified' };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
}

/* ── Web Push (RFC 8030 / 8291 / 8292), no outside libraries ──
 * Lets HQ alerts reach phones whose GEAMS app is closed. Each device registers a push subscription (kept private on the
 * server); when HQ publishes an alert the server encrypts it for each matching device and posts it to that device's push service. */
const b64u = (b) => Buffer.from(b).toString('base64url');
const fromB64u = (t) => Buffer.from(String(t), 'base64url');
const PUSH_SUBJECT = process.env.GEAMS_VAPID_SUBJECT || 'mailto:admin@geams.invalid';
const VAPID_FILE = path.join(path.dirname(DATA_FILE), 'geams-vapid.json');
function loadVapid() {
  let jwk = null;
  if (process.env.GEAMS_VAPID_PRIVATE && process.env.GEAMS_VAPID_PUBLIC) { const pub = fromB64u(process.env.GEAMS_VAPID_PUBLIC); jwk = { kty: 'EC', crv: 'P-256', d: process.env.GEAMS_VAPID_PRIVATE, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }; }
  if (!jwk) jwk = readJson(VAPID_FILE);
  if (!jwk) { jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' }); try { fs.writeFileSync(VAPID_FILE, JSON.stringify(jwk), { mode: 0o600 }); mirror(VAPID_FILE); } catch (e) {} }
  return { privKey: crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y }, format: 'jwk' }), pub: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])) };
}
const VAPID = loadVapid();
function vapidHeader(endpoint) {
  const h = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })), c = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: PUSH_SUBJECT }));
  const sig = crypto.sign('sha256', Buffer.from(h + '.' + c), { key: VAPID.privKey, dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + h + '.' + c + '.' + b64u(sig) + ', k=' + VAPID.pub;
}
function pushEncrypt(payload, uaPubB64, authB64, opt) {
  opt = opt || {}; const ua = fromB64u(uaPubB64), auth = fromB64u(authB64), hm = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const ecdh = crypto.createECDH('prime256v1'); if (opt.asPriv) ecdh.setPrivateKey(opt.asPriv); else ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(), secret = ecdh.computeSecret(ua);
  const ikm = hm(hm(auth, secret), Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPub, Buffer.from([1])]));
  const salt = opt.salt || crypto.randomBytes(16), prk = hm(salt, ikm);
  const cek = hm(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hm(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const hdr = Buffer.alloc(21); salt.copy(hdr, 0); hdr.writeUInt32BE(4096, 16); hdr[20] = 65;
  return Buffer.concat([hdr, asPub, ct]);
}
const PUSH_KEY = 'registry:pushSubs';
const pushStats = { sent: 0, failed: 0, removed: 0 };
async function pushOne(sub, payload, urgency, ttl) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(sub.endpoint, { method: 'POST', signal: ctl.signal, body: pushEncrypt(payload, sub.p256dh, sub.auth), headers: { Authorization: vapidHeader(sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttl), Urgency: urgency } });
    if (r.status === 404 || r.status === 410) return 'gone';
    return r.ok ? 'ok' : 'fail';
  } catch (e) { return 'fail'; } finally { clearTimeout(t); }
}
async function pushAlert(a) {
  const subs = kvGet(PUSH_KEY, {}), ids = Object.keys(subs); if (!ids.length) return;
  const base = { id: a.id, title: a.title, message: String(a.message).slice(0, 600), severity: a.severity, areaLabel: a.areaLabel || '' };
  const ttl = Math.max(60, Math.min(86400, Math.floor((a.expiresAt - Date.now()) / 1000))), urgency = a.severity === 'critical' ? 'high' : a.severity === 'warning' ? 'normal' : 'low';
  const want = ids.filter(id => { const x = subs[id]; if (x.audience === 'civilians' && !a.audience.civilians) return false; if (x.audience === 'officers' && !a.audience.officers) return false; return !a.stations.length || !x.stationId || a.stations.includes(x.stationId); });
  const gone = [];
  for (let i = 0; i < want.length; i += 20) {
    const res = await Promise.all(want.slice(i, i + 20).map(id => pushOne(subs[id], JSON.stringify(Object.assign({ url: subs[id].url || '/' }, base)), urgency, ttl).then(r => ({ id, r }))));
    res.forEach(({ id, r }) => { if (r === 'ok') pushStats.sent++; else if (r === 'gone') gone.push(id); else pushStats.failed++; });
  }
  if (gone.length) { const cur = Object.assign({}, kvGet(PUSH_KEY, {})); gone.forEach(id => delete cur[id]); pushStats.removed += gone.length; kvSet(PUSH_KEY, cur); }
}
function pushNewAlerts(prevV, nextV) {
  const prev = isObj(prevV) ? prevV : {};
  for (const [id, a] of Object.entries(isObj(nextV) ? nextV : {})) if (!prev[id] && a.status === 'active' && a.expiresAt > Date.now()) pushAlert(a).catch(() => {});
}

/* ── Text messages (SMS) ──
 * smsSend: outgoing through the configured gateway. Inbound: the gateway forwards each text to /api/sms/inbound. */
async function smsSend(phone, msg) {
  if (!process.env.GEAMS_SMS_URL) throw new Error('SMS is not set up on this server');
  const headers = { 'Content-Type': 'application/json' }; if (process.env.GEAMS_SMS_API_KEY) headers[process.env.GEAMS_SMS_API_KEY_HEADER || 'Authorization'] = process.env.GEAMS_SMS_API_KEY;
  const post = String(process.env.GEAMS_SMS_METHOD || 'POST').toUpperCase() === 'POST';
  const vals = { to: phone, to_local: '0' + phone.slice(4), message: msg };
  const fill = (t, enc) => String(t).replace(/\{(to|to_local|message)\}/g, (_, k) => enc(vals[k]));
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(fill(process.env.GEAMS_SMS_URL, encodeURIComponent), post
      ? { method: 'POST', headers, body: fill(process.env.GEAMS_SMS_BODY || '{"to":"{to}","message":"{message}"}', (v) => JSON.stringify(v).slice(1, -1)), signal: ctl.signal }
      : { headers, signal: ctl.signal });
    if (!r.ok) throw new Error('The SMS service answered ' + r.status);
  } catch (e) { if (e.name === 'AbortError') throw new Error('The SMS service timed out'); throw e; } finally { clearTimeout(t); }
}
const hav = (a, b, c, d) => { const R = 6371000, r = Math.PI / 180, x = (c - a) * r, y = (d - b) * r, q = Math.sin(x / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(y / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(q)); };
function nearestStationTo(lat, lng) {
  const reg = kvGet('registry:stations', {}), loc = kvGet('registry:stationLocations', {}); let best = null;
  for (const [id, r] of Object.entries(isObj(reg) ? reg : {})) {
    if (!r || r.disabled) continue; const l = (isObj(loc) && loc[id]) || r;
    if (typeof l.lat !== 'number' || typeof l.lng !== 'number') continue;
    const d = hav(lat, lng, l.lat, l.lng); if (!best || d < best.d) best = { id, name: r.name || id, d };
  }
  return best && best.d < 150000 ? best : null;
}


/* ── Response-time stamps ──
 * The SERVER writes the time each step of an incident happened (received, assigned, en route, arrived, closed, resolved).
 * A page cannot set or change them, so response-time figures cannot be made up by anyone. */
function stampSrv(old, rec, now) {
  const sv = Object.assign({}, old && isObj(old.srv) ? old.srv : {});
  if (!old && !sv.received) sv.received = now;
  const os = rec.officerStatus;
  if (os === 'assigned' && !sv.assigned) sv.assigned = now;
  if (os === 'en_route' && !sv.enRoute) sv.enRoute = now;
  if (os === 'arrived' && !sv.arrived) sv.arrived = now;
  if (os === 'case_closed' && !sv.closed) sv.closed = now;
  if (rec.status === 'resolved' && !sv.resolved) sv.resolved = now;
  if (rec.status === 'cancelled' && !sv.cancelled) sv.cancelled = now;
  rec.srv = sv;
}
const median = (a) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const pctl = (a, p) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.max(0, Math.ceil(p * b.length) - 1)]; };
const mkStats = (n, as, ar, open) => ({ n, measuredAssign: as.length, measuredArrive: ar.length, medianAssign: median(as), p90Assign: pctl(as, 0.9), medianArrive: median(ar), p90Arrive: pctl(ar, 0.9), noArrival: open });
function stationMeta(sid) { const r = (kvGet('registry:stations', {}) || {})[sid] || {}; return { id: sid, name: r.name || sid, region: r.region || '', town: r.town || '' }; }
function responseAnalytics(q, ses) {
  const days = Math.min(Math.max(parseInt(q.days, 10) || 30, 1), 400), now = Date.now(), from = now - days * 86400000, prevFrom = from - days * 86400000;
  const month = q.bucket === 'month', excl = { imported: 0, legacy: 0, cancelled: 0, invalid: 0, noArrival: 0 };
  const bucketOf = (t) => { const d = new Date(t); if (month) return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); const day = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day); };
  const acc = {}, nat = { cur: { n: 0, a: [], r: [], open: 0 }, prev: { n: 0, a: [], r: [], open: 0 }, buckets: new Map() };
  const mk = () => ({ cur: { n: 0, a: [], r: [], open: 0 }, prev: { n: 0, a: [], r: [], open: 0 }, buckets: new Map() });
  for (const key of Object.keys(store)) {
    const m = /^lcr:([^:]+):incidents$/.exec(key); if (!m) continue; const sid = m[1];
    if (ses.role === 'lcr' && ses.sid !== sid) continue;
    const mapv = store[key].value; if (!isObj(mapv)) continue;
    for (const rec of Object.values(mapv)) {
      if (!isObj(rec)) continue; const sv = isObj(rec.srv) ? rec.srv : {};
      if (rec.drill) { excl.drill = (excl.drill || 0) + 1; continue; }
      if (rec.source === 'import' || sv.imported) { excl.imported++; continue; }
      if (!sv.received) { excl.legacy++; continue; }
      if (sv.received < prevFrom) continue;
      if (rec.status === 'cancelled' || sv.cancelled) { if (sv.received >= from) excl.cancelled++; continue; }
      const a = sv.assigned ? (sv.assigned - sv.received) / 1000 : null, r = sv.arrived ? (sv.arrived - sv.received) / 1000 : null;
      if ((a != null && (a < 0 || a > 86400)) || (r != null && (r < 0 || r > 86400))) { if (sv.received >= from) excl.invalid++; continue; }
      const per = sv.received >= from ? 'cur' : 'prev', S = acc[sid] || (acc[sid] = mk());
      for (const T of [S, nat]) { const c = T[per]; c.n++; if (a != null) c.a.push(a); if (r != null) c.r.push(r); else c.open++;
        if (per === 'cur') { const bk = bucketOf(sv.received), b = T.buckets.get(bk) || { n: 0, r: [] }; b.n++; if (r != null) b.r.push(r); T.buckets.set(bk, b); } }
      if (per === 'cur' && r == null) excl.noArrival++;
    }
  }
  const trend = (T) => Array.from(T.buckets.entries()).sort((x, y) => x[0] - y[0]).map(([t, b]) => ({ start: new Date(t).toISOString().slice(0, 10), n: b.n, measured: b.r.length, medianArrive: median(b.r) }));
  const fin = (T) => ({ current: mkStats(T.cur.n, T.cur.a, T.cur.r, T.cur.open), previous: mkStats(T.prev.n, T.prev.a, T.prev.r, T.prev.open), trend: trend(T) });
  const districts = Object.keys(acc).map(sid => Object.assign(stationMeta(sid), fin(acc[sid]))).sort((x, y) => (x.current.medianArrive == null) - (y.current.medianArrive == null) || (y.current.medianArrive || 0) - (x.current.medianArrive || 0));
  const regions = {}; for (const d of districts) { const R = d.region || 'Unassigned'; if (!regions[R]) regions[R] = mk(); for (const per of ['cur', 'prev']) { const src = acc[d.id][per], dst = regions[R][per]; dst.n += src.n; dst.a.push(...src.a); dst.r.push(...src.r); dst.open += src.open; } }
  return { generatedAt: new Date(now).toISOString(), windowDays: days, bucket: month ? 'month' : 'week', from: new Date(from).toISOString(), national: fin(nat), regions: Object.entries(regions).map(([name, T]) => ({ name, current: mkStats(T.cur.n, T.cur.a, T.cur.r, T.cur.open), previous: mkStats(T.prev.n, T.prev.a, T.prev.r, T.prev.open) })), districts, excluded: excl,
    definitions: { assign: 'Seconds from the server receiving the alert to a control room assigning an officer', arrive: 'Seconds from the server receiving the alert to the officer marking arrival on scene', district: 'A district is the area of one control room', measured: 'Cancelled alerts, imported records, records from before the server stamped times, and times over 24 hours are left out and counted in "excluded". Alerts still waiting for an arrival are counted as noArrival and are not in the arrival figures' } };
}

/* ── Open data exchange: export and import in common emergency-data formats ──
 * Export: JSON, CSV, GeoJSON, CAP 1.2 (alerts and incidents) and EDXL-DE 1.0 envelopes. Import: the same.
 * Honest limit: output follows the published element lists and value lists but has not been checked against the official schema files. */
const xe = (t) => String(t == null ? '' : t).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const xd = (t) => String(t).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => c.replace(/&/g, '\u0001')).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(+n, 0x10ffff))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff))).replace(/&amp;/g, '&').replace(/\u0001/g, '&');
const CAP_NS = 'urn:oasis:names:tc:emergency:cap:1.2', DE_NS = 'urn:oasis:names:tc:emergency:EDXL:DE:1.0';
const CAP_SENDER = () => process.env.GEAMS_CAP_SENDER || 'geams@localhost';
const capCategory = (t) => /fire|burn|smoke/i.test(t) ? 'Fire' : /medic|ambulance|injur|health/i.test(t) ? 'Health' : /accident|traffic|collision|crash/i.test(t) ? 'Transport' : /flood|storm|disaster|weather/i.test(t) ? 'Met' : /crime|robbery|assault|theft|burglar|riot|violence|security|kidnap/i.test(t) ? 'Security' : 'Other';
const SEV = { critical: 'Extreme', high: 'Severe', medium: 'Moderate', low: 'Minor' }, SEV_BACK = { Extreme: 'critical', Severe: 'high', Moderate: 'medium', Minor: 'low', Unknown: 'high' };
const isoNoMs = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, '+00:00');
function capIncident(n, personal) {
  const st = n.station || {}, area = n.location || 'Reported position';
  return '<?xml version="1.0" encoding="UTF-8"?>\n<alert xmlns="' + CAP_NS + '">\n  <identifier>GEAMS-' + xe(n.id) + '</identifier>\n  <sender>' + xe(CAP_SENDER()) + '</sender>\n  <sent>' + isoNoMs(n.receivedAt || n.createdAt || Date.now()) + '</sent>\n  <status>Actual</status>\n  <msgType>Alert</msgType>\n  <source>' + xe('GEAMS ' + (st.name || '')) + '</source>\n  <scope>Restricted</scope>\n  <restriction>Emergency services only</restriction>\n  <info>\n    <language>en-GH</language>\n    <category>' + capCategory(n.type) + '</category>\n    <event>' + xe(n.type || 'Emergency') + '</event>\n    <urgency>Immediate</urgency>\n    <severity>' + (SEV[n.priority] || 'Severe') + '</severity>\n    <certainty>Observed</certainty>\n    <headline>' + xe((n.type || 'Emergency') + ' — ' + area) + '</headline>\n    <description>' + xe(n.notes || (n.type || 'Emergency') + ' reported at ' + area) + '</description>\n' +
    (personal && n.civilian && (n.civilian.name || n.civilian.phone) ? '    <contact>' + xe([n.civilian.name, n.civilian.phone].filter(Boolean).join(' ')) + '</contact>\n' : '') +
    '    <parameter><valueName>GEAMS:incidentId</valueName><value>' + xe(n.id) + '</value></parameter>\n    <parameter><valueName>GEAMS:status</valueName><value>' + xe(n.status || '') + '</value></parameter>\n    <parameter><valueName>GEAMS:station</valueName><value>' + xe(st.id || '') + '</value></parameter>\n' +
    '    <area>\n      <areaDesc>' + xe(area) + '</areaDesc>\n' + (typeof n.lat === 'number' && typeof n.lng === 'number' ? '      <circle>' + n.lat + ',' + n.lng + ' 0</circle>\n' : '') + '    </area>\n  </info>\n</alert>\n';
}
function capPublicAlert(a) {
  const sev = { critical: ['Extreme', 'Immediate'], warning: ['Moderate', 'Expected'], info: ['Minor', 'Future'] }[a.severity] || ['Unknown', 'Unknown'];
  return '<?xml version="1.0" encoding="UTF-8"?>\n<alert xmlns="' + CAP_NS + '">\n  <identifier>GEAMS-ALERT-' + xe(a.id) + '</identifier>\n  <sender>' + xe(CAP_SENDER()) + '</sender>\n  <sent>' + isoNoMs(a.createdAt) + '</sent>\n  <status>Actual</status>\n  <msgType>' + (a.status === 'lifted' ? 'Cancel' : 'Alert') + '</msgType>\n  <scope>Public</scope>\n  <info>\n    <language>en-GH</language>\n    <category>Safety</category>\n    <event>' + xe(a.title) + '</event>\n    <urgency>' + sev[1] + '</urgency>\n    <severity>' + sev[0] + '</severity>\n    <certainty>Observed</certainty>\n    <expires>' + isoNoMs(a.expiresAt) + '</expires>\n    <senderName>' + xe(a.by || 'GEAMS HQ') + '</senderName>\n    <headline>' + xe(a.title) + '</headline>\n    <description>' + xe(a.message) + '</description>\n    <area>\n      <areaDesc>' + xe(a.areaLabel || 'All regions') + '</areaDesc>\n' + (a.stations || []).map(x => '      <geocode><valueName>GEAMS:station</valueName><value>' + xe(x) + '</value></geocode>\n').join('') + '    </area>\n  </info>\n</alert>\n';
}
function edxlWrap(capDocs, desc) {
  const inner = capDocs.map(d => '  <contentObject>\n    <contentDescription>' + xe(desc) + '</contentDescription>\n    <xmlContent>\n      <embeddedXMLContent>\n' + d.replace(/^<\?xml[^>]*\?>\n?/, '').replace(/^/gm, '        ') + '      </embeddedXMLContent>\n    </xmlContent>\n  </contentObject>\n').join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<EDXLDistribution xmlns="' + DE_NS + '">\n  <distributionID>GEAMS-' + Date.now().toString(36) + '</distributionID>\n  <senderID>' + xe(CAP_SENDER()) + '</senderID>\n  <dateTimeSent>' + isoNoMs(Date.now()) + '</dateTimeSent>\n  <distributionStatus>Actual</distributionStatus>\n  <distributionType>Report</distributionType>\n  <combinedConfidentiality>UNCLASSIFIED</combinedConfidentiality>\n  <language>en-GH</language>\n' + inner + '</EDXLDistribution>\n';
}
const csvCell = (v) => { let t = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"' && cur === '') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(x => x !== '')) rows.push(row); row = []; } else cur += c; }
  row.push(cur); if (row.some(x => x !== '')) rows.push(row); return rows;
}
function collectIncidents(ses, q) {
  const out = [], fromT = q.from ? Date.parse(q.from) : 0, toT = q.to ? Date.parse(q.to) : Infinity;
  for (const key of Object.keys(store)) {
    const m = /^lcr:([^:]+):incidents$/.exec(key); if (!m) continue; const sid = m[1];
    if (ses.role === 'lcr' && ses.sid !== sid) continue; if (q.station && q.station !== sid) continue;
    const mapv = store[key].value; if (!isObj(mapv)) continue; const st = stationMeta(sid);
    for (const rec of Object.values(mapv)) {
      if (!isObj(rec)) continue; const sv = isObj(rec.srv) ? rec.srv : {}, t = sv.received || Date.parse(rec.createdAt) || 0;
      if (t < fromT || t > toT) continue;
      if (rec.drill && q.drill !== '1') continue;
      const iso = (ms) => ms ? new Date(ms).toISOString() : null;
      out.push({ id: rec.id, type: rec.type || null, priority: rec.priority || null, status: rec.status || null, location: rec.location || null, lat: typeof rec.lat === 'number' ? rec.lat : null, lng: typeof rec.lng === 'number' ? rec.lng : null, createdAt: rec.createdAt || null, receivedAt: iso(sv.received), assignedAt: iso(sv.assigned), enRouteAt: iso(sv.enRoute), arrivedAt: iso(sv.arrived), closedAt: iso(sv.closed), resolvedAt: iso(sv.resolved) || rec.resolvedAt || null, station: { id: sid, name: st.name, region: st.region }, source: rec.source || null, officer: { name: rec.officerName || null, badge: rec.officerBadge || null }, civilian: { name: rec.civilianName || null, phone: rec.civilianPhone || null, verified: !!rec.civilianVerified }, notes: rec.notes || '' });
    }
  }
  return out.sort((a, b) => String(a.receivedAt || a.createdAt).localeCompare(String(b.receivedAt || b.createdAt)));
}
function evidenceOf(inc) { try { const dir = path.join(BLOB_DIR, safeSeg(inc)); return fs.readdirSync(dir).filter(n => !/\.(type|seal|log|tsa)$/.test(n)).map(n => { const sl = readSeal(path.join(dir, n)); return { name: n, size: fs.statSync(path.join(dir, n)).size, sha256: sl ? sl.sha256 : null, sealedAt: sl ? new Date(sl.sealedAt).toISOString() : null }; }); } catch (e) { return []; } }
const CSV_COLS = ['id', 'type', 'priority', 'status', 'location', 'lat', 'lng', 'createdAt', 'receivedAt', 'assignedAt', 'enRouteAt', 'arrivedAt', 'closedAt', 'resolvedAt', 'stationId', 'stationName', 'region', 'source', 'officerName', 'officerBadge', 'notes'];
function exportIncidents(items, format, personal, evidence) {
  const shape = (n) => { const o = Object.assign({}, n); if (!personal) delete o.civilian; if (evidence) o.evidence = evidenceOf(n.id); return o; };
  if (format === 'csv') { const cols = CSV_COLS.concat(personal ? ['civilianName', 'civilianPhone', 'civilianVerified'] : []); return { type: 'text/csv; charset=utf-8', ext: 'csv', body: '﻿' + cols.join(',') + '\r\n' + items.map(n => cols.map(c => csvCell(({ stationId: n.station.id, stationName: n.station.name, region: n.station.region, officerName: n.officer.name, officerBadge: n.officer.badge, civilianName: n.civilian.name, civilianPhone: n.civilian.phone, civilianVerified: n.civilian.verified })[c] !== undefined ? ({ stationId: n.station.id, stationName: n.station.name, region: n.station.region, officerName: n.officer.name, officerBadge: n.officer.badge, civilianName: n.civilian.name, civilianPhone: n.civilian.phone, civilianVerified: n.civilian.verified })[c] : n[c])).join(',')).join('\r\n') + '\r\n' }; }
  if (format === 'geojson') return { type: 'application/geo+json', ext: 'geojson', body: JSON.stringify({ type: 'FeatureCollection', name: 'geams-incidents', features: items.map(n => ({ type: 'Feature', id: n.id, geometry: n.lat != null && n.lng != null ? { type: 'Point', coordinates: [n.lng, n.lat] } : null, properties: (() => { const o = shape(n); delete o.lat; delete o.lng; return o; })() })) }, null, 1) };
  if (format === 'cap') return { type: 'application/cap+xml', ext: 'xml', body: items.length === 1 ? capIncident(items[0], personal) : '<?xml version="1.0" encoding="UTF-8"?>\n<!-- one CAP 1.2 alert per incident, concatenated; split on the alert elements -->\n<alerts>\n' + items.map(n => capIncident(n, personal).replace(/^<\?xml[^>]*\?>\n/, '')).join('') + '</alerts>\n' };
  if (format === 'edxl') return { type: 'application/xml', ext: 'xml', body: edxlWrap(items.map(n => capIncident(n, personal)), 'GEAMS incident report') };
  return { type: 'application/json', ext: 'json', body: JSON.stringify({ schema: 'geams.incidents.v1', exportedAt: new Date().toISOString(), count: items.length, incidents: items.map(shape) }, null, 1) };
}
const xmlTag = (xml, tag) => { const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i').exec(xml); return m ? xd(m[1].trim()) : null; };
function parseImport(body, format) {
  const text = String(body).replace(/^﻿/, ''), trim = text.trimStart();
  if (!format) format = trim[0] === '<' ? (/<EDXLDistribution/i.test(trim) ? 'edxl' : 'cap') : trim[0] === '{' || trim[0] === '[' ? 'json' : 'csv';
  const items = [], errors = [];
  if (format === 'cap' || format === 'edxl') {
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) return { error: 'XML with DOCTYPE or ENTITY declarations is refused' };
    const x = text.replace(/<(\/?)[A-Za-z0-9_-]+:/g, '<$1'), blocks = x.match(/<alert(?:\s[^>]*)?>[\s\S]*?<\/alert>/gi) || [];
    if (!blocks.length) return { error: 'No CAP alert found in the file' };
    blocks.forEach((b, i) => {
      const ident = xmlTag(b, 'identifier'), sent = xmlTag(b, 'sent'), event = xmlTag(b, 'event'), desc = xmlTag(b, 'description') || xmlTag(b, 'headline'), sev = xmlTag(b, 'severity'), area = xmlTag(b, 'areaDesc');
      const circle = /<circle>\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i.exec(b); let lat = circle ? +circle[1] : null, lng = circle ? +circle[2] : null;
      if (lat == null) { const poly = xmlTag(b, 'polygon'); if (poly) { const pts = poly.trim().split(/\s+/).map(p => p.split(',').map(Number)).filter(p => p.length === 2 && p.every(Number.isFinite)); if (pts.length) { lat = pts.reduce((a, p) => a + p[0], 0) / pts.length; lng = pts.reduce((a, p) => a + p[1], 0) / pts.length; } } }
      const idParam = /<valueName>GEAMS:incidentId<\/valueName>\s*<value>([^<]*)<\/value>/i.exec(b), stParam = /<valueName>GEAMS:status<\/valueName>\s*<value>([^<]*)<\/value>/i.exec(b);
      const contact = xmlTag(b, 'contact');
      items.push({ idx: i + 1, id: idParam ? xd(idParam[1]) : (ident || '').replace(/^GEAMS-/, ''), ident, type: event, priority: SEV_BACK[sev] || 'high', status: stParam ? xd(stParam[1]) : 'new', location: area, lat, lng, createdAt: sent, notes: desc, civilianName: contact || null });
    });
  } else if (format === 'geojson' || format === 'json') {
    let j; try { j = JSON.parse(text); } catch (e) { return { error: 'Not valid JSON: ' + e.message }; }
    const list = j.type === 'FeatureCollection' ? j.features.map(f => Object.assign({}, f.properties || {}, f.geometry && f.geometry.type === 'Point' ? { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] } : {}, { id: (f.properties && f.properties.id) || f.id })) : Array.isArray(j) ? j : Array.isArray(j.incidents) ? j.incidents : null;
    if (!list) return { error: 'Expected a GeoJSON FeatureCollection, a list, or {incidents:[...]}' };
    list.forEach((o, i) => { if (!isObj(o)) { errors.push({ index: i + 1, error: 'Not an object' }); return; } items.push({ idx: i + 1, id: o.id, type: o.type, priority: o.priority, status: o.status, location: o.location, lat: o.lat, lng: o.lng, createdAt: o.createdAt || o.receivedAt, notes: o.notes, civilianName: o.civilian ? o.civilian.name : o.civilianName, civilianPhone: o.civilian ? o.civilian.phone : o.civilianPhone, resolvedAt: o.resolvedAt }); });
  } else {
    const rows = parseCsv(text); if (rows.length < 2) return { error: 'The CSV needs a header row and at least one data row' };
    const head = rows[0].map(h => h.trim()), ix = (n) => head.findIndex(h => h.toLowerCase() === n.toLowerCase()), cell = (r, n) => { const k = ix(n); if (k < 0) return null; let v = r[k]; if (v == null || v === '') return null; if (/^'[=+\-@\t\r]/.test(v)) v = v.slice(1); return v; };
    rows.slice(1).forEach((r, i) => items.push({ idx: i + 2, id: cell(r, 'id'), type: cell(r, 'type'), priority: cell(r, 'priority'), status: cell(r, 'status'), location: cell(r, 'location'), lat: cell(r, 'lat') == null ? null : parseFloat(cell(r, 'lat')), lng: cell(r, 'lng') == null ? null : parseFloat(cell(r, 'lng')), createdAt: cell(r, 'createdAt') || cell(r, 'receivedAt'), notes: cell(r, 'notes'), civilianName: cell(r, 'civilianName'), civilianPhone: cell(r, 'civilianPhone'), resolvedAt: cell(r, 'resolvedAt'), stationId: cell(r, 'stationId') }));
  }
  return { format, items, errors };
}

const MAX_VALUE = 3 * 1024 * 1024;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CIV_FIELDS = ['civilianLat', 'civilianLng', 'trackLocation', 'civilianTracking', 'additionalReporters', 'civilianCancelled', 'cancelReason', 'cancelledAt', 'resolvedAt', 'notes', 'evidencePhoto', 'lastCivilianUpdate'];
const OP_TYPES = ['cordon', 'curfew', 'wanted', 'command', 'mobilise', 'caselink', 'emergency', 'broadcast'];
const inGhana = (lat, lng) => typeof lat === 'number' && typeof lng === 'number' && lat > 3.5 && lat < 12 && lng > -4 && lng < 2;
function validateWrite(key, prevV, nextV, ses, m) {
  let size = 0; try { size = JSON.stringify(nextV === undefined ? null : nextV).length; } catch (e) { return { error: 'Value is not valid JSON' }; }
  if (size > MAX_VALUE) return { error: 'Value is too large' };
  const role = ses && ses.role;
  // public alerts: only HQ publishes; everyone can read; devices add their own "seen" mark
  if (key === 'public:alerts') {
    if (!isObj(nextV)) return { error: 'Alerts must be a map' };
    const prev = isObj(prevV) ? prevV : {}, SEV = ['info', 'warning', 'critical'];
    const ids = Object.keys(nextV); if (ids.length > 300) return { error: 'Too many alerts stored; remove old ones first' };
    for (const [id, a] of Object.entries(nextV)) {
      if (same(prev[id], a)) continue;
      if (!isObj(a) || a.id !== id) return { error: 'Alert ' + id + ' is malformed' };
      if (!a.title || String(a.title).length > 140 || !a.message || String(a.message).length > 800) return { error: 'Alert needs a title (140 chars) and message (800 chars)' };
      if (!SEV.includes(a.severity) || !['active', 'lifted'].includes(a.status)) return { error: 'Alert severity or status is not valid' };
      if (!isObj(a.audience) || typeof a.audience.civilians !== 'boolean' || typeof a.audience.officers !== 'boolean') return { error: 'Alert needs an audience' };
      if (!Array.isArray(a.stations) || a.stations.length > 400 || a.stations.some(x => typeof x !== 'string' || x.length > 80)) return { error: 'Alert stations are not valid' };
      if (typeof a.createdAt !== 'number' || typeof a.expiresAt !== 'number' || a.expiresAt <= a.createdAt || a.expiresAt - a.createdAt > 7 * 86400000) return { error: 'Alert times are not valid (max 7 days)' };
      if (!prev[id]) a.by = ses.user; else a.by = prev[id].by;
    }
    return {};
  }
  if (/^public:ack:[^:]+$/.test(key)) {
    if (!isObj(nextV)) return { error: 'Must be a map' };
    const prev = isObj(prevV) ? prevV : {};
    if (Object.keys(nextV).length > 50000) return { error: 'Too many marks' };
    for (const k of Object.keys(prev)) if (!same(prev[k], nextV[k])) return { error: 'Marks cannot be changed or removed' };
    for (const k of Object.keys(nextV)) { if (k in prev) continue; const e = nextV[k]; if (!isObj(e) || typeof e.t !== 'number' || k.length > 80) return { error: 'Malformed mark' }; nextV[k] = { t: Date.now(), role: ses.role }; }
    return {};
  }
  // intelligence reports of a control room: append-only, so a filed report can never be edited or removed
  if (/^lcr:[^:]+:intel$/.test(key)) {
    if (!Array.isArray(nextV) || nextV.length > 5000) return { error: 'Intelligence reports must be a list' };
    const prev = Array.isArray(prevV) ? prevV : [];
    if (nextV.length < prev.length || !same(prev, nextV.slice(0, prev.length))) return { error: 'Filed intelligence reports cannot be changed or removed' };
    for (const r of nextV.slice(prev.length)) if (!isObj(r) || !r.id || String(r.details || '').length > 5000) return { error: 'Malformed intelligence report' };
    return {};
  }
  // shift handover notes: written once and never edited; the incoming commander can mark one as read (once)
  if (/^lcr:[^:]+:handovers$/.test(key)) {
    if (!isObj(nextV) || Object.keys(nextV).length > 500) return { error: 'Handovers must be a map' };
    const prev = isObj(prevV) ? prevV : {}, now = Date.now(), cl = (v, n) => String(v === undefined || v === null ? '' : v).slice(0, n);
    for (const id of Object.keys(prev)) if (!(id in nextV)) return { error: 'A filed handover cannot be removed' };
    for (const [id, h] of Object.entries(nextV)) {
      const old = prev[id];
      if (old) {
        if (same(old, h)) continue;
        const { ackAt, ackBy, ...a } = isObj(h) ? h : {}, { ackAt: oa, ackBy: ob, ...b } = old;
        if (!same(a, b)) return { error: 'A filed handover cannot be edited' };
        if (oa) return { error: 'This handover was already marked as read' };
        h.ackAt = now; h.ackBy = whoOf(ses); continue;
      }
      if (!isObj(h) || h.id !== id || !/^HO-[A-Z0-9]{4,20}$/.test(id)) return { error: 'Handover is malformed' };
      if (h.ackAt || h.ackBy) return { error: 'A new handover cannot start as read' };
      if (cl(h.from, 90).length < 2 || cl(h.to, 90).length < 2) return { error: 'Handover needs the outgoing and incoming names' };
      if (String(h.notes || '').length > 3000) return { error: 'Notes are too long (3000 characters)' };
      if (h.open !== undefined && (!Array.isArray(h.open) || h.open.length > 80)) return { error: 'Open-incident list is not valid' };
      h.at = now; h.by = whoOf(ses); h.from = cl(h.from, 90); h.to = cl(h.to, 90); h.rank = cl(h.rank, 60); h.shift = cl(h.shift, 60); h.notes = cl(h.notes, 3000);
      h.open = (h.open || []).map(o => ({ ref: cl(o && o.ref, 40), type: cl(o && o.type, 40), status: cl(o && o.status, 30) }));
      const sn = isObj(h.snapshot) ? h.snapshot : {}; h.snapshot = {}; for (const k of ['active', 'dispatched', 'resolved', 'officers']) h.snapshot[k] = Number.isFinite(+sn[k]) ? Math.max(0, Math.min(99999, +sn[k] | 0)) : 0;
    }
    return {};
  }
  // crew roster of a control room: the commander plans it; a crew member may only change their own availability
  if (/^lcr:[^:]+:roster$/.test(key)) {
    if (!isObj(nextV) || Object.keys(nextV).length > 300) return { error: 'Roster must be a map (300 crew at most)' };
    const prev = isObj(prevV) ? prevV : {}, now = Date.now(), cl = (v, n) => String(v === undefined || v === null ? '' : v).slice(0, n), cmd = role === 'hq' || role === 'lcr';
    const SH = ['day', 'night', 'off'], AV = ['available', 'break', 'unavailable'], KD = ['officer', 'fire', 'ambulance'], mine = role + ':' + (ses && ses.badge);
    for (const id of Object.keys(prev)) if (!(id in nextV) && !cmd) return { error: 'Only the control room can remove crew from the roster' };
    for (const [id, r] of Object.entries(nextV)) {
      const old = prev[id]; if (old && same(old, r)) continue;
      if (!isObj(r) || r.id !== id || !/^(officer|fire|ambulance):[\w.\-]{1,40}$/.test(id)) return { error: 'Roster entry is malformed' };
      if (!cmd) {
        if (!old || id !== mine) return { error: 'You can only change your own availability' };
        const { avail, note, updatedAt, by, ...a } = r, { avail: _a, note: _n, updatedAt: _u, by: _b, ...b } = old;
        if (!same(a, b)) return { error: 'You can only change your own availability' };
      }
      if (cl(r.name, 80).length < 2) return { error: 'Roster entry needs a name' };
      if (!KD.includes(r.kind) || r.kind !== id.split(':')[0]) return { error: 'Roster entry has the wrong crew type' };
      if (!SH.includes(r.shift) || !AV.includes(r.avail)) return { error: 'Shift or availability is not valid' };
      r.name = cl(r.name, 80); r.badge = cl(r.badge, 40); r.note = cl(r.note, 120); r.updatedAt = now; r.by = whoOf(ses);
    }
    return {};
  }
  // forwarded fire / ambulance jobs: the server stamps when each step happened, so the HQ's response figures cannot be made up by a page
  if (/^(fire|ambulance):[^:]+:incidents$/.test(key)) {
    if (!isObj(nextV)) return { error: 'Records must be a map keyed by incident id' };
    const prev = isObj(prevV) ? prevV : {}, now = Date.now();
    for (const [id, rec] of Object.entries(nextV)) {
      if (!isObj(rec)) continue; const old = prev[id]; if (old && same(old, rec)) continue;
      const sv = Object.assign({}, old && isObj(old.srv) ? old.srv : {});
      if (!old && !sv.forwarded) sv.forwarded = now;
      if (rec.serviceStatus && !['new', 'reassigned'].includes(rec.serviceStatus) && !sv.accepted) sv.accepted = now;
      if (old && (old.unitLat !== rec.unitLat || old.unitLng !== rec.unitLng || old.unitAt !== rec.unitAt)) sv.posAt = now;   // when the crew's position last reached the server
      if (rec.serviceStatus === 'en_route' && !sv.departed) sv.departed = now;
      if (rec.leg === 'to_destination' && !sv.pickedUp) sv.pickedUp = now;
      if (rec.serviceStatus === 'on_scene' && rec.leg === 'to_destination' && !sv.atDestination) sv.atDestination = now;
      if (rec.serviceStatus === 'on_scene' && !sv.onScene) sv.onScene = now;
      if (rec.serviceStatus === 'complete' && !sv.completed) sv.completed = now;
      rec.srv = sv;
    }
    return {};
  }
  // incidents of a control room
  if (/^lcr:[^:]+:incidents$/.test(key)) {
    if (!isObj(nextV)) return { error: 'Incidents must be a map keyed by incident id' };
    const prev = isObj(prevV) ? prevV : {};
    for (const id of Object.keys(prev)) if (!(id in nextV) && role !== 'hq' && role !== 'lcr') return { error: 'Only a control room can remove an incident' };
    for (const [id, rec] of Object.entries(nextV)) {
      if (!isObj(rec) || (rec.id !== undefined && rec.id !== id)) return { error: 'Incident ' + id + ' is malformed' };
      const old = prev[id];
      if (old && same(old, rec)) continue;
      // drills: only a control room or HQ can start one, it can never be turned into (or out of) a real incident, and it is always labelled
      if (!old && rec.drill) { if (role !== 'hq' && role !== 'lcr') return { error: 'Only a control room or HQ can start a drill' }; rec.drill = true; if (!/^\[DRILL\]/.test(String(rec.location || ''))) rec.location = '[DRILL] ' + String(rec.location || 'Training exercise').slice(0, 200); }
      else if (!!(old && old.drill) !== !!rec.drill) return { error: 'An incident cannot be turned into or out of a drill' };
      if (role === 'civilian') {
        if (!old) {
          if (rec.status !== 'new' || rec.officerName || rec.officerBadge || rec.officerStatus || rec.officerETA) return { error: 'A civilian can only raise a new alert' };
          if (rec.lat != null && rec.lng != null && !inGhana(rec.lat, rec.lng)) return { error: 'The alert position is outside Ghana' };
          { const sid = key.split(':')[1], rg = (kvGet('registry:stations', {}) || {})[sid];   // an alert must never be filed with a control room that does not exist or is switched off
            const live = rg ? !rg.disabled : (process.env.GEAMS_SEED_DEFAULT_STATIONS === '1' && BUILTIN_STATIONS.includes(sid));
            if (!live) { console.log('REFUSED alert for inactive control room ' + sid); return { error: 'That control room is not active on GEAMS, so your alert was NOT sent. Call 112 now.' }; } }
          { const pz = store['hq:pilot'] && store['hq:pilot'].value; if (pz && pz.paused) return { error: pz.message || 'GEAMS alerts are paused. If this is an emergency, call 112 now.' }; }
          { const bl = kvGet('registry:blocks', {}), hit = Object.entries(bl).find(([cid, x]) => cid === rec.civilianId || (x.devs || []).includes(ses.dev));
            if (hit) { if (hit[1].level === 'block') { console.log('REFUSED alert from blocked sender ' + hit[0]); return { error: 'Your alert could not be sent from this phone. If this is a real emergency, call 112 now.' }; }
              rec.abuseFlag = { level: 'flag', at: Date.now() }; rec.notes = '⚠ SENDER FLAGGED FOR FALSE ALARMS: verify by phone before sending a crew. ' + String(rec.notes || '').slice(0, 900); } }
          if (!bump('alert|' + ses.dev, +process.env.GEAMS_CIV_ALERTS_PER_HOUR || 10, 3600000)) return { error: 'Too many alerts from this phone in the last hour. If this is a real emergency, call 112.' };
          rec.civilianVerified = !!ses.verified;                   // stamped by the server, never by the caller
          rec.ownerDev = ses.dev; delete rec.reporterDevs;       // only this phone can read or change the alert later
          if (ses.verified && ses.phone && rec.civilianPhone !== null && rec.civilianPhone !== undefined) rec.civilianPhone = ses.phone;
        } else {
          for (const k of new Set([...Object.keys(old), ...Object.keys(rec)])) {
            if (same(old[k], rec[k])) continue;
            if (k === 'status') { if (!(rec.status === 'cancelled' && old.status === 'new')) return { error: 'A civilian can only cancel an alert that no one has taken yet' }; continue; }
            if (k === 'additionalReporters') { const a = old[k] || [], b = rec[k] || []; if (!Array.isArray(b) || b.length < a.length || !same(a, b.slice(0, a.length))) return { error: 'Reporters can only be added' }; continue; }
            if (!CIV_FIELDS.includes(k)) return { error: 'A civilian cannot change "' + k + '" on an alert' };
          }
        }
      } else if (role === 'officer' && old) {
        const mine = (old.officerBadge && old.officerBadge === ses.badge) || (old.officerName && String(old.officerName).toLowerCase() === String(ses.user).toLowerCase());
        if (!mine) return { error: 'You can only update an incident assigned to you' };
        for (const k of ['id', 'civilianId', 'civilianName', 'civilianPhone', 'createdAt', 'source', 'type', 'priority', 'lat', 'lng', 'drill']) if (!same(old[k], rec[k])) return { error: 'An officer cannot change "' + k + '"' };
      }
      stampSrv(old, rec, Date.now());
    }
    return {};
  }
  // each officer keeps only their own roster entry
  if (/^lcr:[^:]+:officers$/.test(key) && role === 'officer') {
    if (!isObj(nextV)) return { error: 'Roster must be a map' };
    const prev = isObj(prevV) ? prevV : {};
    for (const k of new Set([...Object.keys(prev), ...Object.keys(nextV)])) {
      if (same(prev[k], nextV[k])) continue;
      if (k !== ses.id) return { error: 'You can only change your own roster entry' };
      if (nextV[k] && (nextV[k].badge !== ses.badge)) return { error: 'The roster entry must carry your own badge' };
    }
    return {};
  }
  // HQ orders: the server records who issued them
  if (key === 'hq:tacticalOps') {
    if (!isObj(nextV)) return { error: 'Orders must be a map' };
    const prev = isObj(prevV) ? prevV : {};
    for (const [id, op] of Object.entries(nextV)) {
      if (same(prev[id], op)) continue;
      if (!isObj(op) || !OP_TYPES.includes(op.type) || !op.name || String(op.name).length > 600) return { error: 'Order ' + id + ' is malformed' };
      if (!prev[id]) op.by = ses.user;                               // issuer is the signed-in HQ user, whatever the page sent
      else if (op.status === 'lifted' && prev[id].status !== 'lifted') op.liftedBy = ses.user;
    }
    return {};
  }
  // station records created by HQ
  if (key === 'registry:stations') {
    if (!isObj(nextV)) return { error: 'Stations must be a map' };
    for (const [id, r] of Object.entries(nextV)) {
      if (!isObj(r) || r.id !== id || !r.name || String(r.name).length > 120) return { error: 'Station ' + id + ' is malformed' };
      if (!inGhana(r.lat, r.lng)) return { error: 'Station ' + id + ' is positioned outside Ghana' };
      if (r.passHash || r.passphrase || r.hash) return { error: 'Station records must not hold passwords' };
    }
    return {};
  }
  // a control room may only change its own entry in shared station maps
  if (['registry:stationLocations', 'registry:lcrCommanders', 'hq:lcr_status'].includes(key) && role === 'lcr') {
    if (!isObj(nextV)) return { error: 'Must be a map' };
    const prev = isObj(prevV) ? prevV : {};
    for (const k of new Set([...Object.keys(prev), ...Object.keys(nextV)])) {
      if (same(prev[k], nextV[k])) continue;
      if (k !== ses.sid) return { error: 'A control room can only change its own entry' };
    }
    if (key === 'registry:stationLocations' && nextV[ses.sid] && !inGhana(nextV[ses.sid].lat, nextV[ses.sid].lng)) return { error: 'Position outside Ghana' };
    if (key === 'registry:lcrCommanders' && isObj(nextV[ses.sid]) && !same(prev[ses.sid], nextV[ses.sid])) {
      const e = nextV[ses.sid];
      if (ses.cmd) { if (e.name !== ses.cmd.name || (e.rank || '') !== (ses.cmd.rank || '')) return { error: 'The commander on duty must match the account you signed in with' }; e.verified = true; e.account = ses.cmd.user; }
      else { e.verified = false; delete e.account; }
    }
    return {};
  }
  // civilians keep only their own account and face record
  if ((key === 'registry:civilians' || key === 'registry:faces') && role === 'civilian') {
    if (!isObj(nextV)) return { error: 'Must be a map' };
    const prev = isObj(prevV) ? prevV : {};
    if (REQUIRE_VERIFIED && !ses.verified) return { error: 'Verify your phone number first' };
    for (const k of new Set([...Object.keys(prev), ...Object.keys(nextV)])) {
      if (same(prev[k], nextV[k])) continue;
      const rec = nextV[k];
      if (!rec) return { error: 'Accounts cannot be removed here' };
      if (REQUIRE_VERIFIED && ses.phone && rec.phone && normPhone(rec.phone) !== ses.phone) return { error: 'The phone number must be the one you verified' };
    }
    return {};
  }
  return {};
}

function kvGet(key, def) { return store[key] ? store[key].value : def; }
function kvSet(key, value) {
  const cur = store[key], v = (cur ? cur.v : 0) + 1;
  store[key] = { value, v, ts: Date.now() }; scheduleSave(key);
  if (!/^registry:(stationAuth|unitAuth|unitPending|pushSubs|commanderAuth|authEpoch|faces|faceAudit|civRecovery|retentionLog|consents|feedback|clientErrors|staffLog|blocks|escalations|agencyHq|agencyEscalations|agencyChat)$/.test(key)) broadcast({ key, v });
}

/* ── Officer, fire and ambulance accounts live on the server ── */
const UNIT = {
  officer:   { key: 'registry:officers',  prefix: 'GH-',   idf: 'officerId', idp: 'OFF-' },
  fire:      { key: 'registry:fire',      prefix: 'GHFS-', idf: 'crewId',    idp: 'FIRE-' },
  ambulance: { key: 'registry:ambulance', prefix: 'GNAS-', idf: 'crewId',    idp: 'MEDIC-' },
};
const UNIT_AUTH = 'registry:unitAuth', UNIT_PENDING = 'registry:unitPending';
const CHAT_KEY = 'registry:agencyChat';
const chatThread = (kind, badge) => { const t = (kvGet(CHAT_KEY, {}) || {})[kind + ':' + badge]; return t && Array.isArray(t.items) ? t : { items: [], hqReadAt: 0, crewReadAt: 0 }; };
function chatPost(kind, badge, from, by, text, readField) {
  const all = Object.assign({}, kvGet(CHAT_KEY, {}) || {}), id = kind + ':' + badge, t = Object.assign({ items: [], hqReadAt: 0, crewReadAt: 0 }, all[id] || {}), now = Date.now();
  t.items = t.items.concat([{ id: crypto.randomBytes(5).toString('hex'), at: now, from, by, text }]).slice(-200); t[readField] = now; t.last = now; all[id] = t;
  const keys = Object.keys(all); if (keys.length > 3000) keys.sort((a, b) => (all[a].last || 0) - (all[b].last || 0)).slice(0, keys.length - 3000).forEach(k => delete all[k]);
  kvSet(CHAT_KEY, all); return t;
}
const chatOut = (t, side) => ({ items: t.items.slice(-100), unread: t.items.filter(m => m.from !== side && m.at > (side === 'hq' ? t.hqReadAt : t.crewReadAt)).length });
const agencyOf = (ses) => ses && AGENCY_ROLES.includes(ses.role) ? ses.agency : null;   // 'fire' | 'ambulance' | null
const sha256hex = (x) => crypto.createHash('sha256').update(x).digest('hex');
const clean = (v, n) => String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, n || 80);
function scrubLegacyUnits() {            // move old browser-made hashes out of the readable lists
  const ua = Object.assign({}, kvGet(UNIT_AUTH, {})); let n = 0;
  for (const [kind, U] of Object.entries(UNIT)) {
    const list = kvGet(U.key, null); if (!Array.isArray(list)) continue; let dirty = false;
    const out = list.map(c => {
      if (c && (c.passHash || c.password !== undefined)) {
        const id = kind + ':' + c.badge;
        if (!ua[id]) ua[id] = c.passHash ? { legacy: c.passHash } : { legacyPlain: String(c.password) };
        const x = Object.assign({}, c); delete x.passHash; delete x.password; dirty = true; n++; return x;
      }
      return c;
    });
    if (dirty) kvSet(U.key, out);
  }
  if (n) kvSet(UNIT_AUTH, ua);
  return n;
}
function unitOk(rec, name, pass) {
  const id = rec.kind + ':' + rec.cred.badge, ua = kvGet(UNIT_AUTH, {}), a = ua[id]; if (!a) return false;
  if (a.hash) return eq(pwHash(pass, a.salt), a.hash);
  const legacy = a.legacy ? eq(sha256hex('geams:' + String(name).trim().toLowerCase() + ':' + pass), a.legacy) : (a.legacyPlain !== undefined && eq(String(a.legacyPlain), String(pass)));
  if (legacy) { const salt = crypto.randomBytes(16).toString('hex'); ua[id] = { salt, hash: pwHash(pass, salt), migrated: Date.now() }; kvSet(UNIT_AUTH, ua); }
  return legacy;
}
function unitToken(res, req, kind, cred) { return issue(res, req, { r: kind, u: cred.name, b: cred.badge, l: cred.lcrId, i: cred[UNIT[kind].idf] }, SESSION_MS); }

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
  if (p === '/config.js') {   // settings the apps read at load; point these at your own servers to remove outside dependencies
    const c = {}; for (const [k, e] of [['pilotLabel', 'GEAMS_PILOT_LABEL'], ['smsNumber', 'GEAMS_SMS_NUMBER'], ['tileUrl', 'GEAMS_TILE_URL'], ['tileAttribution', 'GEAMS_TILE_ATTRIBUTION'], ['tileMaxNativeZoom', 'GEAMS_TILE_MAX_NATIVE_ZOOM'], ['routeUrl', 'GEAMS_ROUTE_URL'], ['geocodeUrl', 'GEAMS_GEOCODE_URL'], ['privacyContact', 'GEAMS_PRIVACY_CONTACT'], ['simulateLocation', 'GEAMS_ALLOW_SIMULATED_LOCATION'], ['privacyUrl', 'GEAMS_PRIVACY_URL']]) if (process.env[e]) c[k] = process.env[e].replace(k.endsWith('Url') && k !== 'tileUrl' ? /\/+$/ : /$^/, '');
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
    c.demoStations = process.env.GEAMS_SEED_DEFAULT_STATIONS === '1';   // false = the 13 built-in demo stations are not live and must not receive alerts or appear as real
    return res.end('window.GEAMS_CONFIG=' + JSON.stringify(c) + ';');
  }

  try {
    if (p.startsWith('/api/') && !/^\/api\/(agency\/|kv\/|events$|ping$|health$|presence$|version$|clientlog$|csp-report$|lcr\/(crew\/bulk|unit\/reset|pending|approve)$)/.test(p)) {   // a fire or ambulance HQ token opens nothing outside its own endpoints
      const sg = sessionOf(req, true); if (sg && AGENCY_ROLES.includes(sg.role)) return json(res, 403, { error: 'This sign-in is for the ' + sg.agency + ' HQ screens only' });
    }
    if (p === '/api/health') return json(res, 200, { ok: true, version: 2, time: Date.now(), ...devices(), keys: Object.keys(store).length, saving: saveState.ok });
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
      { const ses = sessionOf(req, req.method === 'GET'); const w = req.method === 'PUT' || req.method === 'POST';
        if (!ses) return json(res, 401, { error: 'Sign in required' });
        if (w && !['hq', 'lcr', 'officer', 'civilian'].includes(ses.role)) return json(res, 403, { error: 'Your role cannot upload evidence' });
        if (ses.role === 'civilian' && !civMayUse(ses, parts[0], w)) return json(res, 403, { error: 'That evidence belongs to someone else' });
        if (!staffMayUse(ses, parts[0], w)) return json(res, 403, { error: 'That evidence belongs to another control room' }); }
      if (req.method === 'PUT' || req.method === 'POST') {
        if (/\.(type|seal|log|tsa)$/i.test(parts[1])) return json(res, 400, { error: 'That file name is reserved' });
        const ses = sessionOf(req), append = u.searchParams.get('append') === '1';
        const buf = await readRaw(req, MAX_BLOB);
        const exists = fs.existsSync(fp), prevSeal = readSeal(fp), actor = actorOf(ses, req);
        const sameWriter = prevSeal && prevSeal.by && prevSeal.by.role === actor.role && prevSeal.by.user === actor.user && (!prevSeal.by.dev || !actor.dev || prevSeal.by.dev === actor.dev);
        if (exists && !append && !(prevSeal && prevSeal.writes <= 1 && sameWriter && crypto.createHash('sha256').update(buf).digest('hex') === prevSeal.sha256)) return json(res, 409, { error: 'This evidence is sealed and cannot be replaced' });
        if (exists && append && !(['hq', 'lcr'].includes(ses.role) || sameWriter)) return json(res, 403, { error: 'Only whoever started this recording can add to it' });
        const ct = String(req.headers['content-type'] || 'application/octet-stream').slice(0, 100);
        const seal = await sealWrite(fp, parts[0], parts[1], buf, append, ses, req, ct);
        try { fs.writeFileSync(fp + '.type', ct); mirror(fp + '.type'); } catch (e) {}
        return json(res, 200, { ok: true, size: seal.size, sha256: seal.sha256 });
      }
      if (req.method === 'GET') {
        let st; try { st = fs.statSync(fp); } catch (e) { res.writeHead(404); return res.end('Not found'); }
        let ct = 'application/octet-stream'; try { ct = fs.readFileSync(fp + '.type', 'utf8'); } catch (e) {}
        { const ses = sessionOf(req, true); const rg = req.headers.range && /bytes=(\d*)-/.exec(req.headers.range); if (ses && (!rg || !rg[1] || rg[1] === '0')) noteView(fp, ses, req, !!u.searchParams.get('dl')); }
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
      const sesL = sessionOf(req, true); if (!sesL) return json(res, 401, { error: 'Sign in required' });
      const inc = decodeURIComponent(p.slice(11));
      if (!civMayUse(sesL, inc, false)) return json(res, 403, { error: 'That evidence belongs to someone else' });
      if (!staffMayUse(sesL, inc, false)) return json(res, 403, { error: 'That evidence belongs to another control room' });
      const dir = path.join(BLOB_DIR, safeSeg(inc));
      let list = [];
      try {
        list = fs.readdirSync(dir).filter(n => !/\.(type|seal|log|tsa)$/.test(n)).map(n => {
          const st = fs.statSync(path.join(dir, n));
          let type = ''; try { type = fs.readFileSync(path.join(dir, n + '.type'), 'utf8'); } catch (e) {}
          const sl = readSeal(path.join(dir, n));
          return { name: n, size: st.size, type, ts: st.mtimeMs, sha256: sl ? sl.sha256 : null, sealed: !!sl, sealedAt: sl ? sl.sealedAt : null };
        });
      } catch (e) {}
      return json(res, 200, { files: list });
    }


    // ── Evidence verification and chain of custody ──
    { const em = /^\/api\/evidence\/([^/]+)\/([^/]+)\/(verify|custody|timestamp)$/.exec(p);
      if (em && req.method === 'GET') {
        const ses = sessionOf(req, true); if (!ses) return json(res, 401, { error: 'Sign in required' });
        if (!['hq', 'lcr', 'officer'].includes(ses.role)) return json(res, 403, { error: 'Only HQ, control rooms and officers can verify evidence' });
        const inc = decodeURIComponent(em[1]), name = decodeURIComponent(em[2]), fp = blobPath(inc, name);
        if (em[3] === 'verify') return json(res, 200, await verifyEvidence(fp, inc, name, ses, req));
        if (em[3] === 'timestamp') { const ts = readJson(fp + '.tsa'); return ts ? json(res, 200, ts) : json(res, 404, { error: 'No outside timestamp stored for this file' }); }
        const c = readCustody(fp), sl = readSeal(fp);
        return json(res, 200, { inc, name, chainOk: c.chainOk, seal: sl ? { sha256: sl.sha256, size: sl.size, sealedAt: sl.sealedAt, sig: sl.sig, by: sl.by } : null, entries: c.entries });
      } }
    // ── HQ sign-in ──
    if (p === '/api/hq/login' && req.method === 'POST') {
      const b = await readBody(req), k = clientIp(req) + '|' + String(b.username || '').toLowerCase();
      const wait = lockedOut(k); if (wait) return json(res, 429, { error: 'Too many failed attempts. Try again in ' + Math.ceil(wait / 60) + ' min.' });
      const who = checkLogin(b.username, b.password);
      if (!who) { noteFail(k); return json(res, 401, { error: 'Wrong username or password' }); }
      fails.delete(k);
      return json(res, 200, { token: issue(res, req, { r: 'hq', u: who.user, hr: who.role }, SESSION_MS), user: who.user, role: who.role, expires: Date.now() + SESSION_MS });
    }
    if (p === '/api/hq/me' && req.method === 'GET') { const s = sessionOf(req); return s && s.role === 'hq' ? json(res, 200, { user: s.user, role: s.hqRole }) : json(res, 401, { error: 'Not signed in' }); }
    if (p === '/api/hq/logout' && req.method === 'POST') { const s = sessionOf(req, true); if (s) revoked.add(s.jti); res.setHeader('Set-Cookie', 'geams_t=; Path=/; HttpOnly; Max-Age=0'); return json(res, 200, { ok: true }); }
    if (p === '/api/hq/users') {
      const s = sessionOf(req); if (!s || s.role !== 'hq') return json(res, 401, { error: 'Not signed in' });
      if (s.hqRole !== 'admin') return json(res, 403, { error: 'Only the HQ owner can manage operators' });
      if (req.method === 'GET') return json(res, 200, { owner: OWNER, ownerPasswordFromEnv: !ownerGenerated, users: Object.entries(hqUsers).map(([u, v]) => ({ username: u, role: v.role, created: v.created })) });
      if (req.method === 'POST') {
        const b = await readBody(req), name = String(b.username || '').trim().toLowerCase();
        if (b.remove) { delete hqUsers[name]; saveUsers(); return json(res, 200, { ok: true }); }
        if (!/^[a-z0-9._-]{3,32}$/.test(name) || name === OWNER) return json(res, 400, { error: 'Username: 3-32 letters, digits, dot, dash or underscore' });
        if (String(b.password || '').length < 10) return json(res, 400, { error: 'Password must be at least 10 characters' });
        const salt = crypto.randomBytes(16).toString('hex');
        hqUsers[name] = { salt, hash: pwHash(b.password, salt), role: 'operator', created: Date.now(), changed: Date.now() }; saveUsers();
        return json(res, 200, { ok: true });
      }
    }
    // ── LCR credentials: issued by HQ, verified here, never readable by clients ──
    if (p === '/api/hq/lcr/credential' && req.method === 'POST') {
      const s = sessionOf(req); if (!s || s.role !== 'hq') return json(res, 401, { error: 'HQ sign-in required' });
      const b = await readBody(req), id = String(b.stationId || '');
      const reg = store['registry:stations'] && store['registry:stations'].value || {};
      if (!reg[id] && !BUILTIN_STATIONS.includes(id)) return json(res, 404, { error: 'Unknown station' });
      const pass = newPassphrase(), salt = crypto.randomBytes(16).toString('hex');
      const cur = store[SECRET_KEY], map = (cur && cur.value) || {};
      map[id] = { salt, hash: pwHash(pass, salt), issuedAt: Date.now(), by: s.user };
      store[SECRET_KEY] = { value: map, v: (cur ? cur.v : 0) + 1, ts: Date.now() }; scheduleSave(SECRET_KEY);
      return json(res, 200, { passphrase: pass });
    }
    if (p === '/api/lcr/login' && req.method === 'POST') {
      const b = await readBody(req), id = String(b.stationId || ''), cin = isObj(b.commander) ? b.commander : null, cuser = cin ? String(cin.username || '').trim().toLowerCase() : '', k = clientIp(req) + '|' + id + (cuser ? '|' + cuser : '');
      const wait = lockedOut(k); if (wait) return json(res, 429, { error: 'Too many failed attempts. Try again in ' + Math.ceil(wait / 60) + ' min.' });
      const reg = store['registry:stations'] && store['registry:stations'].value || {};
      const st = reg[id] || {}; const a = store[SECRET_KEY] && store[SECRET_KEY].value && store[SECRET_KEY].value[id];
      if (!reg[id] && !BUILTIN_STATIONS.includes(id)) return json(res, 404, { error: 'Unknown Station ID' });
      if (!a) return json(res, 404, { error: 'HQ has not issued a login for this control room yet' });
      if (st.disabled) return json(res, 403, { error: 'This control room has been disabled by HQ' });
      if (!eq(pwHash(b.passphrase || '', a.salt), a.hash)) { noteFail(k); return json(res, 401, { error: 'Incorrect passphrase for this Station ID' }); }
      const accts = commanderAccts(id), active = Object.entries(accts).filter(([, x]) => !x.disabled);
      if (!active.length && process.env.GEAMS_REQUIRE_COMMANDER_ACCOUNTS === '1') return json(res, 403, { error: 'HQ has not created a commander account for this control room yet' });
      if (active.length) {
        if (!cuser || !cin.password) { noteFail(k); return json(res, 401, { error: 'Enter your commander username and password' }); }
        const ca = accts[cuser];
        if (!ca || ca.disabled || !eq(pwHash(String(cin.password), ca.salt), ca.hash)) { noteFail(k); return json(res, 401, { error: 'Incorrect commander username or password' }); }
        fails.delete(k); console.log('commander sign-in: ' + cuser + ' at ' + id);
        return json(res, 200, { ok: true, token: issue(res, req, { r: 'lcr', s: id, u: cuser, cu: cuser, cn: ca.name, cr: ca.rank }, SESSION_MS), commander: { user: cuser, name: ca.name, rank: ca.rank, phone: ca.phone || '' } });
      }
      fails.delete(k);
      return json(res, 200, { ok: true, token: issue(res, req, { r: 'lcr', s: id, u: id }, SESSION_MS), commander: null });
    }
    if (p === '/api/lcr/login-info' && req.method === 'GET') {   // lets the sign-in form know which boxes to show; reveals only a yes/no
      const id = String(u.searchParams.get('stationId') || ''), n = Object.values(commanderAccts(id)).filter(x => !x.disabled).length;
      return json(res, 200, { commanderAccounts: n > 0, required: n > 0 || process.env.GEAMS_REQUIRE_COMMANDER_ACCOUNTS === '1' });
    }
    if (p === '/api/lcr/commander/password' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'lcr' || !ses.cmd) return json(res, 401, { error: 'Sign in with your commander account' });
      if (!bump('cpw|' + ses.sid + '|' + ses.cmd.user, 8, 15 * 60000)) return json(res, 429, { error: 'Too many attempts. Try again later.' });
      const b = await readBody(req), all = JSON.parse(JSON.stringify(kvGet(CMD_KEY, {}))), a = (all[ses.sid] || {})[ses.cmd.user];
      if (!a || !eq(pwHash(String(b.current || ''), a.salt), a.hash)) return json(res, 401, { error: 'Your current password is not right' });
      if (String(b.password || '').length < 10) return json(res, 400, { error: 'New password must be at least 10 characters' });
      a.salt = crypto.randomBytes(16).toString('hex'); a.hash = pwHash(String(b.password), a.salt); a.changed = Date.now(); kvSet(CMD_KEY, all);
      return json(res, 200, { ok: true, token: issue(res, req, { r: 'lcr', s: ses.sid, u: ses.cmd.user, cu: ses.cmd.user, cn: a.name, cr: a.rank }, SESSION_MS) });
    }
    // HQ creates and manages commander accounts
    if (p === '/api/hq/lcr/commander') {
      const s = sessionOf(req); if (!s || s.role !== 'hq') return json(res, 401, { error: 'HQ sign-in required' });
      const reg = store['registry:stations'] && store['registry:stations'].value || {};
      if (req.method === 'GET') {
        const id = String(u.searchParams.get('stationId') || ''); if (!reg[id] && !BUILTIN_STATIONS.includes(id)) return json(res, 404, { error: 'Unknown station' });
        return json(res, 200, { accounts: Object.entries(commanderAccts(id)).map(([user, a]) => ({ username: user, name: a.name, rank: a.rank, phone: a.phone || '', disabled: !!a.disabled, created: a.created, by: a.by })) });
      }
      if (req.method === 'POST') {
        const b = await readBody(req), id = String(b.stationId || ''), user = String(b.username || '').trim().toLowerCase(), act = String(b.action || 'create');
        if (!reg[id] && !BUILTIN_STATIONS.includes(id)) return json(res, 404, { error: 'Unknown station' });
        const all = JSON.parse(JSON.stringify(kvGet(CMD_KEY, {}))), mine = all[id] || (all[id] = {}), a = mine[user];
        if (act === 'create') {
          const name = clean(b.name, 60), rank = clean(b.rank, 40), phone = clean(b.phone, 30);
          if (!/^[a-z0-9._-]{3,32}$/.test(user)) return json(res, 400, { error: 'Username: 3-32 letters, digits, dot, dash or underscore' });
          if (!name || name.length < 3 || !/\s/.test(name)) return json(res, 400, { error: 'Enter the commander\'s full name (first and last)' });
          if (a) return json(res, 409, { error: 'That username already exists for this control room. Use reset to set a new password.' });
          const pw = b.password ? String(b.password) : newPassphrase(); if (pw.length < 10) return json(res, 400, { error: 'Password must be at least 10 characters' });
          const salt = crypto.randomBytes(16).toString('hex'); mine[user] = { name, rank, phone, salt, hash: pwHash(pw, salt), created: Date.now(), changed: Date.now(), by: s.user }; kvSet(CMD_KEY, all);
          console.log('commander account created: ' + user + ' at ' + id + ' by hq:' + s.user); staffLog(s, 'commander.created', user, '', id); return json(res, 200, { ok: true, username: user, password: pw });
        }
        if (!a) return json(res, 404, { error: 'No such commander account' });
        if (act === 'reset') { const pw = newPassphrase(), salt = crypto.randomBytes(16).toString('hex'); a.salt = salt; a.hash = pwHash(pw, salt); a.changed = Date.now() + 1; kvSet(CMD_KEY, all); return json(res, 200, { ok: true, username: user, password: pw }); }
        if (act === 'disable' || act === 'enable') { a.disabled = act === 'disable'; a.changed = Date.now() + 1; kvSet(CMD_KEY, all); return json(res, 200, { ok: true }); }
        if (act === 'remove') { delete mine[user]; if (!Object.keys(mine).length) delete all[id]; kvSet(CMD_KEY, all); return json(res, 200, { ok: true }); }
        return json(res, 400, { error: 'Unknown action' });
      }
    }
    // ── Officer / fire / ambulance accounts ──
    if (p === '/api/unit/signup' && req.method === 'POST') {
      const b = await readBody(req), kind = String(b.kind || ''), U = UNIT[kind];
      if (!U) return json(res, 400, { error: 'Unknown account type' });
      if (!bump('signup|' + clientIp(req), 30, 10 * 60000)) return json(res, 429, { error: 'Too many sign-ups from this address. Try again later.' });
      const c = b.cred || {}, name = clean(c.name, 60), phone = clean(c.phone, 30), lcrId = clean(c.lcrId, 80);
      if (!name || !phone || !lcrId) return json(res, 400, { error: 'Name, phone and control room are required' });
      if (String(b.password || '').length < 6) return json(res, 400, { error: 'Password must be at least 6 characters' });
      const list = Array.isArray(kvGet(U.key, null)) ? kvGet(U.key, []).slice() : [];
      const pendList = Object.values(kvGet(UNIT_PENDING, {})).filter(x => x.kind === kind).map(x => x.cred);
      if (list.concat(pendList).some(x => x.phone === phone)) return json(res, 409, { error: 'An account is already registered with this phone number.' });
      if (list.concat(pendList).some(x => String(x.name).toLowerCase() === name.toLowerCase())) return json(res, 409, { error: 'An account with this name already exists. Add a middle name or initial.' });
      let badge; do { badge = U.prefix + (20000 + crypto.randomInt(0, 79999)); } while (list.some(x => x.badge === badge));
      const cred = { badge, [U.idf]: U.idp + (5000 + crypto.randomInt(0, 4999)), name, rank: clean(c.rank, 40), lcrId, vehicle: clean(c.vehicle, 60) || 'Unassigned', phone };
      if (c.vehicleType) cred.vehicleType = clean(c.vehicleType, 60);
      const salt = crypto.randomBytes(16).toString('hex'), ua = Object.assign({}, kvGet(UNIT_AUTH, {}));
      ua[kind + ':' + badge] = { salt, hash: pwHash(b.password, salt), created: Date.now() };
      kvSet(UNIT_AUTH, ua);
      if (!AUTO_APPROVE) {                                                  // wait for the control room (or HQ) to approve
        const pend = Object.assign({}, kvGet(UNIT_PENDING, {})); pend[kind + ':' + badge] = { kind, cred, requestedAt: Date.now() };
        kvSet(UNIT_PENDING, pend);
        return json(res, 202, { pending: true, message: 'Registered. ' + approverName(kind).replace(/^your/, 'Your') + ' must approve you before you can sign in. You will not be able to sign in until then.' });
      }
      list.push(cred); kvSet(U.key, list);
      return json(res, 200, { token: unitToken(res, req, kind, cred), cred });
    }
    if (p === '/api/unit/login' && req.method === 'POST') {
      const b = await readBody(req), kind = String(b.kind || ''), U = UNIT[kind];
      if (!U) return json(res, 400, { error: 'Unknown account type' });
      const name = clean(b.name, 60), k = clientIp(req) + '|' + kind + '|' + name.toLowerCase();
      const wait = lockedOut(k); if (wait) return json(res, 429, { error: 'Too many failed attempts. Try again in ' + Math.ceil(wait / 60) + ' min.' });
      const list = Array.isArray(kvGet(U.key, null)) ? kvGet(U.key, []) : [];
      // a crew member may type the name, the phone number or the badge printed on their login sheet
      const who = (x) => String(x.name).toLowerCase() === name.toLowerCase() || String(x.badge).toLowerCase() === name.toLowerCase() || (name.replace(/\D/g, '').length >= 9 && normPhone(x.phone) === normPhone(name));
      const hit = list.filter(who).find(x => unitOk({ kind, cred: x }, x.name, String(b.password || '')));
      if (!hit) {
        const pend = Object.values(kvGet(UNIT_PENDING, {})).find(x => x.kind === kind && who(x.cred) && unitOk({ kind, cred: x.cred }, x.cred.name, String(b.password || '')));
        if (pend) return json(res, 403, { error: 'Your registration is waiting for approval by ' + approverName(kind) + '.' });
        noteFail(k); return json(res, 401, { error: 'Invalid name or password' });
      }
      fails.delete(k);
      { const ua0 = kvGet(UNIT_AUTH, {})[kind + ':' + hit.badge]; if (ua0 && ua0.disabled) return json(res, 403, { error: 'This account has been disabled by your HQ. Ask them to turn it back on.' }); }
      { const ua = kvGet(UNIT_AUTH, {})[kind + ':' + hit.badge]; return json(res, 200, { token: unitToken(res, req, kind, hit), cred: hit, mustChange: !!(ua && ua.mustChange) }); }
    }
    // ── Crew passwords: change your own, or have your control room (or HQ) reset it ──
    if (p === '/api/unit/hq-chat') {          // a fire or ambulance crew member and their own HQ: administrative messages only
      const ses = sessionOf(req); if (!ses || !['fire', 'ambulance'].includes(ses.role) || !ses.badge) return json(res, 401, { error: 'Sign in as a fire or ambulance crew member' });
      if (req.method === 'GET') { const t = chatThread(ses.role, ses.badge); const all = Object.assign({}, kvGet(CHAT_KEY, {}) || {}), id = ses.role + ':' + ses.badge;
        if (all[id] && u.searchParams.get('read') === '1') { all[id] = Object.assign({}, t, { crewReadAt: Date.now() }); kvSet(CHAT_KEY, all); }
        return json(res, 200, Object.assign(chatOut(t, 'crew'), { hq: ses.role === 'fire' ? 'Fire HQ' : 'Ambulance HQ', note: 'For administrative matters only (shifts, kit, leave, accounts). In an emergency use the alert screens or call 112.' })); }
      if (req.method === 'POST') { const b = await readBody(req), text = clean(b.message, 500); if (text.length < 1) return json(res, 400, { error: 'Write a message' });
        if (!bump('hqc|' + ses.role + ':' + ses.badge, 30, 600000)) return json(res, 429, { error: 'Too many messages. Wait a few minutes.' });
        const list = kvGet(UNIT[ses.role].key, []) || [], me = list.find(x => x.badge === ses.badge);
        const t = chatPost(ses.role, ses.badge, 'crew', (me && me.name) || ses.user || ses.badge, text, 'crewReadAt'); return json(res, 200, Object.assign({ ok: true }, chatOut(t, 'crew'))); }
      return json(res, 405, { error: 'GET or POST only' });
    }
    if (p === '/api/unit/password' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || !UNIT[ses.role]) return json(res, 401, { error: 'Sign in as a crew member' });
      const k = 'upw|' + ses.role + ':' + ses.badge; const wait = lockedOut(k); if (wait) return json(res, 429, { error: 'Too many attempts. Try again in ' + Math.ceil(wait / 60) + ' min.' });
      const b = await readBody(req), id = ses.role + ':' + ses.badge, ua = Object.assign({}, kvGet(UNIT_AUTH, {})), a = ua[id];
      if (!a || !unitOk({ kind: ses.role, cred: { badge: ses.badge } }, ses.user, String(b.current || ''))) { noteFail(k); return json(res, 401, { error: 'Your current password is not right' }); }
      const np = String(b.password || ''); if (np.length < 8) return json(res, 400, { error: 'New password must be at least 8 characters' });
      if (np === String(b.current || '')) return json(res, 400, { error: 'Choose a password different from the current one' });
      fails.delete(k);
      const cur = kvGet(UNIT_AUTH, {})[id], salt = crypto.randomBytes(16).toString('hex'); ua[id] = { salt, hash: pwHash(np, salt), created: (cur && cur.created) || Date.now(), changed: Date.now() };
      kvSet(UNIT_AUTH, ua);
      const cred = (kvGet(UNIT[ses.role].key, []) || []).find(x => x.badge === ses.badge); if (!cred) return json(res, 404, { error: 'Account not found' });
      console.log('crew password changed: ' + id);
      return json(res, 200, { ok: true, token: unitToken(res, req, ses.role, cred) });
    }
    // ── Bulk setup: a control room (or HQ) adds many crew at once; each gets a one-time temporary password ──
    if (p === '/api/lcr/crew/bulk' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || !['lcr', 'hq', ...AGENCY_ROLES].includes(ses.role)) return json(res, 401, { error: 'Sign in as a control room or HQ' });
      if (ses.mc) return json(res, 403, { error: 'Choose your own password first' });
      const b = await readBody(req), kind = agencyOf(ses) || String(b.kind || ''), U = UNIT[kind]; if (!U) return json(res, 400, { error: 'Unknown account type' });
      const sid = ses.role === 'lcr' ? ses.sid : String(b.stationId || ''); if (!sid) return json(res, 400, { error: 'Say which control room these crew belong to' });
      if (ses.role !== 'lcr' && !((kvGet('registry:stations', {}) || {})[sid]) && !BUILTIN_STATIONS.includes(sid)) return json(res, 404, { error: 'Unknown control room' });
      const rows = Array.isArray(b.rows) ? b.rows : []; if (!rows.length) return json(res, 400, { error: 'No rows to import' }); if (rows.length > 200) return json(res, 400, { error: 'At most 200 people at a time' });
      const dry = b.dry === true; if (!dry && !bump('cbk|' + ses.user, 10, 3600000)) return json(res, 429, { error: 'Too many bulk imports. Try again later.' });
      const list = Array.isArray(kvGet(U.key, null)) ? kvGet(U.key, []).slice() : [], ua = Object.assign({}, kvGet(UNIT_AUTH, {}));
      const pendList = Object.values(kvGet(UNIT_PENDING, {})).filter(x => x.kind === kind).map(x => x.cred);
      const have = list.concat(pendList), created = [], skipped = [];
      rows.forEach((r, i) => {
        r = isObj(r) ? r : {}; const name = clean(r.name, 60), phone = clean(r.phone, 30).replace(/[^0-9+]/g, '');
        const no = (why) => skipped.push({ row: i + 1, name: name || '(blank)', reason: why });
        if (!name) return no('No name'); if (phone.replace(/\D/g, '').length < 9) return no('Phone number missing or too short');
        if (have.some(x => String(x.phone).replace(/[^0-9+]/g, '') === phone)) return no('That phone number already has an account');
        if (have.some(x => String(x.name).toLowerCase() === name.toLowerCase())) return no('That name already has an account (add an initial to tell them apart)');
        let badge; do { badge = U.prefix + (20000 + crypto.randomInt(0, 79999)); } while (have.some(x => x.badge === badge));
        const cred = { badge, [U.idf]: U.idp + (5000 + crypto.randomInt(0, 4999)), name, rank: clean(r.rank, 40), lcrId: sid, vehicle: clean(r.vehicle, 60) || 'Unassigned', phone };
        if (r.vehicleType) cred.vehicleType = clean(r.vehicleType, 60);
        have.push(cred); const pw = newPassphrase();
        created.push({ name, badge, kind, phone, rank: cred.rank, vehicle: cred.vehicle, tempPassword: pw });
        if (!dry) { const salt = crypto.randomBytes(16).toString('hex'); ua[kind + ':' + badge] = { salt, hash: pwHash(pw, salt), created: Date.now(), changed: Date.now() + 1, mustChange: true, resetBy: ses.role + ':' + ses.user, resetAt: Date.now() }; list.push(cred); }
      });
      if (!dry && created.length) { kvSet(U.key, list); kvSet(UNIT_AUTH, ua); staffLog(ses, 'crew.bulk_import', kind, created.length + ' added, ' + skipped.length + ' skipped', sid); console.log('crew bulk import: ' + created.length + ' ' + kind + ' for ' + sid + ' by ' + ses.role + ':' + ses.user); }
      return json(res, 200, { ok: true, dryRun: dry, station: stationMeta(sid), created: dry ? created.map(c => ({ ...c, tempPassword: undefined })) : created, skipped, note: dry ? 'Preview only: nothing was created.' : 'These temporary passwords are shown ONCE. Print the sheet now. Each person must choose their own password at first sign-in.' });
    }
    // ── Bulk setup (HQ owner): many control rooms at once, each with a one-time passphrase ──
    if (p === '/api/hq/stations/bulk' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'hq' || ses.hqRole !== 'admin') return json(res, 403, { error: 'Only the HQ owner can add control rooms' });
      const b = await readBody(req), rows = Array.isArray(b.rows) ? b.rows : []; if (!rows.length) return json(res, 400, { error: 'No rows to import' }); if (rows.length > 100) return json(res, 400, { error: 'At most 100 control rooms at a time' });
      const dry = b.dry === true; if (!dry && !bump('sbk|' + ses.user, 6, 3600000)) return json(res, 429, { error: 'Too many bulk imports. Try again later.' });
      const reg = Object.assign({}, kvGet('registry:stations', {}) || {}), amap = Object.assign({}, kvGet(SECRET_KEY, {}) || {}), created = [], skipped = [];
      const L = (t, n) => String(t || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, n).padEnd(n, 'X');
      rows.forEach((r, i) => {
        r = isObj(r) ? r : {}; const name = clean(r.name, 120), region = clean(r.region, 60), town = clean(r.town, 60), lat = parseFloat(r.lat), lng = parseFloat(r.lng), phone = clean(r.phone, 30);
        const no = (why) => skipped.push({ row: i + 1, name: name || '(blank)', reason: why });
        if (!name) return no('No name'); if (!region || !town) return no('Region and town are required');
        if (!inGhana(lat, lng)) return no('Latitude/longitude missing or outside Ghana (use decimal degrees, e.g. 7.152 and 0.472)');
        const rad = r.radiusM === undefined || r.radiusM === '' ? 5000 : parseInt(r.radiusM, 10); if (!(rad >= 500 && rad <= 100000)) return no('Radius must be between 500 and 100000 metres');
        if (Object.values(reg).concat(created).some(x => String(x.name).toLowerCase() === name.toLowerCase())) return no('A control room with this name already exists');
        let id, n = 0; do { id = 'GH-' + L(region, 2) + '-' + L(town, 3) + '-' + String(1 + crypto.randomInt(0, 899)).padStart(3, '0') + '-' + newPassphrase().replace(/-/g, '').slice(0, 4); } while (reg[id] || created.some(c => c.id === id) || ++n > 50);
        const pass = newPassphrase(); created.push({ id, name, region, town, lat, lng, jurisdictionRadiusM: rad, phone, passphrase: pass });
        if (!dry) { reg[id] = { id, name, region, town, lat, lng, jurisdictionRadiusM: rad, phone, createdBy: ses.user, createdAt: Date.now() }; const salt = crypto.randomBytes(16).toString('hex'); amap[id] = { salt, hash: pwHash(pass, salt), issuedAt: Date.now(), by: ses.user }; }
      });
      if (!dry && created.length) { kvSet('registry:stations', reg); kvSet(SECRET_KEY, amap); staffLog(ses, 'stations.bulk_import', null, created.length + ' added, ' + skipped.length + ' skipped'); console.log('stations bulk import: ' + created.length + ' by hq:' + ses.user); }
      return json(res, 200, { ok: true, dryRun: dry, created: dry ? created.map(c => ({ ...c, passphrase: undefined })) : created, skipped, note: dry ? 'Preview only: nothing was created.' : 'These passphrases are shown ONCE. Print the sheet and hand each to the right commander.' });
    }
    if (p === '/api/lcr/unit/reset' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || !['lcr', 'hq', ...AGENCY_ROLES].includes(ses.role)) return json(res, 401, { error: 'Sign in as a control room or HQ' });
      if (ses.mc) return json(res, 403, { error: 'Choose your own password first' });
      const b = await readBody(req), kind = agencyOf(ses) || String(b.kind || ''), U = UNIT[kind]; if (!U) return json(res, 400, { error: 'Unknown account type' });
      const cred = (kvGet(U.key, []) || []).find(x => x.badge === String(b.badge || '')); if (!cred) return json(res, 404, { error: 'No such crew member' });
      if (ses.role === 'lcr' && cred.lcrId !== ses.sid) return json(res, 403, { error: 'That crew member belongs to another control room' });
      if (!bump('urs|' + ses.user, 20, 3600000)) return json(res, 429, { error: 'Too many resets. Try again later.' });
      const pw = newPassphrase(), salt = crypto.randomBytes(16).toString('hex'), ua = Object.assign({}, kvGet(UNIT_AUTH, {})), id = kind + ':' + cred.badge, cur = ua[id] || {};
      ua[id] = { salt, hash: pwHash(pw, salt), created: cur.created || Date.now(), changed: Date.now() + 1, mustChange: true, resetBy: ses.role + ':' + ses.user, resetAt: Date.now() }; if (cur.disabled) ua[id].disabled = cur.disabled;
      kvSet(UNIT_AUTH, ua);
      for (const kk of [...fails.keys()]) if (kk.endsWith('|' + kind + '|' + String(cred.name).toLowerCase())) fails.delete(kk);
      console.log('crew password reset: ' + id + ' by ' + ses.role + ':' + ses.user); staffLog(ses, 'crew.password_reset', id, cred.name);
      return json(res, 200, { ok: true, name: cred.name, badge: cred.badge, password: pw, note: 'Give this temporary password to the crew member in person or by phone. They must choose their own at next sign-in.' });
    }
    // ═══ Fire and Ambulance HQ ═══
    // Each agency has its own national HQ. Control rooms (LCRs) still receive every alert and forward it to the nearest fire or
    // ambulance station; the agency HQ then sees that forwarded copy live, can move it to another station, message its crews,
    // run its people and pull its own reports. It never reads police incident records.
    if (p === '/api/hq/agency') {          // the national HQ owner creates, resets, disables and re-enables agency HQ accounts
      const ses = sessionOf(req); if (!ses || ses.role !== 'hq') return json(res, 401, { error: 'HQ sign-in required' });
      if (ses.hqRole !== 'admin') return json(res, 403, { error: 'Only the HQ owner can manage Fire and Ambulance HQ accounts' });
      const map = Object.assign({}, kvGet(AGENCY_KEY, {}) || {});
      if (req.method === 'GET') return json(res, 200, { accounts: Object.values(map).map(a => ({ kind: a.kind, username: a.username, name: a.name, disabled: !!a.disabled, mustChange: !!a.mustChange, created: a.created, lastLogin: a.lastLogin || null })).sort((x, y) => (x.kind + x.username).localeCompare(y.kind + y.username)) });
      if (req.method === 'POST') {
        const b = await readBody(req), kind = String(b.kind || ''), act = String(b.action || 'create'), un = String(b.username || '').trim().toLowerCase(), id = kind + ':' + un;
        if (!['fire', 'ambulance'].includes(kind)) return json(res, 400, { error: 'Choose Fire or Ambulance' });
        if (!/^[a-z0-9._-]{3,32}$/.test(un)) return json(res, 400, { error: 'Username: 3-32 letters, digits, dot, dash or underscore' });
        if (!bump('agm|' + ses.user, 40, 3600000)) return json(res, 429, { error: 'Too many changes. Try again later.' });
        if (act === 'create') {
          if (map[id]) return json(res, 409, { error: 'That username already exists for this agency' });
          const name = clean(b.name, 80); if (name.length < 2) return json(res, 400, { error: 'Enter the person\'s full name' });
          if (Object.values(map).filter(a => a.kind === kind).length >= 30) return json(res, 400, { error: 'At most 30 HQ accounts per agency' });
          const pw = newPassphrase(), salt = crypto.randomBytes(16).toString('hex');
          map[id] = { kind, username: un, name, salt, hash: pwHash(pw, salt), mustChange: true, created: Date.now(), changed: Date.now(), createdBy: ses.user };
          kvSet(AGENCY_KEY, map); staffLog(ses, 'agency.account_created', id, name);
          return json(res, 200, { ok: true, kind, username: un, name, password: pw, note: 'Shown once. Hand it to the person; they must choose their own password at first sign-in.' });
        }
        const a = map[id]; if (!a) return json(res, 404, { error: 'No such HQ account' });
        if (act === 'reset') { const pw = newPassphrase(), salt = crypto.randomBytes(16).toString('hex'); map[id] = Object.assign({}, a, { salt, hash: pwHash(pw, salt), mustChange: true, changed: Date.now() + 1 }); kvSet(AGENCY_KEY, map); for (const kk of [...fails.keys()]) if (kk.endsWith('|agency|' + id)) fails.delete(kk); staffLog(ses, 'agency.password_reset', id, a.name); return json(res, 200, { ok: true, kind, username: un, name: a.name, password: pw, note: 'Shown once. They must choose their own password at next sign-in.' }); }
        if (act === 'disable' || act === 'enable') { map[id] = Object.assign({}, a, { disabled: act === 'disable', changed: Date.now() + 1 }); kvSet(AGENCY_KEY, map); staffLog(ses, 'agency.account_' + act + 'd', id, a.name); return json(res, 200, { ok: true }); }
        return json(res, 400, { error: 'Unknown action' });
      }
      return json(res, 405, { error: 'GET or POST only' });
    }
    if (p === '/api/agency/login' && req.method === 'POST') {
      const b = await readBody(req), kind = String(b.kind || ''), un = String(b.username || '').trim().toLowerCase(), id = kind + ':' + un, k = clientIp(req) + '|agency|' + id;
      if (!['fire', 'ambulance'].includes(kind)) return json(res, 400, { error: 'Unknown agency' });
      const wait = lockedOut(k); if (wait) return json(res, 429, { error: 'Too many failed attempts. Try again in ' + Math.ceil(wait / 60) + ' min.' });
      const map = kvGet(AGENCY_KEY, {}) || {}, a = map[id];
      const ok = a && eq(pwHash(String(b.password || ''), a.salt), a.hash); if (!a) pwHash(String(b.password || ''), OWNER_SALT);
      if (!ok) { noteFail(k); return json(res, 401, { error: 'Wrong username or password' }); }
      if (a.disabled) return json(res, 403, { error: 'This HQ account has been disabled by the national HQ.' });
      fails.delete(k); const m2 = Object.assign({}, map); m2[id] = Object.assign({}, a, { lastLogin: Date.now() }); store[AGENCY_KEY] = { value: m2, v: (store[AGENCY_KEY].v || 0) + 1, ts: Date.now() }; scheduleSave(AGENCY_KEY);
      return json(res, 200, { token: issue(res, req, { r: kind + '_hq', ak: kind, u: un, cn: a.name, mc: a.mustChange ? 1 : 0 }, SESSION_MS), kind, user: un, name: a.name, mustChange: !!a.mustChange, expires: Date.now() + SESSION_MS });
    }
    if (p === '/api/agency/logout' && req.method === 'POST') { const s = sessionOf(req, true); if (s) revoked.add(s.jti); res.setHeader('Set-Cookie', 'geams_t=; Path=/; HttpOnly; Max-Age=0'); return json(res, 200, { ok: true }); }
    if (p === '/api/agency/password' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || !AGENCY_ROLES.includes(ses.role)) return json(res, 401, { error: 'Sign in to the HQ first' });
      const id = ses.agency + ':' + ses.user, k = 'agpw|' + id; const wait = lockedOut(k); if (wait) return json(res, 429, { error: 'Too many attempts. Try again in ' + Math.ceil(wait / 60) + ' min.' });
      const b = await readBody(req), map = Object.assign({}, kvGet(AGENCY_KEY, {}) || {}), a = map[id];
      if (!a || !eq(pwHash(String(b.current || ''), a.salt), a.hash)) { noteFail(k); return json(res, 401, { error: 'Your current password is not right' }); }
      const np = String(b.password || ''); if (np.length < 10) return json(res, 400, { error: 'New password must be at least 10 characters' });
      if (np === String(b.current || '')) return json(res, 400, { error: 'Choose a password different from the current one' });
      fails.delete(k); const salt = crypto.randomBytes(16).toString('hex'); map[id] = Object.assign({}, a, { salt, hash: pwHash(np, salt), mustChange: false, changed: Date.now() }); kvSet(AGENCY_KEY, map);
      staffLog(ses, 'agency.password_changed', id, '');
      return json(res, 200, { ok: true, token: issue(res, req, { r: ses.agency + '_hq', ak: ses.agency, u: ses.user, cn: a.name }, SESSION_MS) });
    }
    if (p.startsWith('/api/agency/')) {
      const ses = sessionOf(req, req.method === 'GET'); if (!ses || !AGENCY_ROLES.includes(ses.role)) return json(res, 401, { error: 'Sign in to the Fire or Ambulance HQ' });
      if (ses.mc) return json(res, 403, { error: 'Choose your own password first' });
      const kind = ses.agency, U = UNIT[kind], KEY = (sid) => kind + ':' + sid + ':incidents', label = kind === 'fire' ? 'Fire' : 'Ambulance';
      const incs = () => { const out = []; for (const k of Object.keys(store)) { const m = /^(fire|ambulance):([^:]+):incidents$/.exec(k); if (!m || m[1] !== kind || !isObj(store[k].value)) continue; for (const [id, r] of Object.entries(store[k].value)) if (isObj(r) && !r.drill && !r.reassignedTo) out.push({ sid: m[2], id, r }); } return out; };
      const st = (r) => r.serviceStatus || 'new', tOf = (r) => (r.srv && r.srv.forwarded) || r.forwardedAt || 0;
      if (p === '/api/agency/overview' && req.method === 'GET') {
        const now = Date.now(), reg = kvGet('registry:stations', {}) || {}, loc = kvGet('registry:stationLocations', {}) || {}, crews = kvGet(U.key, []) || [], all = incs();
        const by = {}; const S = (sid) => by[sid] || (by[sid] = { sid, name: (reg[sid] && reg[sid].name) || sid, region: (reg[sid] && reg[sid].region) || '', town: (reg[sid] && reg[sid].town) || '', lat: null, lng: null, lcrOnline: lcrOnline(sid), crews: 0, crewsDisabled: 0, waiting: 0, active: 0, doneToday: 0, oldestWaitingSecs: 0 });
        for (const [sid, r] of Object.entries(reg)) { if (r && r.disabled) continue; const o = S(sid), l = loc[sid] || r; if (typeof l.lat === 'number' && typeof l.lng === 'number') { o.lat = l.lat; o.lng = l.lng; } }
        const ua = kvGet(UNIT_AUTH, {}); crews.forEach(c => { const o = S(c.lcrId); o.crews++; if ((ua[kind + ':' + c.badge] || {}).disabled) o.crewsDisabled++; });
        const day = now - 86400000, list = [];
        for (const { sid, id, r } of all) {
          const o = S(sid), s = st(r), t = tOf(r);
          if (s === 'new') { o.waiting++; o.oldestWaitingSecs = Math.max(o.oldestWaitingSecs, Math.round((now - t) / 1000)); }
          else if (s !== 'complete' && s !== 'reassigned') o.active++;
          else if (s === 'complete' && ((r.srv && r.srv.completed) || t) >= day) o.doneToday++;
          if (s !== 'complete' && s !== 'reassigned' ? true : ((r.srv && r.srv.completed) || t) >= now - 6 * 3600000) list.push({ sid, station: o.name, id, type: String(r.type || '').slice(0, 40), priority: String(r.priority || '').slice(0, 12), location: String(r.location || '').slice(0, 120), lat: typeof r.lat === 'number' ? r.lat : null, lng: typeof r.lng === 'number' ? r.lng : null, status: s, unit: r.unitName || null, unitBadge: r.unitBadge || null, eta: r.unitETA || null, forwardedAt: t, acceptedAt: (r.srv && r.srv.accepted) || null, reassignedTo: r.reassignedTo || null, reassignedFrom: r.reassignedFrom || null, closeNote: r.closeNote ? String(r.closeNote).slice(0, 200) : null, completedAt: (r.srv && r.srv.completed) || null, closeReason: r.closeReason || null, closedBy: r.closedByHq ? 'HQ' : r.closedByCrew ? 'crew' : null, waitedSecs: s === 'new' ? Math.round((now - t) / 1000) : null,
            unitLat: typeof r.unitLat === 'number' ? r.unitLat : null, unitLng: typeof r.unitLng === 'number' ? r.unitLng : null, etaSource: r.etaSource || null, etaTarget: r.etaTarget || null, etaKm: typeof r.etaKm === 'number' ? r.etaKm : null, leg: r.leg || null, posAt: (r.srv && r.srv.posAt) || null, posAgeSecs: (r.srv && r.srv.posAt) ? Math.round((now - r.srv.posAt) / 1000) : null, positionStale: s === 'en_route' && (!(r.srv && r.srv.posAt) || now - r.srv.posAt > 60000), departedAt: (r.srv && r.srv.departed) || null, pickedUpAt: (r.srv && r.srv.pickedUp) || null,
            transfer: isObj(r.transfer) ? { from: r.transfer.from, to: r.transfer.to, patient: r.transfer.patient || '', needs: r.transfer.needs || '', contact: r.transfer.contact || '' } : null });
        }
        list.sort((a, b) => (a.status === 'new' ? 0 : 1) - (b.status === 'new' ? 0 : 1) || b.forwardedAt - a.forwardedAt);
        const esc = Object.values(kvGet('registry:agencyEscalations', {}) || {}).filter(e => e.kind === kind && e.open).map(e => ({ key: e.key, sid: e.sid, station: e.station, id: e.ref, type: e.type, priority: e.priority, since: e.since, flaggedAt: e.flaggedAt, waitedSecs: e.waitedSecs || null, reason: e.reason, neighbours: e.neighbours || [], ackBy: e.ackBy || null, ackAt: e.ackAt || null }));
        const bc = kvGet('agency:' + kind + ':broadcast', null);
        return json(res, 200, { kind, label, user: ses.user, name: ses.name, now, refreshesEverySecs: 3, stations: Object.values(by).sort((a, b) => (b.waiting - a.waiting) || (b.active - a.active) || a.name.localeCompare(b.name)), incidents: list.slice(0, 400), escalations: esc, thresholdSecs: AG_ESC().secs, broadcasts: bc && Array.isArray(bc.items) ? bc.items.slice(-5).reverse() : [],
          pendingSignups: Object.values(kvGet(UNIT_PENDING, {}) || {}).filter(x => x.kind === kind).length,
          unreadChat: Object.entries(kvGet(CHAT_KEY, {}) || {}).filter(([k]) => k.startsWith(kind + ':')).reduce((n, [, t]) => n + t.items.filter(m => m.from === 'crew' && m.at > (t.hqReadAt || 0)).length, 0), totals: { stations: Object.keys(by).length, stationsOnline: Object.values(by).filter(x => x.lcrOnline).length, crewAccounts: crews.length, waiting: list.filter(x => x.status === 'new').length, active: list.filter(x => !['new', 'complete', 'reassigned'].includes(x.status)).length },
          note: 'Counts come from alerts that control rooms forwarded to ' + label.toLowerCase() + ' crews. Crew numbers are accounts, not who is on shift. This screen refreshes about every 3 seconds; it is not a push alert, so keep it open or use the escalation warnings.' });
      }
      if (p === '/api/agency/reassign' && req.method === 'POST') {
        const b = await readBody(req), from = String(b.sid || ''), to = String(b.toSid || ''), id = String(b.id || '');
        const reg = kvGet('registry:stations', {}) || {}; if (!reg[to] || reg[to].disabled) return json(res, 404, { error: 'Unknown destination station' }); if (from === to) return json(res, 400, { error: 'Choose a different station' });
        const src = kvGet(KEY(from), null), rec = isObj(src) ? src[id] : null; if (!isObj(rec)) return json(res, 404, { error: 'That alert was not found at the first station' });
        if (st(rec) !== 'new') return json(res, 409, { error: 'A crew has already taken this alert (' + st(rec).replace('_', ' ') + '). It cannot be moved now.' });
        const dest = Object.assign({}, kvGet(KEY(to), {}) || {}); if (dest[id]) return json(res, 409, { error: 'That station already has this alert' });
        const now = Date.now(), nm = (reg[to] && reg[to].name) || to;
        dest[id] = Object.assign({}, rec, { serviceStatus: 'new', stationId: to, stationName: nm, reassignedFrom: from, reassignedFromName: (reg[from] && reg[from].name) || from, reassignedBy: ses.user, reassignedAt: now, unitName: null, unitBadge: null, unitETA: null, unitLat: null, unitLng: null, srv: { forwarded: now } });
        const s2 = Object.assign({}, src); s2[id] = Object.assign({}, rec, { serviceStatus: 'reassigned', reassignedTo: to, reassignedToName: nm, reassignedBy: ses.user, reassignedAt: now });
        kvSet(KEY(to), dest); kvSet(KEY(from), s2); staffLog(ses, 'agency.reassign', id, kind + ' → ' + to, from);
        return json(res, 200, { ok: true, id, from, to, toName: nm });
      }
      if (p === '/api/agency/incident/close' && req.method === 'POST') {          // the HQ resolves or closes an alert: done, false alarm, duplicate or cancelled
        const b = await readBody(req), sid = String(b.sid || ''), id = String(b.id || ''), reason = String(b.reason || '');
        if (!['resolved', 'false_alarm', 'duplicate', 'cancelled'].includes(reason)) return json(res, 400, { error: 'Choose a reason: resolved, false alarm, duplicate or cancelled' });
        const map = kvGet(KEY(sid), null), rec = isObj(map) ? map[id] : null; if (!isObj(rec)) return json(res, 404, { error: 'That alert was not found' });
        if (['complete', 'reassigned'].includes(st(rec))) return json(res, 409, { error: 'That alert is already ' + (st(rec) === 'complete' ? 'closed' : 'moved to another station') });
        const now = Date.now(), n = Object.assign({}, map), sv = Object.assign({}, isObj(rec.srv) ? rec.srv : {}); if (!sv.completed) sv.completed = now; if (!sv.accepted && st(rec) !== 'new') sv.accepted = now;
        n[id] = Object.assign({}, rec, { serviceStatus: 'complete', closedByHq: true, closeReason: reason, closeNote: clean(b.note, 200), closedBy: ses.user, closedAt: now, srv: sv });
        kvSet(KEY(sid), n); staffLog(ses, 'agency.close', id, kind + ' ' + reason + (b.note ? ' (note)' : ''), sid);
        return json(res, 200, { ok: true, id, reason });
      }
      if (p === '/api/agency/escalation/ack' && req.method === 'POST') {
        const b = await readBody(req), map = Object.assign({}, kvGet('registry:agencyEscalations', {}) || {}), e = map[String(b.key || '')]; if (!e || e.kind !== kind) return json(res, 404, { error: 'Unknown warning' });
        e.ackBy = ses.user; e.ackAt = Date.now(); e.ackNote = clean(b.note, 160); kvSet('registry:agencyEscalations', map); staffLog(ses, 'agency_' + kind + '.ack', e.ref, e.ackNote ? 'note' : '', e.sid); return json(res, 200, { ok: true });
      }
      if (p === '/api/agency/broadcast' && req.method === 'POST') {
        const b = await readBody(req), msg = clean(b.message, 300); if (msg.length < 3) return json(res, 400, { error: 'Write a message (at least 3 characters)' });
        if (!bump('agb|' + ses.user, 20, 3600000)) return json(res, 429, { error: 'Too many messages. Try again later.' });
        const sid = String(b.sid || ''); if (sid && !(kvGet('registry:stations', {}) || {})[sid]) return json(res, 404, { error: 'Unknown station' });
        const cur = kvGet('agency:' + kind + ':broadcast', null), items = cur && Array.isArray(cur.items) ? cur.items.slice(-29) : [];
        const item = { id: crypto.randomBytes(6).toString('hex'), at: Date.now(), by: ses.name || ses.user, priority: b.priority === 'urgent' ? 'urgent' : 'info', message: msg, sid: sid || null, sidName: sid ? stationMeta(sid).name : null };
        items.push(item); kvSet('agency:' + kind + ':broadcast', { items }); staffLog(ses, 'agency_' + kind + '.broadcast', item.id, item.priority + (sid ? ' (one station)' : ' (all stations)'), sid || null);
        return json(res, 200, { ok: true, item });
      }
      if (p === '/api/agency/crew' && req.method === 'GET') {
        const ua = kvGet(UNIT_AUTH, {}), reg = kvGet('registry:stations', {}) || {}, all = incs();
        const list = (kvGet(U.key, []) || []).map(c => { const a = ua[kind + ':' + c.badge] || {}, job = all.find(x => x.r.unitBadge === c.badge && !['new', 'complete', 'reassigned'].includes(st(x.r)));
          return { badge: c.badge, name: c.name, rank: c.rank || '', phone: c.phone || '', vehicle: c.vehicle || '', sid: c.lcrId, station: (reg[c.lcrId] && reg[c.lcrId].name) || c.lcrId, disabled: !!a.disabled, mustChange: !!a.mustChange, onJob: job ? { id: job.id, status: st(job.r) } : null }; });
        const pend = Object.values(kvGet(UNIT_PENDING, {})).filter(x => x.kind === kind).map(x => ({ badge: x.cred.badge, name: x.cred.name, phone: x.cred.phone, rank: x.cred.rank, sid: x.cred.lcrId, station: (reg[x.cred.lcrId] && reg[x.cred.lcrId].name) || x.cred.lcrId, requestedAt: x.requestedAt }));
        return json(res, 200, { kind, crews: list, pending: pend });
      }
      if (p === '/api/agency/crew/update' && req.method === 'POST') {          // disable, enable or move one crew member
        const b = await readBody(req), badge = String(b.badge || ''), act = String(b.action || ''), list = (kvGet(U.key, []) || []).slice(), i = list.findIndex(x => x.badge === badge);
        if (i < 0) return json(res, 404, { error: 'No such crew member' }); const id = kind + ':' + badge, ua = Object.assign({}, kvGet(UNIT_AUTH, {})), cur = ua[id] || {};
        if (act === 'disable' || act === 'enable') {
          if (act === 'disable') ua[id] = Object.assign({}, cur, { disabled: Date.now(), disabledBy: ses.user, changed: Date.now() + 1 }); else { ua[id] = Object.assign({}, cur); delete ua[id].disabled; delete ua[id].disabledBy; }
          kvSet(UNIT_AUTH, ua); staffLog(ses, 'crew.' + act + 'd', id, list[i].name, list[i].lcrId); return json(res, 200, { ok: true });
        }
        if (act === 'move') {
          const to = String(b.toSid || ''), reg = kvGet('registry:stations', {}) || {}; if (!reg[to] || reg[to].disabled) return json(res, 404, { error: 'Unknown destination station' }); const was = list[i].lcrId;
          list[i] = Object.assign({}, list[i], { lcrId: to }); ua[id] = Object.assign({}, cur, { changed: Date.now() + 1 }); kvSet(U.key, list); kvSet(UNIT_AUTH, ua);
          staffLog(ses, 'crew.moved', id, was + ' → ' + to, to); return json(res, 200, { ok: true, note: 'They are signed out and must sign in again to work for the new station.' });
        }
        return json(res, 400, { error: 'Unknown action' });
      }
      if (p === '/api/agency/report' && req.method === 'GET') {
        const days = Math.min(Math.max(parseInt(u.searchParams.get('days'), 10) || 30, 1), 400), from = Date.now() - days * 86400000, reg = kvGet('registry:stations', {}) || {};
        const byType = {}, byPrio = {}, byStatus = {}, byHour = Array(24).fill(0), per = {}, acc = [], arr = [], tTransit = [], tPickup = []; let total = 0, reassigned = 0, tCount = 0, tDone = 0;
        for (const { sid, id, r } of incs()) {
          const t = tOf(r); if (t < from) continue; total++; const s = st(r); if (r.reassignedFrom) reassigned++;
          const ty = String(r.type || 'unknown').slice(0, 40); byType[ty] = (byType[ty] || 0) + 1; byPrio[r.priority || 'unknown'] = (byPrio[r.priority || 'unknown'] || 0) + 1; byStatus[s] = (byStatus[s] || 0) + 1; byHour[new Date(t).getUTCHours()]++;
          const o = per[sid] || (per[sid] = { sid, station: (reg[sid] && reg[sid].name) || sid, n: 0, accepted: [], onScene: [] }); o.n++;
          const sv = r.srv || {}; if (isObj(r.transfer)) { tCount++; if (s === 'complete') tDone++; if (sv.pickedUp && sv.completed && sv.completed >= sv.pickedUp) tTransit.push((sv.completed - sv.pickedUp) / 60000); if (sv.accepted && sv.onScene && sv.onScene >= sv.accepted) tPickup.push((sv.onScene - sv.accepted) / 60000); }
          if (sv.accepted && sv.forwarded) { const d = (sv.accepted - sv.forwarded) / 1000; if (d >= 0) { acc.push(d); o.accepted.push(d); } } if (sv.onScene && sv.forwarded) { const d = (sv.onScene - sv.forwarded) / 1000; if (d >= 0) { arr.push(d); o.onScene.push(d); } }
        }
        const esc = Object.values(kvGet('registry:agencyEscalations', {}) || {}).filter(e => e.kind === kind && e.flaggedAt >= from);
        return json(res, 200, { schema: 'geams.agencyreport.v1', kind, generatedAt: new Date().toISOString(), windowDays: days,
          alerts: { forwarded: total, reassignedBetweenStations: reassigned, byType, byPriority: byPrio, byStatus, byHourUTC: byHour },
          speed: { secondsToAcceptMedian: median(acc), secondsToAcceptP90: pctl(acc, 0.9), measuredAccept: acc.length, secondsToOnSceneMedian: median(arr), measuredOnScene: arr.length },
          transfers: kind === 'ambulance' ? { created: tCount, delivered: tDone, minutesToReachPickupMedian: median(tPickup), minutesInTransitMedian: median(tTransit), measuredInTransit: tTransit.length } : undefined,
          unansweredWarnings: { total: esc.length, stillOpen: esc.filter(e => e.open).length },
          stations: Object.values(per).map(o => ({ sid: o.sid, station: o.station, forwarded: o.n, secondsToAcceptMedian: median(o.accepted), measuredAccept: o.accepted.length })).sort((a, b) => b.forwarded - a.forwarded),
          crewAccounts: (kvGet(U.key, []) || []).length,
          notMeasured: ['Alerts that no control room forwarded to ' + label.toLowerCase() + ' crews (for example a call handled by phone only).', 'Whether help arrived in time or the outcome for the patient or property: GEAMS records only what staff tap.', 'Times before the server stamped them (older records show no figures instead of a guess).'] });
      }
      if (p === '/api/agency/activity' && req.method === 'GET') {              // automatic log: built from what the crews and the server stamped on each alert, nothing typed by anyone
        const reg = kvGet('registry:stations', {}) || {}, since = Date.now() - 48 * 3600000, ev = [];
        const OUTL = { resolved: 'Resolved', handed_over: 'Handed over', not_resolved: 'NOT resolved - follow up', false_alarm: 'False alarm', cannot_reach: 'Could not attend', cancelled: 'Cancelled', duplicate: 'Duplicate' };
        for (const { sid, id, r } of incs()) {
          const sv = isObj(r.srv) ? r.srv : {}, base = { sid, station: (reg[sid] && reg[sid].name) || sid, id, type: String(r.type || '').slice(0, 40), location: String(r.location || '').slice(0, 80) }, unit = String(r.unitName || '').slice(0, 60);
          const add = (at, event, by, detail) => { if (at && at >= since) ev.push(Object.assign({}, base, { at, event, by: by || 'system', detail: detail || '' })); };
          add(sv.forwarded || r.forwardedAt, r.reassignedFrom ? 'Alert moved here from another station' : 'Alert received', r.forwardedBy || 'control room', r.priority ? 'priority ' + r.priority : '');
          add(sv.accepted, 'Accepted by crew', unit, '');
          add(sv.departed, 'Crew en route', unit, r.transfer ? 'to ' + (r.transfer.from && r.transfer.from.name || 'pickup') : '');
          add(sv.pickedUp, 'Patient on board', unit, r.transfer ? 'heading to ' + (r.transfer.to && r.transfer.to.name || 'destination') : '');
          add(sv.atDestination, 'Arrived at destination', unit, r.transfer && r.transfer.to ? r.transfer.to.name : '');
          add(sv.onScene, 'Crew on scene', unit, '');
          add(sv.completed, r.closedByHq ? 'Closed by HQ' : r.closedByCrew ? 'Crew reported call ended' : 'Call completed', r.closedByHq ? String(r.closedBy || 'HQ') : unit, (OUTL[r.closeReason] || (r.closeReason ? String(r.closeReason).slice(0, 30) : 'no outcome given')) + (r.closeNote ? ' - ' + String(r.closeNote).slice(0, 200) : ''));
          if (r.reassignedFrom) add(sv.forwarded || r.forwardedAt, 'Reassigned by HQ', 'HQ', 'from ' + ((reg[r.reassignedFrom] && reg[r.reassignedFrom].name) || r.reassignedFrom));
        }
        ev.sort((x, y) => y.at - x.at);
        return json(res, 200, { total: ev.length, items: ev.slice(0, Math.min(+u.searchParams.get('limit') || 300, 1000)), note: 'Built automatically from the times the server stamped on each alert; covers the last 48 hours.' });
      }
      if (p === '/api/agency/log' && req.method === 'GET') {
        const l = kvGet('registry:staffLog', []).filter(x => x.role === ses.role || (x.ref && String(x.ref).startsWith(kind + ':')) || String(x.action).startsWith('agency_' + kind) || (x.action === 'incident.update' && false));
        return json(res, 200, { total: l.length, items: l.slice().reverse().slice(0, Math.min(+u.searchParams.get('limit') || 200, 1000)) });
      }
      if (p === '/api/agency/chat') {
        const all = kvGet(CHAT_KEY, {}) || {}, badge = u.searchParams.get('badge');
        if (req.method === 'GET' && !badge) {
          const crews = kvGet(U.key, []) || [], reg = kvGet('registry:stations', {}) || {};
          const threads = Object.entries(all).filter(([k]) => k.startsWith(kind + ':')).map(([k, t]) => { const b = k.slice(kind.length + 1), c = crews.find(x => x.badge === b), last = t.items[t.items.length - 1]; return { badge: b, name: c ? c.name : b, station: c ? ((reg[c.lcrId] && reg[c.lcrId].name) || c.lcrId) : '', last: last ? { at: last.at, from: last.from, text: last.text.slice(0, 80) } : null, unread: t.items.filter(m => m.from === 'crew' && m.at > (t.hqReadAt || 0)).length }; }).sort((a, b) => ((b.last && b.last.at) || 0) - ((a.last && a.last.at) || 0));
          return json(res, 200, { threads, unread: threads.reduce((n, t) => n + t.unread, 0) });
        }
        if (req.method === 'GET') { if (!(kvGet(U.key, []) || []).some(x => x.badge === badge)) return json(res, 404, { error: 'No such crew member' }); const t = chatThread(kind, badge), c = Object.assign({}, all);
          if (u.searchParams.get('read') === '1' && all[kind + ':' + badge]) { c[kind + ':' + badge] = Object.assign({}, t, { hqReadAt: Date.now() }); kvSet(CHAT_KEY, c); } return json(res, 200, chatOut(t, 'hq')); }
        if (req.method === 'POST') { const b = await readBody(req), bd = String(b.badge || ''), text = clean(b.message, 500); if (!(kvGet(U.key, []) || []).some(x => x.badge === bd)) return json(res, 404, { error: 'No such crew member' }); if (text.length < 1) return json(res, 400, { error: 'Write a message' });
          if (!bump('hqm|' + ses.user, 120, 600000)) return json(res, 429, { error: 'Too many messages. Wait a few minutes.' });
          const t = chatPost(kind, bd, 'hq', ses.name || ses.user, text, 'hqReadAt'); return json(res, 200, Object.assign({ ok: true }, chatOut(t, 'hq'))); }
        return json(res, 405, { error: 'GET or POST only' });
      }
      if (p === '/api/agency/transfer/create' && req.method === 'POST') {      // Ambulance HQ: collect a patient at one hospital and deliver them to another
        if (kind !== 'ambulance') return json(res, 403, { error: 'Patient transfers are an Ambulance HQ function' });
        const b = await readBody(req), sid = String(b.sid || ''), reg = kvGet('registry:stations', {}) || {}; if (!reg[sid] || reg[sid].disabled) return json(res, 404, { error: 'Choose the ambulance station whose crew will do the transfer' });
        const hosp = (h, what) => { h = isObj(h) ? h : {}; const o = { name: clean(h.name, 100), address: clean(h.address, 160), lat: Number(h.lat), lng: Number(h.lng) }; if (o.name.length < 2) return { error: 'Name the ' + what + ' hospital' }; if (!Number.isFinite(o.lat) || !Number.isFinite(o.lng) || Math.abs(o.lat) > 90 || Math.abs(o.lng) > 180 || (o.lat === 0 && o.lng === 0)) return { error: 'The ' + what + ' hospital needs a position on the map, so the ambulance can be tracked to it' }; return o; };
        const from = hosp(b.from, 'pickup'); if (from.error) return json(res, 400, { error: from.error }); const to = hosp(b.to, 'destination'); if (to.error) return json(res, 400, { error: to.error });
        const dx = (from.lat - to.lat) * 111000, dy = (from.lng - to.lng) * 111000 * Math.cos(from.lat * Math.PI / 180); if (Math.hypot(dx, dy) < 100 && from.name.toLowerCase() === to.name.toLowerCase()) return json(res, 400, { error: 'Pickup and destination are the same place' });
        if (!bump('agt|' + ses.user, 30, 3600000)) return json(res, 429, { error: 'Too many transfers created. Try again later.' });
        const pr = ['critical', 'high', 'medium', 'low'].includes(b.priority) ? b.priority : 'medium', now = Date.now(), id = 'HQ-AMB-T' + now.toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(), nm = (reg[sid] && reg[sid].name) || sid;
        const cur = Object.assign({}, kvGet(KEY(sid), {}) || {});
        cur[id] = { id, type: 'Patient transfer', priority: pr, location: 'Pickup: ' + from.name + (from.address ? ', ' + from.address : ''), lat: from.lat, lng: from.lng, civilianName: null, civilianPhone: null, notes: 'Deliver to ' + to.name + (to.address ? ', ' + to.address : ''), transfer: { from, to, patient: clean(b.patient, 120), needs: clean(b.needs, 200), contact: clean(b.contact, 40) }, leg: 'to_pickup', forwardedAt: now, forwardedBy: 'Ambulance HQ (' + (ses.name || ses.user) + ')', stationId: sid, stationName: nm, serviceStatus: 'new', unitName: null, unitBadge: null, unitETA: null, unitLat: null, unitLng: null, createdByHq: ses.user, srv: { forwarded: now } };
        kvSet(KEY(sid), cur); staffLog(ses, 'agency_ambulance.transfer_created', id, from.name + ' → ' + to.name + ' · ' + pr, sid);
        return json(res, 200, { ok: true, id, station: nm, note: 'Sent to ' + nm + ' ambulance crews. The first crew to accept it collects the patient from ' + from.name + ' and delivers to ' + to.name + '.' });
      }
      if (p === '/api/agency/incident/create' && req.method === 'POST') {      // the HQ raises an alert straight to one station's crews, without a control room
        const b = await readBody(req), sid = String(b.sid || ''), reg = kvGet('registry:stations', {}) || {}; if (!reg[sid] || reg[sid].disabled) return json(res, 404, { error: 'Choose a station' });
        const type = clean(b.type, 40), loc = clean(b.location, 160), notes = clean(b.notes, 400), pr = ['critical', 'high', 'medium', 'low'].includes(b.priority) ? b.priority : 'high';
        if (type.length < 2) return json(res, 400, { error: 'Choose what kind of alert this is' }); if (loc.length < 3) return json(res, 400, { error: 'Describe where it is' });
        if (!bump('agi|' + ses.user, 30, 3600000)) return json(res, 429, { error: 'Too many alerts created. Try again later.' });
        const lat = Number(b.lat), lng = Number(b.lng), hasPos = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
        const now = Date.now(), id = 'HQ-' + kind.toUpperCase().slice(0, 3) + '-' + now.toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(), nm = (reg[sid] && reg[sid].name) || sid;
        const cur = Object.assign({}, kvGet(KEY(sid), {}) || {});
        cur[id] = { id, type, priority: pr, location: loc, lat: hasPos ? lat : null, lng: hasPos ? lng : null, civilianName: null, civilianPhone: null, notes, forwardedAt: now, forwardedBy: label + ' HQ (' + (ses.name || ses.user) + ')', stationId: sid, stationName: nm, serviceStatus: 'new', unitName: null, unitBadge: null, unitETA: null, unitLat: null, unitLng: null, createdByHq: ses.user, srv: { forwarded: now } };
        kvSet(KEY(sid), cur); staffLog(ses, 'agency_' + kind + '.incident_created', id, type + ' · ' + pr, sid);
        return json(res, 200, { ok: true, id, station: nm, note: 'Sent to ' + nm + ' crews. It did not come through a control room, so the control room does not have it on its own screen.' });
      }
      if (p === '/api/agency/backup' && req.method === 'POST') {            // a file of this agency's own data, encrypted with a passphrase only the HQ knows
        const b = await readBody(req), pass = String(b.passphrase || ''); if (pass.length < 10) return json(res, 400, { error: 'Choose a passphrase of at least 10 characters. You will need it to open the file.' });
        if (!bump('agbk|' + ses.user, 6, 3600000)) return json(res, 429, { error: 'Too many backups requested. Try again later.' });
        const reg = kvGet('registry:stations', {}) || {}, inc = {}; for (const k of Object.keys(store)) { const m = /^(fire|ambulance):([^:]+):incidents$/.exec(k); if (m && m[1] === kind) inc[m[2]] = store[k].value; }
        const doc = { schema: 'geams.agencybackup.v1', kind, takenAt: new Date().toISOString(), by: ses.user, stations: Object.fromEntries(Object.entries(reg).map(([id, r]) => [id, { name: r.name, region: r.region, town: r.town }])),
          crews: (kvGet(U.key, []) || []), incidents: inc, broadcasts: kvGet('agency:' + kind + ':broadcast', null) };
        const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), key = crypto.scryptSync(pass, salt, 32), c = crypto.createCipheriv('aes-256-gcm', key, iv), enc = Buffer.concat([c.update(Buffer.from(JSON.stringify(doc), 'utf8')), c.final()]), tag = c.getAuthTag();
        const out = Buffer.concat([Buffer.from('GEAMSAG1'), salt, iv, tag, enc]); staffLog(ses, 'agency_' + kind + '.backup', null, Math.round(out.length / 1024) + ' KB');
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': out.length, 'Content-Disposition': 'attachment; filename="geams-' + kind + '-hq-backup-' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 13) + 'Z.enc"', 'Cache-Control': 'no-store' });
        return res.end(out);
      }
      return json(res, 404, { error: 'Unknown HQ endpoint' });
    }
    // ── Civilian account recovery: a code only the owner holds moves the account to a new phone ──
    if (p === '/api/civilian/recovery/create' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'civilian' || !ses.dev) return json(res, 401, { error: 'Sign in as a civilian' });
      if (!bump('rcc|' + ses.dev, 10, 3600000)) return json(res, 429, { error: 'Too many attempts. Try again later.' });
      const b = await readBody(req), id = String(b.civilianId || ''); if (!/^CIV-\d{3,8}$/.test(id)) return json(res, 400, { error: 'Bad account id' });
      const pf = kvGet('registry:civilians', {})[id]; if (!pf) return json(res, 404, { error: 'Your account is not saved on the server yet. Open Profile and save it first.' });
      if (pf.ownerDev !== ses.dev) return json(res, 403, { error: 'That account belongs to another phone' });
      const raw = crypto.randomBytes(15), c = [...raw].map(x => ALPHA[x % ALPHA.length]).join(''), code = c.slice(0, 5) + '-' + c.slice(5, 10) + '-' + c.slice(10, 15);
      const salt = crypto.randomBytes(16).toString('hex'), rm = Object.assign({}, kvGet('registry:civRecovery', {})); rm[id] = { salt, hash: pwHash(code, salt), createdAt: Date.now() };
      kvSet('registry:civRecovery', rm); console.log('civilian recovery code created for ' + id);
      return json(res, 200, { ok: true, code, note: 'Shown once. Keep it somewhere safe that is not only on this phone.' });
    }
    if (p === '/api/civilian/recovery/restore' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'civilian' || !ses.dev) return json(res, 401, { error: 'Sign in as a civilian' });
      if (!bump('rcr|' + clientIp(req), 20, 3600000)) return json(res, 429, { error: 'Too many attempts from this address. Try again later.' });
      const b = await readBody(req), id0 = String(b.civilianId || '').trim().toUpperCase(), code = String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{5})(.{5})(.{5})$/, '$1-$2-$3');
      let idv = id0;
      if (b.viaPhone && !idv && ses.verified && ses.phone) { const pm0 = kvGet('registry:civilians', {}), hit = Object.entries(pm0).filter(([, x]) => x && normPhone(x.phone) === ses.phone).map(([k]) => k); if (hit.length === 1) idv = hit[0]; else return json(res, hit.length ? 409 : 404, { error: hit.length ? 'More than one account uses this number. Enter your account number (CIV-…) as well.' : 'No GEAMS account was registered with this phone number.' }); }
      if (!/^CIV-\d{3,8}$/.test(idv)) return json(res, 400, { error: 'Enter your account number (it looks like CIV-12345)' });
      const id = idv, lk = 'rcl|' + idv; const wait = lockedOut(lk); if (wait) return json(res, 429, { error: 'Too many wrong codes for this account. Try again in ' + Math.ceil(wait / 60) + ' min.' });
      const rm = Object.assign({}, kvGet('registry:civRecovery', {})), r = rm[id], pm = kvGet('registry:civilians', {}), pf = pm[id];
      let okBy = null;
      if (pf && r && eq(pwHash(code, r.salt), r.hash)) okBy = 'code';
      else if (pf && ses.verified && ses.phone && normPhone(pf.phone) === ses.phone && b.viaPhone) okBy = 'verified phone';
      if (!okBy) { const f = fails.get(lk) || { n: 0, until: 0 }; f.n++; if (f.n >= 5) { f.until = Date.now() + 3600000; f.n = 0; } fails.set(lk, f); console.log('civilian recovery FAILED for ' + id); return json(res, 401, { error: 'That account number and code do not match' }); }
      fails.delete(lk);
      // move everything that belonged to the old phone: profile, face record, alerts this person raised
      const old = pf.ownerDev; pm[id] = Object.assign({}, pf, { ownerDev: ses.dev, updatedAt: Date.now() }); kvSet('registry:civilians', pm);
      const fm = Object.assign({}, kvGet('registry:faces', {})); const hasFace = !!fm[id]; if (hasFace) { fm[id] = Object.assign({}, fm[id], { ownerDev: ses.dev }); kvSet('registry:faces', fm); }
      let moved = 0;
      for (const key of incidentKeys()) { const map = store[key].value; if (!isObj(map)) continue; let ch = false; const nm = Object.assign({}, map);
        for (const [iid, rec] of Object.entries(nm)) if (rec && rec.civilianId === id && rec.ownerDev !== ses.dev) { nm[iid] = Object.assign({}, rec, { ownerDev: ses.dev }); ch = true; moved++; }
        if (ch) kvSet(key, nm); }
      delete rm[id]; const raw = crypto.randomBytes(15), c = [...raw].map(x => ALPHA[x % ALPHA.length]).join(''), fresh = c.slice(0, 5) + '-' + c.slice(5, 10) + '-' + c.slice(10, 15), salt = crypto.randomBytes(16).toString('hex');
      rm[id] = { salt, hash: pwHash(fresh, salt), createdAt: Date.now(), restoredAt: Date.now() }; kvSet('registry:civRecovery', rm);
      console.log('civilian account restored: ' + id + ' via ' + okBy + ', ' + moved + ' alert(s) moved' + (old === ses.dev ? ' (same phone)' : ''));
      return json(res, 200, { ok: true, newCode: fresh, alertsMoved: moved, faceEnrolled: hasFace, profile: { id, name: pf.name, phone: pf.phone, ghCard: pf.ghCard, address: pf.address, lat: pf.lat, lng: pf.lng, registeredDate: pf.registeredDate } });
    }
    // ── Civilian device session (open sign-in, no identity proof yet: phone verification is planned) ──
    if (p === '/api/civilian/session' && req.method === 'POST') {
      if (!bump('civ|' + clientIp(req), +process.env.GEAMS_CIV_SESSION_LIMIT || 120, 10 * 60000)) return json(res, 429, { error: 'Too many sessions from this address. Try again shortly.' });
      let sb = {}; try { sb = await readBody(req); } catch (e) {}
      return json(res, 200, { token: issue(res, req, { r: 'civilian', u: 'civilian', d: devHash(sb.secret) }, LONG_MS) });
    }
    // ── Storage health and backups (HQ; running or downloading a backup is for the HQ owner) ──
    if (p === '/api/hq/rotate-tokens' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'hq' || ses.hqRole !== 'admin') return json(res, 403, { error: 'Only the HQ owner can rotate tokens' });
      kvSet('registry:authEpoch', { at: Date.now(), by: ses.user });
      console.log('TOKENS ROTATED by ' + ses.user); staffLog(ses, 'tokens.rotated', null, '');
      return json(res, 200, { ok: true, at: Date.now(), note: 'Every control-room, officer, fire and ambulance sign-in is now invalid. They must sign in again. HQ and civilian sessions are unaffected.' });
    }
    if (p === '/api/hq/lockdown' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'hq' || ses.hqRole !== 'admin') return json(res, 403, { error: 'Only the HQ owner can change lockdown' });
      const b = await readBody(req); const on = !!b.on;
      kvSet('hq:lockdown', on ? { on: true, since: Date.now(), by: ses.user, reason: String(b.reason || '').slice(0, 200) } : { on: false, lifted: Date.now(), by: ses.user });
      console.log('LOCKDOWN ' + (on ? 'ON' : 'OFF') + ' by ' + ses.user); staffLog(ses, on ? 'lockdown.on' : 'lockdown.off', null, String(b.reason || '').slice(0, 100));
      return json(res, 200, { ok: true, on });
    }
    if (p === '/api/hq/pilot' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'hq' || ses.hqRole !== 'admin') return json(res, 403, { error: 'Only the HQ owner can pause or resume civilian alerts' });
      const b = await readBody(req), paused = !!b.paused; let msg = String(b.message || '').replace(/[<>]/g, '').trim().slice(0, 240);
      if (paused && !/112/.test(msg)) msg = (msg ? msg + ' ' : '') + 'If this is an emergency, call 112 now.';
      kvSet('hq:pilot', paused ? { paused: true, message: msg, since: Date.now(), by: ses.user } : { paused: false, resumed: Date.now(), by: ses.user });
      console.log('CIVILIAN ALERTS ' + (paused ? 'PAUSED' : 'RESUMED') + ' by ' + ses.user); staffLog(ses, paused ? 'pilot.paused' : 'pilot.resumed', null, paused ? 'message set' : '');
      return json(res, 200, { ok: true, paused });
    }
    if (p === '/api/retention/preview' && req.method === 'GET') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'hq' || ses.hqRole !== 'admin') return json(res, 403, { error: 'Only the HQ owner can use data retention' });
      const pl = retentionPlan(); return json(res, 200, { policy: pl.policy, willAnonymise: pl.anonymise.length, willPurge: pl.purge.length, onLegalHold: pl.held, openIncidentsSkipped: pl.activeSkipped, faceChecksToRemove: pl.faceAuditOld, sample: pl.purge.concat(pl.anonymise).slice(0, 20), databaseConfigured: WRITER.enabled, log: kvGet('registry:retentionLog', []).slice(-10).reverse(),
        note: 'A backup is taken first and keeps the old data until it is rotated out (GEAMS_BACKUP_KEEP). ' + (WRITER.enabled ? 'Purged files are overwritten in the database, not deleted.' : 'Purged files are deleted from this server.') });
    }
    if (p === '/api/retention/run' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'hq' || ses.hqRole !== 'admin') return json(res, 403, { error: 'Only the HQ owner can use data retention' });
      const b = await readBody(req); if (b.confirm !== true) return json(res, 400, { error: 'Send confirm:true to run' });
      const pl = retentionPlan(); if (!(pl.anonymise.length || pl.purge.length || pl.faceAuditOld)) return json(res, 200, { ok: true, result: { anonymised: 0, purged: 0, keysCleared: 0, filesWiped: 0, faceAuditRemoved: 0 }, note: 'Nothing is due under the current policy.' });
      let backup = null; if (!b.skipBackup) { try { backup = await runBackup('before-retention:' + ses.user); } catch (e) { return json(res, 500, { error: 'Not run: the safety backup failed (' + e.message + '). Nothing was changed.' }); } }
      { const rr = retentionRun('hq:' + ses.user); staffLog(ses, 'retention.run', null, 'anonymised ' + rr.anonymised + ', deleted ' + rr.purged); return json(res, 200, { ok: true, result: rr, backup: backup ? backup.name : null }); }
    }
    if (p === '/api/retention/hold' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'hq' || ses.hqRole !== 'admin') return json(res, 403, { error: 'Only the HQ owner can set a legal hold' });
      const b = await readBody(req), f = findIncident(String(b.id || '')); if (!f) return json(res, 404, { error: 'No such incident' });
      const m = Object.assign({}, f.map); m[b.id] = Object.assign({}, f.rec, b.on ? { legalHold: { by: ses.user, at: Date.now(), reason: clean(b.reason, 200) } } : { legalHold: undefined });
      if (!b.on) delete m[b.id].legalHold; kvSet(f.key, m); console.log('LEGAL HOLD ' + (b.on ? 'ON' : 'OFF') + ' ' + b.id + ' by ' + ses.user); staffLog(ses, b.on ? 'legalhold.on' : 'legalhold.off', b.id, clean(b.reason, 100)); return json(res, 200, { ok: true, id: b.id, hold: !!b.on });
    }
    if (p === '/api/security/check' && req.method === 'GET') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'hq') return json(res, 401, { error: 'Sign in as HQ' });
      const https = req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
      const checks = [];
      const add = (name, ok, detail, sev) => checks.push({ name, ok, detail, sev: ok ? 'ok' : (sev || 'warn') });
      add('Connection is encrypted (HTTPS)', https, https ? 'This request arrived over HTTPS' : 'This request was not HTTPS. Put GEAMS behind HTTPS before real use.', 'high');
      add('Signing key stored privately', !!process.env.GEAMS_TOKEN_SECRET || fs.existsSync(SECRET_FILE), process.env.GEAMS_TOKEN_SECRET ? 'Supplied by environment' : 'Generated and kept on this server');
      add('Database configured', WRITER.enabled, WRITER.enabled ? 'Using ' + WRITER.kind : 'No database: data lives on this server\'s disk only', 'high');
      add('Saving to disk works', saveState.ok && !saveState.loadNote, !saveState.ok ? 'SAVING IS FAILING (' + saveState.lastError + '). Recent changes are not on disk. Free disk space now.' : (saveState.loadNote || 'Last save succeeded'), 'high');
      add('Backups running', BACKUP_HOURS > 0, BACKUP_HOURS > 0 ? 'Every ' + BACKUP_HOURS + ' h' : 'Scheduled backups are off');
      add('Backups encrypted', !!process.env.GEAMS_BACKUP_PASSPHRASE, process.env.GEAMS_BACKUP_PASSPHRASE ? 'AES-256-GCM' : 'No GEAMS_BACKUP_PASSPHRASE set');
      add('Personal commander accounts required', process.env.GEAMS_REQUIRE_COMMANDER_ACCOUNTS === '1', process.env.GEAMS_REQUIRE_COMMANDER_ACCOUNTS === '1' ? 'On' : 'Off: a station passphrase alone can sign in');
      const ld = store['hq:lockdown'] && store['hq:lockdown'].value;
      add('System not in lockdown', !(ld && ld.on), ld && ld.on ? 'Lockdown ON since ' + new Date(ld.since).toISOString() : 'Normal operation', 'info');
      const hqn = Object.keys(hqUsers).length;
      add('HQ accounts exist', hqn > 0, hqn + ' account' + (hqn === 1 ? '' : 's'));
      return json(res, 200, { checks, at: Date.now(), note: 'This reviews GEAMS\'s own settings. It is not a vulnerability scan of the network or the host.' });
    }
    // ── Civilian profile, face data, officer check and joining a nearby alert: all decided by the server ──
    if (p === '/api/civilian/profile' && (req.method === 'PUT' || req.method === 'DELETE')) {
      const ses = sessionOf(req); if (!ses || ses.role !== 'civilian' || !ses.dev) return json(res, 401, { error: 'Sign in as a civilian' });
      const b = await readBody(req), pr = isObj(b.profile) ? b.profile : {}, id = String(b.id || pr.id || '');
      if (!/^CIV-\d{3,8}$/.test(id)) return json(res, 400, { error: 'Bad account id' });
      const map = Object.assign({}, kvGet('registry:civilians', {})), cur = map[id];
      if (cur && cur.ownerDev !== ses.dev) return json(res, 403, { error: 'That account belongs to another phone' });
      if (req.method === 'DELETE') { delete map[id]; kvSet('registry:civilians', map); const fm = Object.assign({}, kvGet('registry:faces', {})); if (fm[id] && fm[id].ownerDev === ses.dev) { delete fm[id]; kvSet('registry:faces', fm); } return json(res, 200, { ok: true }); }
      if (REQUIRE_VERIFIED && !ses.verified) return json(res, 403, { error: 'Verify your phone number first' });
      if (REQUIRE_VERIFIED && ses.phone && pr.phone && normPhone(pr.phone) !== ses.phone) return json(res, 422, { error: 'The phone number must be the one you verified' });
      const str = (v, n) => String(v == null ? '' : v).slice(0, n);
      map[id] = { id, name: str(pr.name, 120), phone: str(pr.phone, 24), ghCard: str(pr.ghCard, 24), address: str(pr.address, 200), lat: typeof pr.lat === 'number' ? pr.lat : null, lng: typeof pr.lng === 'number' ? pr.lng : null, registeredDate: str(pr.registeredDate, 40), updatedAt: new Date().toISOString(), ownerDev: ses.dev };
      kvSet('registry:civilians', map); return json(res, 200, { ok: true });
    }
    if (p === '/api/version' && req.method === 'GET') {
      const f = String(u.searchParams.get('f') || '').replace(/[^\w.\-]/g, ''), fp = path.join(DIR, f);
      if (!/^geams-[\w\-]+\.html$/.test(f) || !fs.existsSync(fp)) return json(res, 404, { error: 'Unknown app' });
      return json(res, 200, { file: f, build: buildOf(fp) });
    }
    if (p === '/api/abuse' && req.method === 'GET') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'hq') return json(res, 403, { error: 'HQ only' });
      const days = Math.min(+u.searchParams.get('days') || 90, 365), since = Date.now() - days * 86400000, by = {}, bl = kvGet('registry:blocks', {});
      for (const k of incidentKeys()) { const m = store[k].value; if (!isObj(m)) continue;
        for (const r of Object.values(m)) { if (!isObj(r) || r.drill || !r.civilianId) continue; const tt = +incTime(r); if (tt && tt < since) continue;
          const g = by[r.civilianId] || (by[r.civilianId] = { civilianId: r.civilianId, name: r.civilianName, phone: r.civilianPhone, total: 0, falseAlarms: 0, last: 0, devs: {} });
          g.total++; g.last = Math.max(g.last, tt || 0); if (r.ownerDev) g.devs[r.ownerDev] = 1;
          if ((r.flagged || /unfounded|false alarm|hoax|prank/i.test(String(r.resolutionType || ''))) && !/^Cancelled by civilian/i.test(String(r.resolutionType || ''))) g.falseAlarms++; } }
      const rows = Object.values(by).filter(g => g.falseAlarms > 0 || bl[g.civilianId]).map(g => ({ civilianId: g.civilianId, name: g.name, phone: g.phone, total: g.total, falseAlarms: g.falseAlarms, last: g.last, level: bl[g.civilianId] ? bl[g.civilianId].level : null, reason: bl[g.civilianId] ? bl[g.civilianId].reason : null })).sort((a, b) => b.falseAlarms - a.falseAlarms);
      return json(res, 200, { days, rows, note: 'Counts incidents a control room flagged as a suspected prank or closed as unfounded. A civilian who cancelled their own alert is not counted.' });
    }
    if (p === '/api/abuse/set' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'hq') return json(res, 403, { error: 'HQ only' });
      const b = await readBody(req), id = String(b.civilianId || ''); if (!/^CIV-\d{3,8}$/.test(id)) return json(res, 400, { error: 'Not a civilian number' });
      const bl = Object.assign({}, kvGet('registry:blocks', {}));
      if (!b.level || b.level === 'none') { delete bl[id]; kvSet('registry:blocks', bl); staffLog(ses, 'abuse.cleared', id, ''); return json(res, 200, { ok: true, level: null }); }
      if (!['flag', 'block'].includes(b.level)) return json(res, 400, { error: 'level must be flag, block or none' });
      const reason = clean(b.reason, 200); if (!reason) return json(res, 400, { error: 'Write the reason (it is kept in the log)' });
      const devs = new Set((bl[id] && bl[id].devs) || []); for (const k of incidentKeys()) { const m = store[k].value; if (isObj(m)) for (const r of Object.values(m)) if (isObj(r) && r.civilianId === id) { if (r.ownerDev) devs.add(r.ownerDev); (r.reporterDevs || []).forEach(d => devs.add(d)); } }
      bl[id] = { level: b.level, devs: [...devs], at: Date.now(), by: whoOf(ses), reason }; kvSet('registry:blocks', bl); staffLog(ses, 'abuse.' + b.level, id, reason);
      return json(res, 200, { ok: true, level: b.level, phones: devs.size });
    }
    if (p === '/api/escalations' && req.method === 'GET') {
      const ses = sessionOf(req, true); if (!ses || ses.role !== 'hq') return json(res, 403, { error: 'HQ only' });
      const map = kvGet('registry:escalations', {}), list = Object.values(isObj(map) ? map : {}), c = ESC();
      const now = Date.now(); list.forEach(e => { if (e.open) e.waitedSecs = Math.round((now - e.since) / 1000); });
      return json(res, 200, { open: list.filter(e => e.open).sort((a, b) => a.since - b.since), recent: list.filter(e => !e.open).sort((a, b) => b.clearedAt - a.clearedAt).slice(0, 50), config: { secs: c.secs, offlineSecs: c.offlineSecs }, note: 'This only warns. Nothing is moved or sent automatically. Phone the control room or a neighbour.' });
    }
    if (p === '/api/escalations/ack' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'hq') return json(res, 403, { error: 'HQ only' });
      const b = await readBody(req), map = kvGet('registry:escalations', {}), e = isObj(map) ? map[String(b.key || '')] : null; if (!e) return json(res, 404, { error: 'Unknown warning' });
      e.ackBy = ses.user; e.ackAt = Date.now(); e.ackNote = String(b.note || '').slice(0, 160); kvSet('registry:escalations', map); staffLog(ses, 'escalation.ack', e.ref, e.ackNote ? 'note' : '', e.sid); return json(res, 200, { ok: true });
    }
    if (p === '/api/escalations/mine' && req.method === 'GET') {
      const ses = sessionOf(req, true); if (!ses || ses.role !== 'lcr' || !ses.sid) return json(res, 403, { error: 'Control rooms only' });
      lcrSeen[ses.sid] = Date.now();
      const map = kvGet('registry:escalations', {}), out = [];
      for (const e of Object.values(isObj(map) ? map : {})) { if (!e.open || e.sid === ses.sid) continue; const nb = (e.neighbours || []).find(n => n.sid === ses.sid); if (!nb) continue;
        out.push({ key: e.key, fromStation: e.station, fromPhone: ((kvGet('registry:stations', {}) || {})[e.sid] || {}).phone || '', type: e.type, priority: e.priority, waitedSecs: Math.round((Date.now() - e.since) / 1000), km: nb.km, reason: e.reason }); }
      return json(res, 200, { items: out, note: 'A neighbouring control room has an alert nobody has taken. Phone them. Nothing has been moved to you.' });
    }
    if (p === '/api/stafflog' && req.method === 'GET') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'hq') return json(res, 403, { error: 'HQ only' });
      let l = kvGet('registry:staffLog', []); const q = u.searchParams, who = q.get('by'), st = q.get('station'), ref = q.get('ref'), act = q.get('action');
      if (who) l = l.filter(x => x.by.includes(who)); if (st) l = l.filter(x => x.station === st); if (ref) l = l.filter(x => x.ref === ref); if (act) l = l.filter(x => x.action.startsWith(act));
      return json(res, 200, { total: l.length, items: l.slice().reverse().slice(0, Math.min(+q.get('limit') || 200, 1000)) });
    }
    if (p === '/api/csp-report' && req.method === 'POST') {
      if (!bump('csp|' + clientIp(req), 60, 10 * 60000)) { res.writeHead(204); return res.end(); }
      let b = {}; try { const raw = await readBody(req); b = raw['csp-report'] || raw; } catch (e) {}
      const list = kvGet('registry:clientErrors', []).slice(-499);
      list.push({ at: Date.now(), app: 'CSP', build: '', msg: clean('Blocked by security policy: ' + (b['violated-directive'] || b.effectiveDirective || '?') + ' ' + (b['blocked-uri'] || b.blockedURL || ''), 300), src: clean(String(b['document-uri'] || b.documentURL || '').split('/').pop(), 80), line: +b['line-number'] || 0, stack: '', online: true, ua: '', role: null, station: null });
      kvSet('registry:clientErrors', list); res.writeHead(204); return res.end();
    }
    if (p === '/api/clientlog' && req.method === 'POST') {
      if (!bump('cl|' + clientIp(req), 30, 10 * 60000)) return json(res, 429, { error: 'Too many reports' });
      const ses = sessionOf(req), b = await readBody(req), msg = clean(b.msg, 300); if (!msg) return json(res, 400, { error: 'Nothing to report' });
      const list = kvGet('registry:clientErrors', []).slice(-499);
      list.push({ at: Date.now(), app: clean(b.app, 40), build: clean(b.build, 12), msg, src: clean(b.src, 80), line: +b.line || 0, stack: clean(b.stack, 600), online: b.online !== false, ua: clean(b.ua, 120), role: ses ? ses.role : null, station: ses ? (ses.sid || ses.lcr || null) : null });
      kvSet('registry:clientErrors', list); return json(res, 200, { ok: true });
    }
    if (p === '/api/clientlog' && req.method === 'GET') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'hq') return json(res, 403, { error: 'HQ only' });
      const list = kvGet('registry:clientErrors', []), groups = {};
      for (const e of list) { const k = e.app + '|' + e.msg; const g = groups[k] || (groups[k] = { app: e.app, msg: e.msg, src: e.src, line: e.line, count: 0, first: e.at, last: e.at, builds: {}, roles: {}, offline: 0 }); g.count++; g.last = Math.max(g.last, e.at); g.first = Math.min(g.first, e.at); g.builds[e.build || '?'] = 1; if (e.role) g.roles[e.role] = 1; if (!e.online) g.offline++; }
      return json(res, 200, { total: list.length, groups: Object.values(groups).sort((a, b) => b.last - a.last).slice(0, 100).map(g => Object.assign(g, { builds: Object.keys(g.builds), roles: Object.keys(g.roles) })) });
    }
    if (p === '/api/clientlog/clear' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'hq' || ses.hqRole !== 'admin') return json(res, 403, { error: 'HQ owner only' });
      kvSet('registry:clientErrors', []); return json(res, 200, { ok: true });
    }
    if (p === '/api/feedback' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses) return json(res, 401, { error: 'Sign in first' });
      if (['hq'].includes(ses.role)) return json(res, 403, { error: 'HQ reads feedback; it does not send it' });
      const who = ses.role + ':' + (ses.dev || ses.badge || ses.user || ses.sid || '?');
      if (!bump('fb|' + who, 10, 3600000)) return json(res, 429, { error: 'Too much feedback in the last hour. Try again later.' });
      const b = await readBody(req), text = clean(b.text, 1000); if (text.length < 5) return json(res, 400, { error: 'Please write a few words' });
      const kind = ['problem', 'idea', 'praise'].includes(b.kind) ? b.kind : 'problem';
      const list = kvGet('registry:feedback', []).slice(-1999), id = 'FB-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
      list.push({ id, at: Date.now(), role: ses.role, from: ses.role === 'civilian' ? (b.contactOk === true ? clean(b.contact, 60) || 'no contact given' : 'anonymous') : (ses.user || ses.badge || ses.role), station: ses.sid || ses.lcr || null, kind, text, app: clean(b.app, 30), status: 'new' });
      kvSet('registry:feedback', list); return json(res, 200, { ok: true, id });
    }
    if (p === '/api/feedback' && req.method === 'GET') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'hq') return json(res, 403, { error: 'HQ only' });
      const list = kvGet('registry:feedback', []); return json(res, 200, { items: list.slice().reverse().slice(0, 300), total: list.length, open: list.filter(x => x.status === 'new').length });
    }
    if (p === '/api/feedback/status' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'hq') return json(res, 403, { error: 'HQ only' });
      const b = await readBody(req), list = kvGet('registry:feedback', []).map(x => Object.assign({}, x)), it = list.find(x => x.id === b.id); if (!it) return json(res, 404, { error: 'No such feedback' });
      it.status = ['new', 'seen', 'done'].includes(b.status) ? b.status : 'seen'; kvSet('registry:feedback', list); return json(res, 200, { ok: true });
    }
    if (p === '/api/civilian/consent' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'civilian' || !ses.dev) return json(res, 401, { error: 'Sign in as a civilian' });
      if (!bump('cs|' + ses.dev, 30, 3600000)) return json(res, 429, { error: 'Too many attempts' });
      const b = await readBody(req), c = Object.assign({}, kvGet('registry:consents', {}));
      c[ses.dev] = { notice: clean(b.notice, 20), at: Date.now(), civilianId: /^CIV-\d{3,8}$/.test(String(b.civilianId || '')) ? b.civilianId : null };
      kvSet('registry:consents', c); return json(res, 200, { ok: true });
    }
    if (p === '/api/face/enrol' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'civilian' || !ses.dev) return json(res, 401, { error: 'Sign in as a civilian' });
      if (!bump('fe|' + ses.dev, 20, 3600000)) return json(res, 429, { error: 'Too many attempts. Try again later.' });
      const b = await readBody(req), id = String(b.civilianId || '');
      if (!/^CIV-\d{3,8}$/.test(id)) return json(res, 400, { error: 'Bad account id' });
      const d = b.descriptor; if (!Array.isArray(d) || d.length !== 128 || !d.every(x => typeof x === 'number' && isFinite(x) && Math.abs(x) < 5)) return json(res, 422, { error: 'That is not a valid face record' });
      if (REQUIRE_VERIFIED && !ses.verified) return json(res, 403, { error: 'Verify your phone number first' });
      if (process.env.GEAMS_REQUIRE_FACE_CONSENT !== '0' && b.faceConsent !== true) return json(res, 403, { error: 'A face record is only stored with your consent' });
      const fm = Object.assign({}, kvGet('registry:faces', {})), cur = fm[id];
      if (cur && cur.ownerDev !== ses.dev) return json(res, 403, { error: 'That account belongs to another phone' });
      const pf = kvGet('registry:civilians', {})[id], str = (v, n) => String(v == null ? '' : v).slice(0, n);
      fm[id] = { civilianId: id, name: str((pf && pf.name) || b.name, 120), phone: str((pf && pf.phone) || b.phone, 24), ghCard: str((pf && pf.ghCard) || b.ghCard, 24), descriptor: d.map(Number), enrolledAt: Date.now(), ownerDev: ses.dev, consent: { at: Date.now(), notice: str(b.notice, 20) } };
      kvSet('registry:faces', fm); return json(res, 200, { ok: true });
    }
    if (p === '/api/face/remove' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'civilian' || !ses.dev) return json(res, 401, { error: 'Sign in as a civilian' });
      const b = await readBody(req), id = String(b.civilianId || ''), fm = Object.assign({}, kvGet('registry:faces', {}));
      if (fm[id] && fm[id].ownerDev === ses.dev) { delete fm[id]; kvSet('registry:faces', fm); }
      return json(res, 200, { ok: true });
    }
    { const fm = /^\/api\/face\/(verify|search|lookup|audit)$/.exec(p);
      if (fm) {
        const ses = sessionOf(req); if (!ses) return json(res, 401, { error: 'Sign in required' });
        const faceAudit = (what, extra) => { const a = kvGet('registry:faceAudit', []).slice(-1999); a.push(Object.assign({ at: Date.now(), by: ses.role + ':' + ses.user, badge: ses.badge || null, what }, extra)); kvSet('registry:faceAudit', a); console.log('FACE ' + what + ' by ' + ses.role + ':' + ses.user); };
        if (fm[1] === 'audit') { if (ses.role !== 'hq') return json(res, 403, { error: 'HQ only' }); return json(res, 200, { entries: kvGet('registry:faceAudit', []).slice(-500).reverse() }); }
        if (!['officer', 'lcr', 'hq'].includes(ses.role)) return json(res, 403, { error: 'Only officers and control rooms can check faces' });
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        if (!bump('fc|' + ses.role + ':' + ses.user, 40, 10 * 60000)) return json(res, 429, { error: 'Too many face checks. Wait a few minutes.' });
        const b = await readBody(req);
        // an officer may only check faces on an incident assigned to them; a control room only on its own incidents
        const f = b.incId ? findIncident(String(b.incId)) : null;
        const mine = f && ((ses.role === 'hq') || (ses.role === 'lcr' && ses.sid === f.sid) || (ses.role === 'officer' && f.sid === ses.lcr && ((f.rec.officerBadge && f.rec.officerBadge === ses.badge) || (f.rec.officerName && String(f.rec.officerName).toLowerCase() === String(ses.user).toLowerCase()))));
        if (!mine) return json(res, 403, { error: 'Face checks are only allowed on an incident assigned to you' });
        const faces = kvGet('registry:faces', {});
        const dist = (a, c) => Math.sqrt(a.reduce((t, x, i) => t + (x - c[i]) * (x - c[i]), 0));
        const okDesc = (d) => Array.isArray(d) && d.length === 128 && d.every(x => typeof x === 'number' && isFinite(x) && Math.abs(x) < 5);
        const THRESH = 0.6;
        if (fm[1] === 'lookup') {
          const g = String(b.ghCard || '').trim().toLowerCase(); if (!g) return json(res, 400, { error: 'Enter a Ghana Card number' });
          const hit = Object.values(faces).find(e => String(e.ghCard || '').toLowerCase() === g);
          faceAudit('lookup', { inc: b.incId, found: !!hit, who: hit ? hit.civilianId : null });
          return json(res, 200, hit ? { found: true, name: hit.name, phone: hit.phone } : { found: false });
        }
        if (fm[1] === 'verify') {
          const rec = f.rec; let e = rec.civilianId ? faces[rec.civilianId] : null;
          if (!e && rec.civilianPhone) e = Object.values(faces).find(x => x.phone && x.phone === rec.civilianPhone);
          if (!e) return json(res, 200, { enrolled: false });
          if (b.descriptor === undefined) return json(res, 200, { enrolled: true, name: e.name });
          if (!okDesc(b.descriptor)) return json(res, 422, { error: 'That is not a valid face reading' });
          const d = dist(b.descriptor, e.descriptor), match = d <= THRESH;
          faceAudit('verify', { inc: b.incId, who: e.civilianId, match, distance: +d.toFixed(3) });
          return json(res, 200, { enrolled: true, match, distance: d, threshold: THRESH, name: e.name });
        }
        if (!okDesc(b.descriptor)) return json(res, 422, { error: 'That is not a valid face reading' });
        let best = null; for (const e of Object.values(faces)) { const d = dist(b.descriptor, e.descriptor); if (!best || d < best.d) best = { d, e }; }
        const hit = best && best.d <= THRESH ? best : null;
        faceAudit('search', { inc: b.incId, subject: String(b.subject || '').slice(0, 40), found: !!hit, who: hit ? hit.e.civilianId : null, distance: best ? +best.d.toFixed(3) : null });
        return json(res, 200, hit ? { found: true, name: hit.e.name, phone: hit.e.phone, ghCard: hit.e.ghCard, enrolledAt: hit.e.enrolledAt, distance: hit.d, threshold: THRESH } : { found: false, threshold: THRESH });
      } }
    if (p === '/api/civilian/verify-officer' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'civilian') return json(res, 401, { error: 'Sign in required' });
      if (!bump('vo|' + (ses.dev || clientIp(req)), 30, 10 * 60000)) return json(res, 429, { error: 'Too many checks. Try again shortly.' });
      const b = await readBody(req), badge = String(b.badge || '').trim().toUpperCase(); if (!badge || badge.length > 30) return json(res, 400, { error: 'Enter a badge number' });
      for (const k of Object.keys(store)) { const m = /^lcr:([^:]+):officers$/.exec(k); if (!m) continue; const o = Object.values(store[k].value || {}).find(x => String(x.badge || '').toUpperCase() === badge && x.status === 'on-duty' && Date.now() - (x.lastSeen || 0) < 60000);
        if (o) { const st = (kvGet('registry:stations', {}))[m[1]]; return json(res, 200, { valid: true, name: o.name, rank: o.rank || '', station: st ? st.name : m[1] }); } }
      return json(res, 200, { valid: false });
    }
    if (p === '/api/civilian/join-nearby' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'civilian' || !ses.dev) return json(res, 401, { error: 'Sign in as a civilian' });
      const b = await readBody(req), sid = String(b.station || ''), lat = +b.lat, lng = +b.lng, R = Math.min(500, +b.radiusM || 200);
      if (!/^lcr:[^:]+:incidents$/.test('lcr:' + sid + ':incidents') || !isFinite(lat) || !isFinite(lng)) return json(res, 400, { error: 'Bad request' });
      const key = 'lcr:' + sid + ':incidents', map = Object.assign({}, kvGet(key, {}));
      const hav = (a1, o1, a2, o2) => { const r = Math.PI / 180, dA = (a2 - a1) * r, dO = (o2 - o1) * r, h = Math.sin(dA / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(dO / 2) ** 2; return 12742000 * Math.asin(Math.sqrt(h)); };
      const hit = Object.values(map).find(r => r && r.status !== 'resolved' && r.status !== 'cancelled' && r.lat != null && r.lng != null && hav(lat, lng, r.lat, r.lng) <= R);
      if (!hit) return json(res, 200, { found: false });
      const rec = Object.assign({}, hit);
      rec.additionalReporters = (Array.isArray(rec.additionalReporters) ? rec.additionalReporters : []).concat({ id: String(b.id || '').slice(0, 40), name: String(b.name || '').slice(0, 120), phone: ses.verified && ses.phone ? ses.phone : String(b.phone || '').slice(0, 24), notes: String(b.notes || '').slice(0, 500), reportedAt: new Date().toISOString() }).slice(-30);
      rec.reporterDevs = Array.from(new Set((Array.isArray(rec.reporterDevs) ? rec.reporterDevs : []).concat(ses.dev))).slice(-30);
      map[rec.id] = rec; kvSet(key, map);
      return json(res, 200, { found: true, incident: civView(Object.assign({}, rec, { additionalReporters: undefined, civilianId: undefined, civilianName: undefined, civilianPhone: undefined, civilianLat: undefined, civilianLng: undefined })) });
    }
    if (p === '/api/storage/status' && req.method === 'GET') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'hq') return json(res, 401, { error: 'Sign in as HQ' });
      const okDb = await WRITER.ping(), bks = PERSIST.listBackups(), last = bks[0] || null, hrs = BACKUP_HOURS;
      return json(res, 200, { kind: WRITER.kind, databaseConfigured: WRITER.enabled, databaseOk: WRITER.enabled ? okDb && WRITER.ok : null, pending: WRITER.pending, lastDatabaseWrite: WRITER.lastOkFlush ? new Date(WRITER.lastOkFlush).toISOString() : null, lastError: WRITER.lastError, records: Object.keys(store).length, diskSave: { ok: saveState.ok, lastError: saveState.lastError, since: saveState.failedSince ? new Date(saveState.failedSince).toISOString() : null, lastOk: saveState.lastOkAt ? new Date(saveState.lastOkAt).toISOString() : null, startupNote: saveState.loadNote },
        backups: { everyHours: hrs, keep: parseInt(process.env.GEAMS_BACKUP_KEEP, 10) || 7, encrypted: !!process.env.GEAMS_BACKUP_PASSPHRASE, offsite: !!process.env.GEAMS_BACKUP_PUT_URL, last, count: bks.length, overdue: hrs > 0 ? !last || Date.now() - Date.parse(last.createdAt) > hrs * 3600000 * 2 : null, lastRun: backupState },
        note: WRITER.enabled ? null : 'No database is configured: data lives on this server\'s disk only. On hosting that resets its disk, everything is lost on restart.' });
    }
    if (p === '/api/backup/list' && req.method === 'GET') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'hq' || ses.hqRole !== 'admin') return json(res, 403, { error: 'Only the HQ owner can see backups' });
      return json(res, 200, { backups: PERSIST.listBackups() });
    }
    if (p === '/api/backup/run' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'hq' || ses.hqRole !== 'admin') return json(res, 403, { error: 'Only the HQ owner can run a backup' });
      if (!bump('bk|' + ses.user, 6, 3600000)) return json(res, 429, { error: 'Too many backups requested. Try again later.' });
      try { const info = await runBackup('manual:' + ses.user); return json(res, 200, { ok: true, backup: info }); } catch (e) { return json(res, 500, { error: 'Backup failed: ' + e.message }); }
    }
    if (p === '/api/backup/download' && req.method === 'GET') {
      const ses = sessionOf(req, true); if (!ses || ses.role !== 'hq' || ses.hqRole !== 'admin') return json(res, 403, { error: 'Only the HQ owner can download a backup' });
      const nm = String(u.searchParams.get('name') || ''); if (!/^geams-backup-[0-9TZ]+\.tar\.gz(\.enc)?$/.test(nm)) return json(res, 400, { error: 'Bad backup name' });
      const fp = path.join(PERSIST.BACKUP_DIR, nm); if (!fs.existsSync(fp)) return json(res, 404, { error: 'No such backup' });
      console.log('backup downloaded: ' + nm + ' by hq:' + ses.user);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(fp).size, 'Content-Disposition': 'attachment; filename="' + nm + '"', 'Cache-Control': 'no-store' });
      return fs.createReadStream(fp).pipe(res);
    }
    // ── Response-time analytics (HQ: everything; control room: its own area) ──
    // ── Pilot evaluation report (HQ): anonymised numbers only, no names, phones, addresses or free text ──
    if (p === '/api/hq/pilot-report' && req.method === 'GET') {
      const ses = sessionOf(req); if (!ses || ses.role !== 'hq') return json(res, 401, { error: 'HQ sign-in required' });
      const days = Math.min(Math.max(parseInt(u.searchParams.get('days'), 10) || 30, 1), 400), from = Date.now() - days * 86400000;
      const ra = responseAnalytics({ days: String(days) }, { role: 'hq' });
      const byType = {}, byPrio = {}, byStatus = {}, byHour = Array(24).fill(0); let total = 0, drills = 0, civ = 0, walk = 0; const civIds = new Set();
      for (const key of Object.keys(store)) {
        if (!/^(lcr|fire|ambulance):[^:]+:incidents$/.test(key)) continue; const mv = store[key].value; if (!isObj(mv)) continue;
        for (const rec of Object.values(mv)) {
          if (!isObj(rec)) continue; const t = (rec.srv && rec.srv.received) || Date.parse(rec.createdAt) || 0; if (t < from) continue;
          if (rec.drill) { drills++; continue; } total++;
          const ty = String(rec.type || 'unknown').slice(0, 40); byType[ty] = (byType[ty] || 0) + 1; byPrio[rec.priority || 'unknown'] = (byPrio[rec.priority || 'unknown'] || 0) + 1; byStatus[rec.status || 'unknown'] = (byStatus[rec.status || 'unknown'] || 0) + 1;
          byHour[new Date(t).getUTCHours()]++; if (rec.source === 'civilian-app') { civ++; if (rec.civilianId) civIds.add(rec.civilianId); } else walk++;
        }
      }
      const slog = kvGet('registry:staffLog', []).filter(x => x.at >= from), cnt = (re) => slog.filter(x => re.test(x.action)).length;
      const esc = (kvGet('registry:escalations', []) || []).filter(e => e.flaggedAt >= from);
      const pauses = slog.filter(x => /^pilot\./.test(x.action)).map(x => ({ at: new Date(x.at).toISOString(), action: x.action }));
      const fb = (kvGet('registry:feedback', []) || []).filter(x => x.at >= from), fbBy = {}; fb.forEach(x => { fbBy[x.kind || 'other'] = (fbBy[x.kind || 'other'] || 0) + 1; });
      const errs = (kvGet('registry:clientErrors', []) || []).filter(x => (x.at || x.ts || 0) >= from);
      const blocks = Object.values(kvGet('registry:blocks', {}) || {}), crew = ['officer', 'fire', 'ambulance'].map(k => [k, (kvGet(UNIT[k].key, []) || []).length]);
      const stations = Object.keys(kvGet('registry:stations', {}) || {}).length;
      return json(res, 200, { schema: 'geams.pilotreport.v1', generatedAt: new Date().toISOString(), windowDays: days, label: process.env.GEAMS_PILOT_LABEL || null,
        scope: { controlRoomsRegistered: stations, crewAccounts: Object.fromEntries(crew), distinctCivilianSenders: civIds.size },
        alerts: { total, drillsExcluded: drills, fromCivilianApp: civ, otherSources: walk, byType, byPriority: byPrio, byOutcome: byStatus, byHourUTC: byHour },
        speed: { medianSecondsToAssign: ra.national.current.medianAssign != null ? ra.national.current.medianAssign : (ra.national.current.medianAssigned != null ? ra.national.current.medianAssigned : null), national: ra.national.current, previousPeriod: ra.national.previous, excluded: ra.excluded || null, definitions: ra.definitions },
        reliability: { unansweredAlertWarnings: esc.length, ofWhichStationOffline: esc.filter(e => e.reason === 'station_offline').length, stillOpen: esc.filter(e => e.open).length, pauseEvents: pauses, appErrorsReported: errs.length, abuseBlocksNow: blocks.length, abuseActionsInWindow: cnt(/^abuse\./) },
        feedback: { total: fb.length, byKind: fbBy }, staffActions: { crewImports: cnt(/bulk_import/), handoversRecorded: cnt(/handover/), passwordResets: cnt(/password_reset/) },
        notMeasured: ['Whether help actually arrived or the outcome for the patient or victim: GEAMS only records what staff tap.', 'Calls and texts made outside GEAMS (112, phone calls).', 'Alerts that never reached the server (no signal and never retried).', 'Whether response times improved because of GEAMS: there is no comparison group unless you compare against your own earlier records.', 'Anything at an hour or place with too few alerts to be meaningful: treat small counts as stories, not statistics.'] });
    }
    if (p === '/api/analytics/response' && req.method === 'GET') {
      const ses = sessionOf(req); if (!ses || !['hq', 'lcr'].includes(ses.role)) return json(res, 401, { error: 'Sign in as HQ or a control room' });
      return json(res, 200, responseAnalytics(Object.fromEntries(u.searchParams), ses));
    }
    // ── Open data: export ──
    if (p.startsWith('/api/export/') && req.method === 'GET') {
      const ses = sessionOf(req, true); if (!ses || !['hq', 'lcr'].includes(ses.role)) return json(res, 401, { error: 'Sign in as HQ or a control room' });
      const what = p.slice(12), q = Object.fromEntries(u.searchParams), fmt = (q.format || 'json').toLowerCase();
      const send = (o, name) => { res.writeHead(200, { 'Content-Type': o.type, 'Content-Disposition': 'attachment; filename="' + name + '.' + o.ext + '"', 'Cache-Control': 'no-store' }); res.end(o.body); };
      const stamp = new Date().toISOString().slice(0, 10), personal = q.personal === '1';
      if (!['json', 'csv', 'geojson', 'cap', 'edxl'].includes(fmt)) return json(res, 400, { error: 'Format must be json, csv, geojson, cap or edxl' });
      if (what === 'incidents') { const items = collectIncidents(ses, q); console.log('export incidents ' + fmt + ' n=' + items.length + ' by ' + ses.role + ':' + ses.user); return send(exportIncidents(items, fmt, personal, q.evidence === '1'), 'geams-incidents-' + stamp); }
      if (what === 'alerts') {
        if (ses.role !== 'hq') return json(res, 403, { error: 'Only HQ exports public alerts' });
        const list = Object.values(kvGet('public:alerts', {}) || {}).filter(isObj).sort((a, b) => a.createdAt - b.createdAt);
        if (fmt === 'cap') return send({ type: 'application/cap+xml', ext: 'xml', body: list.length === 1 ? capPublicAlert(list[0]) : '<?xml version="1.0" encoding="UTF-8"?>\n<alerts>\n' + list.map(a => capPublicAlert(a).replace(/^<\?xml[^>]*\?>\n/, '')).join('') + '</alerts>\n' }, 'geams-alerts-' + stamp);
        if (fmt === 'edxl') return send({ type: 'application/xml', ext: 'xml', body: edxlWrap(list.map(capPublicAlert), 'GEAMS public alert') }, 'geams-alerts-' + stamp);
        return send({ type: 'application/json', ext: 'json', body: JSON.stringify({ schema: 'geams.alerts.v1', exportedAt: new Date().toISOString(), alerts: list }, null, 1) }, 'geams-alerts-' + stamp);
      }
      if (what === 'all') {
        if (ses.role !== 'hq') return json(res, 403, { error: 'Only HQ exports everything' });
        const items = collectIncidents(ses, q), reg = kvGet('registry:stations', {}) || {};
        const stations = Object.values(reg).filter(isObj).map(x => { const o = Object.assign({}, x); for (const k of Object.keys(o)) if (/pass|secret|token|hash|pin/i.test(k)) delete o[k]; return o; });
        console.log('export all by hq:' + ses.user);
        return send({ type: 'application/json', ext: 'json', body: JSON.stringify({ schema: 'geams.bundle.v1', exportedAt: new Date().toISOString(), note: 'Passwords, signing keys, face templates and push subscriptions are never exported. Evidence files are listed with their SHA-256 so a copy can be checked against the original.', stations, stationLocations: kvGet('registry:stationLocations', {}), alerts: kvGet('public:alerts', {}), incidents: items.map(n => Object.assign({}, n, { evidence: evidenceOf(n.id) })) }, null, 1) }, 'geams-bundle-' + stamp);
      }
      return json(res, 404, { error: 'Export what? incidents, alerts or all' });
    }
    // ── Open data: import (raw file in the body) ──
    if (p === '/api/import/incidents' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || !['hq', 'lcr'].includes(ses.role)) return json(res, 401, { error: 'Sign in as HQ or a control room' });
      const chunks = []; let size = 0, tooBig = false;
      await new Promise((ok) => { req.on('data', (c) => { size += c.length; if (size > 5 * 1024 * 1024) { tooBig = true; } else chunks.push(c); }); req.on('end', ok); req.on('error', ok); });
      if (tooBig) return json(res, 413, { error: 'File is over 5 MB. Split it and import in parts.' });
      const q = Object.fromEntries(u.searchParams), parsed = parseImport(Buffer.concat(chunks).toString('utf8'), q.format ? q.format.toLowerCase() : null);
      if (parsed.error) return json(res, 400, { error: parsed.error });
      if (parsed.items.length > 1000) return json(res, 400, { error: 'More than 1000 records. Split the file and import in parts.' });
      const reg = kvGet('registry:stations', {}) || {}, dry = q.dry === '1', result = { format: parsed.format, dryRun: dry, total: parsed.items.length + parsed.errors.length, imported: 0, duplicates: 0, rejected: parsed.errors.slice(), stationsTouched: [] };
      const maps = {}, touched = new Set();
      for (const it of parsed.items) {
        const sid = ses.role === 'lcr' ? ses.sid : (q.station || it.stationId);
        const bad = (e) => result.rejected.push({ index: it.idx, id: it.id || null, error: e });
        if (!sid) { bad('No control room given. Choose one for the import.'); continue; }
        if (ses.role === 'lcr' && it.stationId && it.stationId !== ses.sid) { bad('Belongs to another control room'); continue; }
        if (!reg[sid] && !(kvGet(SECRET_KEY, {}) || {})[sid] && !store['lcr:' + sid + ':incidents']) { bad('Unknown control room ' + sid); continue; }
        if (!it.type || String(it.type).length > 80) { bad('Missing or too long incident type'); continue; }
        if ((it.lat != null || it.lng != null) && !(Number.isFinite(it.lat) && Number.isFinite(it.lng) && inGhana(it.lat, it.lng))) { bad('Position is missing a half or outside Ghana'); continue; }
        const created = it.createdAt ? Date.parse(it.createdAt) : NaN; if (!Number.isFinite(created) || created > Date.now() + 86400000 || created < Date.parse('2000-01-01')) { bad('Date is missing or not valid'); continue; }
        const id = it.id ? String(it.id).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60) : ''; const key = 'lcr:' + sid + ':incidents';
        const map = maps[sid] || (maps[sid] = Object.assign({}, kvGet(key, {})));
        let nid = id; if (!nid) { do { nid = 'INC-I' + crypto.randomBytes(4).toString('hex').toUpperCase(); } while (map[nid]); }
        if (map[nid]) { result.duplicates++; continue; }
        map[nid] = { id: nid, type: String(it.type).slice(0, 80), priority: ['critical', 'high', 'medium', 'low'].includes(it.priority) ? it.priority : 'high', status: it.status === 'cancelled' ? 'cancelled' : 'resolved', importedStatus: it.status || null, location: it.location ? String(it.location).slice(0, 200) : null, lat: it.lat == null ? null : it.lat, lng: it.lng == null ? null : it.lng, createdAt: new Date(created).toISOString(), resolvedAt: it.resolvedAt && Number.isFinite(Date.parse(it.resolvedAt)) ? new Date(it.resolvedAt).toISOString() : null, notes: it.notes ? String(it.notes).slice(0, 2000) : '', civilianName: it.civilianName ? String(it.civilianName).slice(0, 100) : null, civilianPhone: it.civilianPhone ? String(it.civilianPhone).slice(0, 30) : null, source: 'import', importedAt: new Date().toISOString(), importedBy: ses.user, srv: { imported: true } };
        touched.add(sid); result.imported++;
      }
      result.stationsTouched = Array.from(touched);
      if (!dry) { for (const sid of touched) kvSet('lcr:' + sid + ':incidents', maps[sid]); console.log('import ' + result.imported + ' incidents (' + result.format + ') by ' + ses.role + ':' + ses.user); }
      return json(res, 200, result);
    }
    // ── Crew approvals: a control room approves its own crews, HQ can approve any ──
    if (p === '/api/lcr/pending' && req.method === 'GET') {
      const ses = sessionOf(req); if (!ses || !['lcr', 'hq', ...AGENCY_ROLES].includes(ses.role)) return json(res, 401, { error: 'Sign in as a control room or HQ' });
      if (ses.mc) return json(res, 403, { error: 'Choose your own password first' });
      const list = Object.values(kvGet(UNIT_PENDING, {})).filter(x => ses.role === 'hq' || (agencyOf(ses) ? x.kind === agencyOf(ses) : (x.kind === 'officer' && x.cred.lcrId === ses.sid))).map(x => ({ kind: x.kind, badge: x.cred.badge, name: x.cred.name, rank: x.cred.rank, phone: x.cred.phone, vehicle: x.cred.vehicle, lcrId: x.cred.lcrId, requestedAt: x.requestedAt }));
      return json(res, 200, { pending: list });
    }
    if (p === '/api/lcr/approve' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || !['lcr', 'hq', ...AGENCY_ROLES].includes(ses.role)) return json(res, 401, { error: 'Sign in as a control room or HQ' });
      if (ses.mc) return json(res, 403, { error: 'Choose your own password first' });
      const b = await readBody(req), id = (agencyOf(ses) || String(b.kind)) + ':' + String(b.badge), pend = Object.assign({}, kvGet(UNIT_PENDING, {})), x = pend[id];
      if (!x) return json(res, 404, { error: 'No such request (it may already have been handled)' });
      if (ses.role === 'lcr' && x.cred.lcrId !== ses.sid) return json(res, 403, { error: 'That crew belongs to another control room' });
      if (ses.role === 'lcr' && x.kind !== 'officer') return json(res, 403, { error: 'Fire and ambulance sign-ups are approved by their own HQ' });
      delete pend[id]; kvSet(UNIT_PENDING, pend);
      if (b.approve) { const U = UNIT[x.kind], list = Array.isArray(kvGet(U.key, null)) ? kvGet(U.key, []).slice() : []; list.push(x.cred); kvSet(U.key, list); }
      else { const ua = Object.assign({}, kvGet(UNIT_AUTH, {})); delete ua[id]; kvSet(UNIT_AUTH, ua); }
      staffLog(ses, b.approve ? 'crew.approved' : 'crew.rejected', id, '', x.cred.lcrId);
      return json(res, 200, { ok: true, approved: !!b.approve, by: ses.user });
    }
    // ── Push registration ──
    if (p === '/api/push/key' && req.method === 'GET') return json(res, 200, { key: VAPID.pub });
    if (p === '/api/push/subscribe' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses) return json(res, 401, { error: 'Sign in required' });
      if (!bump('push|' + clientIp(req), 60, 3600000)) return json(res, 429, { error: 'Too many registrations. Try again later.' });
      const b = await readBody(req), sub = b.subscription || {}, k = sub.keys || {};
      let host = ''; try { const uu = new URL(sub.endpoint); host = uu.hostname; if (uu.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(host)) throw 0; } catch (e) { return json(res, 400, { error: 'Not a valid push address' }); }
      if (String(sub.endpoint).length > 600 || fromB64u(k.p256dh || '').length !== 65 || fromB64u(k.auth || '').length < 16) return json(res, 400, { error: 'Push keys are not valid' });
      const all = Object.assign({}, kvGet(PUSH_KEY, {})), id = crypto.createHash('sha256').update(sub.endpoint).digest('hex').slice(0, 24);
      if (!all[id] && Object.keys(all).length >= 50000) return json(res, 507, { error: 'Push list is full' });
      const officers = ['officer', 'fire', 'ambulance', 'lcr'].includes(ses.role);
      all[id] = { endpoint: sub.endpoint, p256dh: k.p256dh, auth: k.auth, audience: officers ? 'officers' : 'civilians', stationId: officers ? (ses.lcr || ses.sid || null) : (String(b.stationId || '').slice(0, 80) || null), url: /^\/geams-[a-z0-9-]{1,40}\.html$/.test(String(b.url || '')) ? b.url : '/', updated: Date.now() };
      kvSet(PUSH_KEY, all);
      return json(res, 200, { ok: true, id });
    }
    if (p === '/api/push/unsubscribe' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses) return json(res, 401, { error: 'Sign in required' });
      const b = await readBody(req), id = crypto.createHash('sha256').update(String(b.endpoint || '')).digest('hex').slice(0, 24), all = Object.assign({}, kvGet(PUSH_KEY, {}));
      if (all[id]) { delete all[id]; kvSet(PUSH_KEY, all); }
      return json(res, 200, { ok: true });
    }
    // ── Inbound text messages: the SMS gateway forwards each text here ──
    if (p === '/api/sms/inbound' && (req.method === 'POST' || req.method === 'GET')) {
      const KEY = process.env.GEAMS_SMS_INBOUND_KEY;
      if (!KEY) return json(res, 501, { error: 'Inbound SMS is not set up on this server' });
      let b = {};
      if (req.method === 'GET') b = Object.fromEntries(u.searchParams);
      else { const raw = (await readRaw(req, 100000)).toString('utf8'); try { b = /json/i.test(req.headers['content-type'] || '') || /^\s*[{[]/.test(raw) ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)); } catch (e) { b = {}; } }
      const given = String(req.headers['x-geams-key'] || u.searchParams.get('key') || b.key || '');
      if (!eq(given, KEY)) return json(res, 401, { error: 'Wrong key' });
      const rawFrom = String(b.from || b.sender || b.msisdn || b.phone || b.mobile || '').slice(0, 30), from = normPhone(rawFrom) || rawFrom || 'unknown';
      const text = String(b.text || b.message || b.body || b.content || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 500);
      if (!text.trim()) return json(res, 400, { error: 'Empty message' });
      if (!bump('sms|' + from, 10, 3600000)) return json(res, 429, { error: 'Too many messages from this number' });
      const m = /(-?\d{1,2}\.\d{3,})\s*[,;\s]\s*(-?\d{1,3}\.\d{3,})/.exec(text), lat = m ? parseFloat(m[1]) : null, lng = m ? parseFloat(m[2]) : null;
      const st = m && inGhana(lat, lng) ? nearestStationTo(lat, lng) : null, now = new Date().toISOString();
      if (st) {
        const key = 'lcr:' + st.id + ':incidents', map = Object.assign({}, kvGet(key, {})); let id; do { id = 'INC-S' + crypto.randomBytes(4).toString('hex').toUpperCase(); } while (map[id]);
        map[id] = { srv: { received: Date.now() }, id, type: /fire|burn|smoke/i.test(text) ? 'Fire' : /ambulance|medical|injur|hurt|accident|collision|bleed/i.test(text) ? 'Medical' : 'Crime', priority: 'critical', status: 'new', location: 'Reported by text message', lat, lng, civilianId: null, civilianName: 'Text message sender', civilianPhone: from, civilianVerified: false, civilianLat: lat, civilianLng: lng, createdAt: now, source: 'sms', officerName: null, officerBadge: null, officerETA: null, officerLat: null, officerLng: null, officerStatus: null, notes: text, resolvedAt: null };
        kvSet(key, map);
        if (process.env.GEAMS_SMS_URL && normPhone(from)) smsSend(normPhone(from), 'GEAMS received your alert. The ' + st.name + ' control room has been told.').catch(() => {});
        return json(res, 200, { ok: true, routed: true, id, station: st.id });
      }
      const inbox = Object.assign({}, kvGet('hq:smsInbox', {})), id = 'SMS-' + Date.now().toString(36);
      inbox[id] = { id, from, text, receivedAt: now, handled: false };
      const ks = Object.keys(inbox); if (ks.length > 200) ks.sort().slice(0, ks.length - 200).forEach(k => delete inbox[k]);
      kvSet('hq:smsInbox', inbox);
      return json(res, 202, { ok: true, routed: false, id, note: 'No location found; passed to HQ' });
    }
    // ── 112 operator hand-over: the national 112 service posts each call here so the nearest control room is told too ──
    // Needs an agreement with the 112 operator. Keyed (GEAMS_E112_KEY), safe to retry (same callId = same alert), logged.
    if (p === '/api/e112/inbound' && req.method === 'POST') {
      const KEY = process.env.GEAMS_E112_KEY;
      if (!KEY) return json(res, 501, { error: '112 hand-over is not set up on this server' });
      if (!bump('e112|bad|' + clientIp(req), 30, 600000)) return json(res, 429, { error: 'Too many attempts' });
      if (!eq(String(req.headers['x-geams-key'] || ''), KEY)) return json(res, 401, { error: 'Wrong key' });
      const b = await readBody(req); if (!isObj(b)) return json(res, 400, { error: 'Send JSON' });
      if (!bump('e112|ok', 1200, 3600000)) return json(res, 429, { error: 'Rate limit reached (1200 calls an hour)' });
      const callId = clean(b.callId, 64); if (!callId) return json(res, 400, { error: 'callId is required (the 112 centre\'s own call number: it makes retries safe)' });
      const id = 'INC-E' + crypto.createHash('sha256').update(callId).digest('hex').slice(0, 8).toUpperCase();
      const phone = normPhone(b.callerPhone) || clean(b.callerPhone, 30) || null, lat = parseFloat(b.lat), lng = parseFloat(b.lng);
      const t = String(b.type || '') + ' ' + String(b.note || ''), type = /fire|burn|smoke/i.test(t) ? 'Fire' : /ambulance|medical|injur|hurt|accident|collision|bleed/i.test(t) ? 'Medical' : 'Crime';
      const note = clean(b.note, 500), now = new Date().toISOString();
      if (isFinite(lat) && isFinite(lng) && inGhana(lat, lng)) {
        const st = nearestStationTo(lat, lng); if (st) {
          const key = 'lcr:' + st.id + ':incidents', map = Object.assign({}, kvGet(key, {}));
          if (map[id]) return json(res, 200, { ok: true, duplicate: true, id, station: st.id });
          map[id] = { srv: { received: Date.now() }, id, type, priority: 'critical', status: 'new', location: 'Reported through 112', lat, lng, civilianId: null, civilianName: clean(b.callerName, 60) || 'Caller via 112', civilianPhone: phone, civilianVerified: false, civilianLat: lat, civilianLng: lng, locationAccuracyM: isFinite(parseFloat(b.accuracyM)) ? Math.round(parseFloat(b.accuracyM)) : null, createdAt: now, source: 'e112', e112CallId: callId, officerName: null, officerBadge: null, officerETA: null, officerLat: null, officerLng: null, officerStatus: null, notes: note, resolvedAt: null };
          kvSet(key, map); staffLog({ role: 'system', user: 'e112' }, 'e112.routed', id, 'to ' + st.name, st.id); console.log('112 hand-over ' + callId + ' -> ' + st.name);
          return json(res, 200, { ok: true, routed: true, id, station: st.id, stationName: st.name });
        }
      }
      const inbox = Object.assign({}, kvGet('hq:smsInbox', {})), iid = 'E112-' + id.slice(5);
      if (inbox[iid]) return json(res, 200, { ok: true, duplicate: true, routed: false, id: iid });
      inbox[iid] = { id: iid, from: phone || 'unknown', text: '[112 hand-over, no usable location] ' + type + ' ' + note, receivedAt: now, handled: false, source: 'e112' };
      const ks = Object.keys(inbox); if (ks.length > 200) ks.sort().slice(0, ks.length - 200).forEach(k => delete inbox[k]);
      kvSet('hq:smsInbox', inbox); staffLog({ role: 'system', user: 'e112' }, 'e112.to_hq', iid, 'no usable location');
      return json(res, 202, { ok: true, routed: false, id: iid, note: 'No usable location in Ghana; passed to HQ to phone the caller' });
    }
    // ── Civilian phone verification by SMS (needs a configured SMS gateway) ──
    if (p === '/api/civilian/otp/request' && req.method === 'POST') {
      const b = await readBody(req), phone = normPhone(b.phone);
      if (!phone) return json(res, 400, { error: 'Enter a Ghana mobile number such as 024 123 4567' });
      if (!process.env.GEAMS_SMS_URL) return json(res, 501, { configured: false, error: 'SMS verification is not set up on this server yet.' });
      if (!bump('otp-ip|' + clientIp(req), 12, 3600000) || !bump('otp-ph|' + phone, 3, 15 * 60000)) return json(res, 429, { error: 'Too many codes requested. Try again later.' });
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0'), salt = crypto.randomBytes(8).toString('hex');
      otps.set(phone, { salt, hash: pwHash(code, salt), exp: Date.now() + 10 * 60000, tries: 0 });
      try { await smsSend(phone, 'GEAMS code: ' + code + '. It expires in 10 minutes. Do not share it.'); }
      catch (e) { otps.delete(phone); return json(res, 502, { error: /^The SMS service/.test(e.message) ? e.message : 'Could not reach the SMS service: ' + e.message }); }
      return json(res, 200, { sent: true, phone });
    }
    if (p === '/api/civilian/otp/verify' && req.method === 'POST') {
      const b = await readBody(req), phone = normPhone(b.phone), o = phone && otps.get(phone);
      if (!o || o.exp < Date.now()) return json(res, 400, { error: 'That code has expired. Ask for a new one.' });
      if (++o.tries > 5) { otps.delete(phone); return json(res, 429, { error: 'Too many wrong codes. Ask for a new one.' }); }
      if (!eq(pwHash(String(b.code || '').trim(), o.salt), o.hash)) return json(res, 401, { error: 'Wrong code' });
      otps.delete(phone);
      return json(res, 200, { token: issue(res, req, { r: 'civilian', u: 'civilian', p: phone, v: 1, d: devHash(b.secret) }, LONG_MS), phone, verified: true });
    }
    // ── Ghana Post GPS digital address → coordinates (needs a configured lookup service) ──
    if (p === '/api/ghanapost/resolve' && req.method === 'POST') {
      { const ss = sessionOf(req); if (!ss || ss.role !== 'hq') return json(res, 401, { error: 'Not signed in' }); }
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
      const az = authorize(req, key, req.method === 'GET' ? 'r' : 'w', false); if (az.code) return json(res, az.code, { error: az.error });
      if (az.ses && az.ses.role === 'lcr' && az.ses.sid) lcrSeen[az.ses.sid] = Date.now();     // a control room screen is open and talking to the server
      if (req.method === 'GET') {
        const e = store[key];
        if (e && az.ses && az.ses.role === 'civilian' && /^lcr:[^:]+:incidents$/.test(key)) {
          const mine = {}; for (const [id, r] of Object.entries(isObj(e.value) ? e.value : {})) if (canSee(r, az.ses.dev)) mine[id] = civView(r);
          return json(res, 200, { found: true, value: mine, v: e.v });
        }
        return json(res, 200, e ? { found: true, value: e.value, v: e.v } : { found: false, v: 0 });
      }
      if (req.method === 'PUT') {
        const b = await readBody(req);
        const cur = store[key];
        const curV = cur ? cur.v : 0;
        if (b.ifVersion !== undefined && b.ifVersion !== curV) {
          return json(res, 409, { conflict: true, v: curV });
        }
        { const ld = store['hq:lockdown'] && store['hq:lockdown'].value; if (ld && ld.on && az.ses && az.ses.role !== 'hq' && az.ses.role !== 'civilian') return json(res, 503, { error: 'HQ has put the system in read-only lockdown. Changes are paused.', lockdown: true }); }
        const prevVal = cur ? cur.value : undefined;
        if (az.ses && az.ses.role === 'civilian' && /^lcr:[^:]+:incidents$/.test(key)) {
          // a civilian only ever sees (and sends back) their own alerts: fold that view into the full record
          if (!isObj(b.value)) return json(res, 422, { error: 'Incidents must be a map keyed by incident id' });
          const all = isObj(prevVal) ? prevVal : {}, merged = Object.assign({}, all);
          for (const [id, rec] of Object.entries(b.value)) {
            const old = all[id];
            if (old && !canSee(old, az.ses.dev)) { console.log('REFUSED ' + key + ' (civilian): not their alert ' + id); return json(res, 403, { error: 'That alert belongs to someone else' }); }
            if (old && isObj(rec)) { if (old.ownerDev) rec.ownerDev = old.ownerDev; if (old.reporterDevs) rec.reporterDevs = old.reporterDevs; }
            merged[id] = rec;
          }
          b.value = merged;
        }
        const vr = validateWrite(key, prevVal, b.value, az.ses, az.m);
        if (vr.error) { console.log('REFUSED ' + key + ' (' + (az.ses && az.ses.role) + '): ' + vr.error); return json(res, 422, { error: vr.error }); }
        store[key] = { value: b.value, v: curV + 1, ts: Date.now() };
        logIncidentChanges(az.ses, key, prevVal, b.value); logCrewChanges(az.ses, key, prevVal, b.value);
        scheduleSave(key);
        broadcast({ key, v: curV + 1 });
        if (key === 'public:alerts') pushNewAlerts(prevVal, b.value);
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
      if (!file.startsWith(DIR + path.sep) || /geams-data|geams-server|geams-persist|geams-backups|geams-blobs|geams-hq-users|geams-secret|geams-vapid|\.db$|\.db-wal$|\.tar\.gz|\.key$|\.pem$|\.env/.test(file)) { res.writeHead(403); return res.end('Forbidden'); }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        if (path.extname(file) === '.html' && /<\/head>/i.test(buf.toString('utf8', 0, Math.min(buf.length, 200000)))) { buf = injectBuild(file, buf); }
        { const hd = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }; if (CSP && path.extname(file) === '.html') hd[CSP.name] = CSP.value; res.writeHead(200, hd); }
        res.end(buf);
      });
      return;
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    json(res, 400, { error: String(e.message || e) });
  }
});

const BACKUP_HOURS = process.env.GEAMS_BACKUP_HOURS === undefined ? 24 : parseFloat(process.env.GEAMS_BACKUP_HOURS) || 0;
let backupState = { at: null, ok: null, error: null, by: null }, backupBusy = false;
async function runBackup(by) {
  if (backupBusy) throw new Error('A backup is already running');
  backupBusy = true;
  try { await WRITER.flush(); const info = await PERSIST.makeBackup(() => store); backupState = { at: new Date().toISOString(), ok: true, error: null, by }; console.log('backup written: ' + info.name + ' (' + info.size + ' bytes, ' + info.keys + ' records, ' + info.blobFiles + ' files' + (info.encrypted ? ', encrypted' : '') + (info.offsite ? ', offsite ' + info.offsite : '') + ')'); return info; }
  catch (e) { backupState = { at: new Date().toISOString(), ok: false, error: e.message, by }; console.log('backup FAILED: ' + e.message); throw e; }
  finally { backupBusy = false; }
}
if (BACKUP_HOURS > 0) {
  const tick = () => { const last = PERSIST.listBackups()[0]; if (!last || Date.now() - Date.parse(last.createdAt) >= BACKUP_HOURS * 3600000) runBackup('schedule').catch(() => {}); };
  setTimeout(tick, parseInt(process.env.GEAMS_BACKUP_FIRST_MS, 10) || 30000); setInterval(tick, Math.max(2000, Math.min(BACKUP_HOURS * 3600000, 3600000))).unref();
}


/* ── Unanswered-alert watch ──
 * A new alert nobody has taken after GEAMS_ESCALATE_SECS (default 120) is flagged to HQ, with the nearest other control rooms and their phone
 * numbers. If that control room has no screen open at all, it is flagged sooner (GEAMS_ESCALATE_OFFLINE_SECS, default 45).
 * This only WARNS people. It never moves, reassigns or sends an alert by itself, and it carries no caller details, only type, priority and waiting time. */
const lcrSeen = {};
const BOOT_AT = Date.now();
const ESC = () => ({ secs: process.env.GEAMS_ESCALATE_SECS === undefined ? 120 : +process.env.GEAMS_ESCALATE_SECS, offlineSecs: process.env.GEAMS_ESCALATE_OFFLINE_SECS === undefined ? 45 : +process.env.GEAMS_ESCALATE_OFFLINE_SECS, graceSecs: process.env.GEAMS_ESCALATE_GRACE_SECS === undefined ? 90 : +process.env.GEAMS_ESCALATE_GRACE_SECS });
const lcrOnline = (sid) => Date.now() - (lcrSeen[sid] || 0) < 60000;
function nearestOthers(sid, n) {
  const reg = kvGet('registry:stations', {}), loc = kvGet('registry:stationLocations', {}), me = (isObj(loc) && loc[sid]) || (isObj(reg) && reg[sid]) || {};
  if (typeof me.lat !== 'number' || typeof me.lng !== 'number') return [];
  const out = []; for (const [id, r] of Object.entries(isObj(reg) ? reg : {})) { if (id === sid || !r || r.disabled) continue; const l = (isObj(loc) && loc[id]) || r; if (typeof l.lat !== 'number' || typeof l.lng !== 'number') continue;
    const d = hav(me.lat, me.lng, l.lat, l.lng); if (d <= 80000) out.push({ sid: id, name: String(r.name || id).slice(0, 80), km: Math.round(d / 100) / 10, phone: String(r.phone || r.contactPhone || r.controlPhone || '').slice(0, 30), online: lcrOnline(id) }); }
  return out.sort((a, b) => a.km - b.km).slice(0, 3);
}
function escalationSweep() {
  const c = ESC(); if (!(c.secs > 0)) return; const now = Date.now(), cur = kvGet('registry:escalations', {}), map = isObj(cur) ? cur : {}; let changed = false;
  const live = new Set(), grace = now - BOOT_AT < c.graceSecs * 1000;
  for (const k of Object.keys(store)) {
    const m = /^lcr:([^:]+):incidents$/.exec(k); if (!m) continue; const sid = m[1], inc = store[k].value; if (!isObj(inc)) continue;
    const off = !lcrOnline(sid) && !grace;
    for (const [id, r] of Object.entries(inc)) {
      if (!isObj(r) || r.status !== 'new' || r.drill) continue;
      const since = +incTime(r) || 0; if (!since) continue; const waited = (now - since) / 1000, key = sid + ':' + id;
      const reason = off && waited >= c.offlineSecs ? 'station_offline' : waited >= c.secs ? 'unanswered' : null; if (!reason) continue;
      live.add(key); const e = map[key];
      if (!e) { map[key] = { key, sid, station: stationMeta(sid).name, ref: id, type: String(r.type || '').slice(0, 40), priority: String(r.priority || '').slice(0, 12), since, flaggedAt: now, reason, neighbours: nearestOthers(sid, 3), open: true };
        staffLog({ role: 'system', user: 'server' }, 'escalation.flagged', id, reason + ' after ' + Math.round(waited) + 's', sid); changed = true; }
      else if (e.open) { if (e.reason !== reason) { e.reason = reason; changed = true; } e.waitedSecs = Math.round(waited); e.neighbours = nearestOthers(sid, 3); }
    }
  }
  for (const [key, e] of Object.entries(map)) {
    if (!e.open || live.has(key)) continue;
    const inc = store['lcr:' + e.sid + ':incidents'], r = inc && isObj(inc.value) ? inc.value[e.ref] : null;
    if (r && r.status === 'new' && !r.drill) continue;      // still waiting but below a threshold now (e.g. station came back); keep it open
    e.open = false; e.clearedAt = now; e.outcome = !r ? 'removed' : r.status === 'cancelled' ? 'cancelled' : 'taken'; e.waitedSecs = Math.round((((r && r.srv && (r.srv.assigned || r.srv.cancelled)) || now) - e.since) / 1000); changed = true;
    staffLog({ role: 'system', user: 'server' }, 'escalation.cleared', e.ref, e.outcome, e.sid);
  }
  const keys = Object.keys(map); if (keys.length > 500) { keys.filter(k => !map[k].open).sort((a, b) => (map[a].clearedAt || 0) - (map[b].clearedAt || 0)).slice(0, keys.length - 500).forEach(k => delete map[k]); changed = true; }
  if (changed) kvSet('registry:escalations', map);
}
setInterval(() => { try { escalationSweep(); } catch (e) { console.log('escalation sweep failed: ' + e.message); } }, Math.max(500, +process.env.GEAMS_ESCALATE_TICK_MS || 10000)).unref();

/* Agency escalation: a forwarded fire or ambulance alert that no crew has taken after the set time is flagged for that agency's HQ.
 * It also copies the later progress of a reassigned alert back to the first station so its control room still sees it. Warnings only: people must act. */
const AG_ESC = () => ({ secs: process.env.GEAMS_AGENCY_ESCALATE_SECS === undefined ? 120 : +process.env.GEAMS_AGENCY_ESCALATE_SECS });
function agencySweep() {
  const c = AG_ESC(); const now = Date.now(), cur = kvGet('registry:agencyEscalations', {}), map = isObj(cur) ? cur : {}; let changed = false; const live = new Set();
  for (const k of Object.keys(store)) {
    const m = /^(fire|ambulance):([^:]+):incidents$/.exec(k); if (!m || !isObj(store[k].value)) continue; const kind = m[1], sid = m[2];
    for (const [id, r] of Object.entries(store[k].value)) {
      if (!isObj(r) || r.drill) continue;
      if (r.reassignedTo) {   // mirror progress from the station that took it, so the first control room still sees it
        const d = store[kind + ':' + r.reassignedTo + ':incidents'], dr = d && isObj(d.value) ? d.value[id] : null;
        if (dr && dr.serviceStatus && dr.serviceStatus !== 'new' && (dr.serviceStatus !== r.serviceStatus || dr.unitName !== r.unitName || dr.unitETA !== r.unitETA)) {
          const v = Object.assign({}, store[k].value); v[id] = Object.assign({}, r, { serviceStatus: dr.serviceStatus, unitName: dr.unitName || null, unitBadge: dr.unitBadge || null, unitETA: dr.unitETA || null }); kvSet(k, v); }
        continue;
      }
      if (!c.secs || (r.serviceStatus || 'new') !== 'new') continue;
      const since = (r.srv && r.srv.forwarded) || r.forwardedAt || 0; if (!since) continue; const waited = (now - since) / 1000; if (waited < c.secs) continue;
      const key = kind + ':' + sid + ':' + id; live.add(key); const e = map[key];
      if (!e) { map[key] = { key, kind, sid, station: stationMeta(sid).name, ref: id, type: String(r.type || '').slice(0, 40), priority: String(r.priority || '').slice(0, 12), since, flaggedAt: now, reason: 'unanswered', waitedSecs: Math.round(waited), neighbours: nearestOthers(sid, 3), open: true };
        staffLog({ role: 'system', user: 'server' }, 'agency_' + kind + '.flagged', id, 'unanswered after ' + Math.round(waited) + 's', sid); changed = true; }
      else if (e.open) { e.waitedSecs = Math.round(waited); e.neighbours = nearestOthers(sid, 3); changed = true; }
    }
  }
  for (const [key, e] of Object.entries(map)) {
    if (!e.open || live.has(key)) continue;
    const d = store[e.kind + ':' + e.sid + ':incidents'], r = d && isObj(d.value) ? d.value[e.ref] : null;
    e.open = false; e.clearedAt = now; e.outcome = !r ? 'removed' : r.serviceStatus === 'reassigned' ? 'reassigned' : 'taken'; changed = true;
    staffLog({ role: 'system', user: 'server' }, 'agency_' + e.kind + '.cleared', e.ref, e.outcome, e.sid);
  }
  const keys = Object.keys(map); if (keys.length > 500) { keys.filter(k => !map[k].open).sort((a, b) => (map[a].clearedAt || 0) - (map[b].clearedAt || 0)).slice(0, keys.length - 500).forEach(k => delete map[k]); changed = true; }
  if (changed) kvSet('registry:agencyEscalations', map);
}
setInterval(() => { try { agencySweep(); } catch (e) { console.log('agency sweep failed: ' + e.message); } }, Math.max(500, +process.env.GEAMS_ESCALATE_TICK_MS || 10000)).unref();

/* ── Data retention: anonymise, then purge, closed incidents after the periods the operator sets ──
 * 0 (the default) means keep forever. Only closed incidents are touched; an incident on legal hold never is. */
const RET = () => ({ anonDays: +process.env.GEAMS_ANON_INCIDENT_DAYS || 0, purgeDays: +process.env.GEAMS_RETAIN_INCIDENT_DAYS || 0, faceAuditDays: +process.env.GEAMS_RETAIN_FACEAUDIT_DAYS || 0, auto: process.env.GEAMS_RETENTION_AUTO === '1' });
const CLOSED = /^(resolved|closed|cancelled|canceled|completed|false[_ -]?alarm|archived)$/i;
const incTime = (r) => (isObj(r.srv) && r.srv.received) || Date.parse(r.createdAt) || r.createdAt || 0;
const isPersonalKey = (k) => (/^(civilian|reporter|caller)/i.test(k) && !/^civilian(Cancelled)$/.test(k)) || ['ownerDev', 'reporterDevs', 'additionalReporters', 'evidencePhoto', 'phone', 'contact'].includes(k);
function retentionPlan(now) {
  now = now || Date.now(); const pol = RET(), DAY = 86400000, plan = { policy: pol, anonymise: [], purge: [], held: 0, faceAuditOld: 0, activeSkipped: 0 };
  const scan = (key, sid, kind) => { const m = store[key] && store[key].value; if (!isObj(m)) return;
    for (const [id, r] of Object.entries(m)) { if (!isObj(r)) continue;
      if (!(CLOSED.test(String(r.status || '')) || r.resolvedAt)) { plan.activeSkipped++; continue; }
      const t = +incTime(r); if (!t) continue; const age = (now - t) / DAY;
      if (r.legalHold || (kind !== 'lcr' && (((findIncident(id) || {}).rec) || {}).legalHold)) { plan.held++; continue; }
      if (pol.purgeDays && age >= pol.purgeDays) plan.purge.push({ key, id, kind, station: sid, ageDays: Math.floor(age) });
      else if (pol.anonDays && age >= pol.anonDays && !r.anonymisedAt) plan.anonymise.push({ key, id, kind, station: sid, ageDays: Math.floor(age) }); } };
  for (const k of Object.keys(store)) { const m = /^(lcr|fire|ambulance):([^:]+):incidents$/.exec(k); if (m) scan(k, m[2], m[1]); }
  if (pol.faceAuditDays) plan.faceAuditOld = kvGet('registry:faceAudit', []).filter(e => e && e.at && now - e.at >= pol.faceAuditDays * DAY).length;
  return plan;
}
function wipeIncidentFiles(id, log) {
  let files = 0; const dir = path.join(BLOB_DIR, safeSeg(id));
  try {
    if (!WRITER.enabled) { files = fs.readdirSync(dir).length; fs.rmSync(dir, { recursive: true, force: true }); }
    else for (const n of fs.readdirSync(dir)) { const fp = path.join(dir, n); fs.writeFileSync(fp, 'Removed by the retention policy on ' + new Date().toISOString().slice(0, 10)); WRITER.markFile(fp); files++; }  // the database copy is overwritten, not resurrected, at the next start
  } catch (e) {}
  return files;
}
function retentionRun(by, now) {
  const plan = retentionPlan(now), out = { anonymised: 0, purged: 0, keysCleared: 0, filesWiped: 0, faceAuditRemoved: 0 }, pol = plan.policy;
  const touched = {};
  for (const x of plan.anonymise) { const m = touched[x.key] || (touched[x.key] = Object.assign({}, store[x.key].value)); const r = m[x.id]; if (!r) continue; const n = {};
    for (const [k, v] of Object.entries(r)) { if (isPersonalKey(k)) continue; n[k] = v; }
    for (const k of ['lat', 'lng']) if (typeof n[k] === 'number') n[k] = Math.round(n[k] * 100) / 100;
    if (n.location) n.location = 'Location removed'; if (n.notes) n.notes = 'Removed'; if (n.description) n.description = 'Removed';
    n.anonymisedAt = Date.now(); m[x.id] = n; out.anonymised++; }
  for (const x of plan.purge) { const m = touched[x.key] || (touched[x.key] = Object.assign({}, store[x.key].value)); if (!m[x.id]) continue; delete m[x.id]; out.purged++;
    out.filesWiped += wipeIncidentFiles(x.id);
    for (const pre of ['chat', 'evidence', 'archive', 'rtc']) { const k = pre + ':' + x.id; if (store[k]) { if (WRITER.enabled) kvSet(k, { purgedAt: Date.now() }); else { delete store[k]; scheduleSave(k); } out.keysCleared++; } } }
  for (const [k, m] of Object.entries(touched)) kvSet(k, m);
  if (pol.faceAuditDays) { const keep = kvGet('registry:faceAudit', []).filter(e => !(e && e.at && (now || Date.now()) - e.at >= pol.faceAuditDays * 86400000)); out.faceAuditRemoved = kvGet('registry:faceAudit', []).length - keep.length; if (out.faceAuditRemoved) kvSet('registry:faceAudit', keep); }
  const lg = kvGet('registry:retentionLog', []).slice(-199); lg.push({ at: Date.now(), by, policy: { anonDays: pol.anonDays, purgeDays: pol.purgeDays, faceAuditDays: pol.faceAuditDays }, result: out }); kvSet('registry:retentionLog', lg);
  console.log('RETENTION run by ' + by + ': ' + JSON.stringify(out));
  return out;
}
if (RET().auto) { const tick = async () => { const pl = retentionPlan(); if (!(pl.anonymise.length || pl.purge.length || pl.faceAuditOld)) return; try { if (BACKUP_HOURS > 0) await runBackup('before-retention'); retentionRun('automatic'); } catch (e) { console.log('RETENTION auto run skipped: ' + e.message); } }; setTimeout(tick, 60000).unref(); setInterval(tick, 24 * 3600000).unref(); }
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return; shuttingDown = true; console.log('GEAMS stopping (' + sig + '): saving');
  try { writeStoreNow(); } catch (e) {}
  try { await Promise.race([WRITER.close(), new Promise(r => setTimeout(r, 6000))]); } catch (e) {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
const _seeded = seedDefaultStations(), _scrubbed = scrubLegacyUnits();
server.listen(PORT, process.env.GEAMS_BIND || '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  const ips = [].concat(...Object.values(nets)).filter(n => n.family === 'IPv4' && !n.internal).map(n => n.address);
  console.log('GEAMS backend running');
  console.log('  This computer:  http://localhost:' + PORT + '/');
  ips.forEach(ip => console.log('  Same network:   http://' + ip + ':' + PORT + '/   (GPS/camera on phones need https — see top of this file)'));
  console.log('  Data file:      ' + DATA_FILE + '   | Database: ' + (WRITER.enabled ? WRITER.kind + ' (records, accounts, keys and evidence are copied to it)' : 'none (data lives on this disk only; set GEAMS_DATABASE_URL to protect it)') + '   | Backups: ' + (BACKUP_HOURS > 0 ? 'every ' + BACKUP_HOURS + ' h, keep ' + (process.env.GEAMS_BACKUP_KEEP || 7) + (process.env.GEAMS_BACKUP_PASSPHRASE ? ', encrypted' : ', NOT encrypted (keys left out)') : 'off'));
  console.log('  HQ login:       user "' + OWNER + '"' + (ownerGenerated ? ' password ' + ownerPass + '   <-- generated for this run; set GEAMS_HQ_ADMIN_PASSWORD to choose your own' : ' (password from GEAMS_HQ_ADMIN_PASSWORD)'));
  console.log('  Crew approval:  ' + (AUTO_APPROVE ? 'OFF (GEAMS_AUTO_APPROVE_UNITS=1: crews work at once)' : 'ON (a control room approves its own crews)') + '  | Phone codes: ' + (process.env.GEAMS_SMS_URL ? 'SMS gateway configured' : 'no SMS gateway (civilians stay unverified)') + (REQUIRE_VERIFIED ? '  | verified phone REQUIRED for civilian accounts' : ''));
  console.log('  Push alerts:    web push ready (public key ' + VAPID.pub.slice(0, 12) + '…)  | Outside timestamp: ' + (TSA_URL ? new URL(TSA_URL).host + (TSA_CA ? ' (verified here)' : ' (stored, not verified here)') : 'off') + '  | Inbound SMS: ' + (process.env.GEAMS_SMS_INBOUND_KEY ? 'on' : 'off'));
  console.log('  Permissions:    signed tokens, per-record role rules, field-level checks' + (_seeded ? '  | DEMO: default station passphrases seeded (' + _seeded + ')' : '') + (_scrubbed ? '  | moved ' + _scrubbed + ' old account hash(es) off the readable lists' : ''));
  console.log('  Ghana Post GPS: ' + (process.env.GHANAPOST_LOOKUP_URL ? 'lookup service configured' : 'lookup not configured (HQ can still enter coordinates or search a place)'));
});
