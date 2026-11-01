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
/* ── Signed tokens ──
 * Every sign-in (HQ, control room, officer, fire, ambulance, civilian) returns a token signed with a
 * server secret (GEAMS_TOKEN_SECRET, else a random one saved next to the data file so tokens survive a
 * restart). The token says WHO the caller is and WHICH ROLE they hold; the server decides access from it.
 * It is sent as "Authorization: Bearer ..." and, for images/video/audio tags that cannot send headers,
 * as an HttpOnly cookie that is accepted for reading files only. */
const SECRET_FILE = path.join(path.dirname(DATA_FILE), 'geams-secret.key');
let TOKEN_SECRET = process.env.GEAMS_TOKEN_SECRET;
if (!TOKEN_SECRET) { try { TOKEN_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (e) {} }
if (!TOKEN_SECRET) { TOKEN_SECRET = crypto.randomBytes(32).toString('hex'); try { fs.writeFileSync(SECRET_FILE, TOKEN_SECRET, { mode: 0o600 }); } catch (e) {} }
const revoked = new Set();
const SESSION_MS = 12 * 3600 * 1000, LONG_MS = 7 * 24 * 3600 * 1000;
function signToken(payload, ms) {
  const p = Object.assign({}, payload, { iat: Date.now(), exp: Date.now() + ms, jti: crypto.randomBytes(8).toString('hex') });
  const body = Buffer.from(JSON.stringify(p)).toString('base64url');
  return 'v1.' + body + '.' + crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
}
function verifyToken(t) {
  const m = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(t || '')); if (!m) return null;
  const want = crypto.createHmac('sha256', TOKEN_SECRET).update(m[1]).digest('base64url'); if (!eq(want, m[2])) return null;
  let p; try { p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!p || p.exp < Date.now() || revoked.has(p.jti)) return null;
  if (p.r === 'hq' && p.hr !== 'admin') { const u = hqUsers[p.u]; if (!u || (u.changed && u.changed > p.iat)) return null; }
  if (p.r === 'lcr') { const st = (store['registry:stations'] && store['registry:stations'].value || {})[p.s]; if (st && st.disabled) return null; }
  return p;
}
function rawToken(req, allowCookie) {
  const m = /^Bearer (v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(String(req.headers.authorization || '')); if (m) return m[1];
  if (allowCookie) { const c = /(?:^|;\s*)geams_t=(v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(String(req.headers.cookie || '')); if (c) return c[1]; }
  return null;
}
function sessionOf(req, allowCookie) {
  const p = verifyToken(rawToken(req, allowCookie)); if (!p) return null;
  return { role: p.r, user: p.u, hqRole: p.hr, sid: p.s, lcr: p.l, badge: p.b, id: p.i, phone: p.p, verified: !!p.v, jti: p.jti };
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
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

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
  try { fs.appendFileSync(fp + '.log', JSON.stringify(ev) + '\n'); } catch (e) {}
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
  fs.writeFileSync(fp + '.seal', JSON.stringify(seal));
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
  if (n) { store[SECRET_KEY] = { value: map, v: (cur ? cur.v : 0) + 1, ts: Date.now() }; scheduleSave(); }
  return n;
}

/* ── Who may read and write what ──
 * One rule per family of shared records. 'public' = no sign-in needed (read only),
 * 'server' = only the server itself, otherwise the list of roles that may do it.
 * Honest limit: a record is one shared map, so the server decides by ROLE (and, for a control room's own
 * roster, by station), not field by field. Officers, fire and ambulance crews are not yet fenced to their own
 * station on the server (planned with per-station data rooms). */
const ALL_R = ['hq', 'lcr', 'officer', 'fire', 'ambulance', 'civilian'];
const RULES = [
  [/^registry:(stationAuth|unitAuth|unitPending|pushSubs)$/, { r: 'server', w: 'server' }],
  [/^registry:stations$/, { r: 'public', w: ['hq'] }],
  [/^registry:stationLocations$/, { r: 'public', w: ['hq', 'lcr'] }],
  [/^registry:lcrCommanders$/, { r: ['hq', 'lcr', 'officer'], w: ['hq', 'lcr'] }],
  [/^registry:(officers|fire|ambulance)$/, { r: ['hq', 'lcr', 'officer', 'fire', 'ambulance'], w: 'server' }],
  [/^registry:civilians$/, { r: ['hq', 'lcr', 'civilian'], w: ['hq', 'civilian'] }],
  [/^registry:faces$/, { r: ['hq', 'lcr', 'officer', 'civilian'], w: ['hq', 'civilian'] }],
  [/^hq:tacticalOps$/, { r: ['hq', 'lcr'], w: ['hq'] }],
  [/^hq:lcr_status$/, { r: ['hq', 'lcr'], w: ['hq', 'lcr'] }],
  [/^public:alerts$/, { r: ALL_R, w: ['hq'] }],
  [/^hq:smsInbox$/, { r: ['hq'], w: ['hq'] }],
  [/^public:ack:[^:]+$/, { r: ['hq', 'lcr'], w: ALL_R }],
  [/^lcr:([^:]+):incidents$/, { r: ALL_R, w: ['hq', 'lcr', 'officer', 'civilian'], fence: true }],
  [/^lcr:([^:]+):officers$/, { r: ALL_R, w: ['hq', 'lcr', 'officer'], own: true, fence: true }],
  [/^lcr:([^:]+):officerAlerts$/, { r: ['hq', 'lcr', 'officer'], w: ['hq', 'lcr', 'officer'], own: true, fence: true }],
  [/^fire:([^:]+):incidents$/, { r: ['hq', 'lcr', 'fire'], w: ['hq', 'lcr', 'fire'], fence: true }],
  [/^ambulance:([^:]+):incidents$/, { r: ['hq', 'lcr', 'ambulance'], w: ['hq', 'lcr', 'ambulance'], fence: true }],
  [/^mutualaid:(fire|ambulance):requests$/, { r: ['hq', 'lcr', 'fire', 'ambulance'], w: ['hq', 'lcr', 'fire', 'ambulance'] }],
  [/^backup:/, { r: ['hq', 'lcr'], w: ['hq', 'lcr'] }],
  [/^(chat|evidence|archive|rtc):/, { r: ALL_R, w: ALL_R }],
];
function authorize(req, key, action, allowCookie) {
  let rule = { r: 'auth', w: 'auth' }, m = null;
  for (const [re, rl] of RULES) { m = re.exec(key); if (m) { rule = rl; break; } }
  const need = rule[action];
  if (need === 'server') return { code: 403, error: 'This data is private to the server' };
  if (need === 'public' && action === 'r') return { ses: sessionOf(req, allowCookie) };
  const ses = sessionOf(req, allowCookie);
  if (!ses) return { code: 401, error: 'Sign in required' };
  if (Array.isArray(need) && !need.includes(ses.role)) return { code: 403, error: 'Your role (' + ses.role + ') cannot ' + (action === 'r' ? 'read' : 'write') + ' this data' };
  if (action === 'w' && rule.own && ses.role === 'lcr' && m && m[1] && ses.sid !== m[1]) return { code: 403, error: 'A control room can only change its own roster' };
  // officers, fire and ambulance crews only reach their own station's data
  if (rule.fence && m && m[1] && ['officer', 'fire', 'ambulance'].includes(ses.role) && ses.lcr !== m[1]) return { code: 403, error: 'That belongs to another control room' };
  return { ses, rule, m };
}

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
    fs.writeFileSync(fp + '.tsa', JSON.stringify({ sha256: seal.sha256, at: Date.now(), tsa: new URL(TSA_URL).host, tsq: tsq.toString('base64'), tsr: reply.toString('base64') }));
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
  if (!jwk) { jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' }); try { fs.writeFileSync(VAPID_FILE, JSON.stringify(jwk), { mode: 0o600 }); } catch (e) {} }
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
  // incidents of a control room
  if (/^lcr:[^:]+:incidents$/.test(key)) {
    if (!isObj(nextV)) return { error: 'Incidents must be a map keyed by incident id' };
    const prev = isObj(prevV) ? prevV : {};
    for (const id of Object.keys(prev)) if (!(id in nextV) && role !== 'hq' && role !== 'lcr') return { error: 'Only a control room can remove an incident' };
    for (const [id, rec] of Object.entries(nextV)) {
      if (!isObj(rec) || (rec.id !== undefined && rec.id !== id)) return { error: 'Incident ' + id + ' is malformed' };
      const old = prev[id];
      if (old && same(old, rec)) continue;
      if (role === 'civilian') {
        if (!old) {
          if (rec.status !== 'new' || rec.officerName || rec.officerBadge || rec.officerStatus || rec.officerETA) return { error: 'A civilian can only raise a new alert' };
          if (rec.lat != null && rec.lng != null && !inGhana(rec.lat, rec.lng)) return { error: 'The alert position is outside Ghana' };
          rec.civilianVerified = !!ses.verified;                   // stamped by the server, never by the caller
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
        for (const k of ['id', 'civilianId', 'civilianName', 'civilianPhone', 'createdAt', 'source', 'type', 'priority', 'lat', 'lng']) if (!same(old[k], rec[k])) return { error: 'An officer cannot change "' + k + '"' };
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
  store[key] = { value, v, ts: Date.now() }; scheduleSave();
  if (!/^registry:(stationAuth|unitAuth|unitPending|pushSubs)$/.test(key)) broadcast({ key, v });
}

/* ── Officer, fire and ambulance accounts live on the server ── */
const UNIT = {
  officer:   { key: 'registry:officers',  prefix: 'GH-',   idf: 'officerId', idp: 'OFF-' },
  fire:      { key: 'registry:fire',      prefix: 'GHFS-', idf: 'crewId',    idp: 'FIRE-' },
  ambulance: { key: 'registry:ambulance', prefix: 'GNAS-', idf: 'crewId',    idp: 'MEDIC-' },
};
const UNIT_AUTH = 'registry:unitAuth', UNIT_PENDING = 'registry:unitPending';
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
      { const ses = sessionOf(req, req.method === 'GET'); const w = req.method === 'PUT' || req.method === 'POST';
        if (!ses) return json(res, 401, { error: 'Sign in required' });
        if (w && !['hq', 'lcr', 'officer', 'civilian'].includes(ses.role)) return json(res, 403, { error: 'Your role cannot upload evidence' }); }
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
        try { fs.writeFileSync(fp + '.type', ct); } catch (e) {}
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
      if (!sessionOf(req, true)) return json(res, 401, { error: 'Sign in required' });
      const inc = decodeURIComponent(p.slice(11));
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
      store[SECRET_KEY] = { value: map, v: (cur ? cur.v : 0) + 1, ts: Date.now() }; scheduleSave();
      return json(res, 200, { passphrase: pass });
    }
    if (p === '/api/lcr/login' && req.method === 'POST') {
      const b = await readBody(req), id = String(b.stationId || ''), k = clientIp(req) + '|' + id;
      const wait = lockedOut(k); if (wait) return json(res, 429, { error: 'Too many failed attempts. Try again in ' + Math.ceil(wait / 60) + ' min.' });
      const reg = store['registry:stations'] && store['registry:stations'].value || {};
      const st = reg[id] || {}; const a = store[SECRET_KEY] && store[SECRET_KEY].value && store[SECRET_KEY].value[id];
      if (!reg[id] && !BUILTIN_STATIONS.includes(id)) return json(res, 404, { error: 'Unknown Station ID' });
      if (!a) return json(res, 404, { error: 'HQ has not issued a login for this control room yet' });
      if (st.disabled) return json(res, 403, { error: 'This control room has been disabled by HQ' });
      if (!eq(pwHash(b.passphrase || '', a.salt), a.hash)) { noteFail(k); return json(res, 401, { error: 'Incorrect passphrase for this Station ID' }); }
      fails.delete(k);
      return json(res, 200, { ok: true, token: issue(res, req, { r: 'lcr', s: id, u: id }, SESSION_MS) });
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
        return json(res, 202, { pending: true, message: 'Registered. Your control room must approve you before you can sign in.' });
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
      const hit = list.filter(x => String(x.name).toLowerCase() === name.toLowerCase()).find(x => unitOk({ kind, cred: x }, name, String(b.password || '')));
      if (!hit) {
        const pend = Object.values(kvGet(UNIT_PENDING, {})).find(x => x.kind === kind && String(x.cred.name).toLowerCase() === name.toLowerCase() && unitOk({ kind, cred: x.cred }, name, String(b.password || '')));
        if (pend) return json(res, 403, { error: 'Your registration is waiting for approval by your control room.' });
        noteFail(k); return json(res, 401, { error: 'Invalid name or password' });
      }
      fails.delete(k);
      return json(res, 200, { token: unitToken(res, req, kind, hit), cred: hit });
    }
    // ── Civilian device session (open sign-in, no identity proof yet: phone verification is planned) ──
    if (p === '/api/civilian/session' && req.method === 'POST') {
      if (!bump('civ|' + clientIp(req), 120, 10 * 60000)) return json(res, 429, { error: 'Too many sessions from this address. Try again shortly.' });
      return json(res, 200, { token: issue(res, req, { r: 'civilian', u: 'civilian' }, LONG_MS) });
    }
    // ── Response-time analytics (HQ: everything; control room: its own area) ──
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
        const nid = id || 'INC-I' + (100000 + crypto.randomInt(0, 900000));
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
      const ses = sessionOf(req); if (!ses || !['lcr', 'hq'].includes(ses.role)) return json(res, 401, { error: 'Sign in as a control room or HQ' });
      const list = Object.values(kvGet(UNIT_PENDING, {})).filter(x => ses.role === 'hq' || x.cred.lcrId === ses.sid).map(x => ({ kind: x.kind, badge: x.cred.badge, name: x.cred.name, rank: x.cred.rank, phone: x.cred.phone, vehicle: x.cred.vehicle, lcrId: x.cred.lcrId, requestedAt: x.requestedAt }));
      return json(res, 200, { pending: list });
    }
    if (p === '/api/lcr/approve' && req.method === 'POST') {
      const ses = sessionOf(req); if (!ses || !['lcr', 'hq'].includes(ses.role)) return json(res, 401, { error: 'Sign in as a control room or HQ' });
      const b = await readBody(req), id = String(b.kind) + ':' + String(b.badge), pend = Object.assign({}, kvGet(UNIT_PENDING, {})), x = pend[id];
      if (!x) return json(res, 404, { error: 'No such request (it may already have been handled)' });
      if (ses.role === 'lcr' && x.cred.lcrId !== ses.sid) return json(res, 403, { error: 'That crew belongs to another control room' });
      delete pend[id]; kvSet(UNIT_PENDING, pend);
      if (b.approve) { const U = UNIT[x.kind], list = Array.isArray(kvGet(U.key, null)) ? kvGet(U.key, []).slice() : []; list.push(x.cred); kvSet(U.key, list); }
      else { const ua = Object.assign({}, kvGet(UNIT_AUTH, {})); delete ua[id]; kvSet(UNIT_AUTH, ua); }
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
        const id = 'INC-S' + (1000 + crypto.randomInt(0, 9000)), key = 'lcr:' + st.id + ':incidents', map = Object.assign({}, kvGet(key, {}));
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
      return json(res, 200, { token: issue(res, req, { r: 'civilian', u: 'civilian', p: phone, v: 1 }, LONG_MS), phone, verified: true });
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
        const prevVal = cur ? cur.value : undefined;
        const vr = validateWrite(key, prevVal, b.value, az.ses, az.m);
        if (vr.error) { console.log('REFUSED ' + key + ' (' + (az.ses && az.ses.role) + '): ' + vr.error); return json(res, 422, { error: vr.error }); }
        store[key] = { value: b.value, v: curV + 1, ts: Date.now() };
        scheduleSave();
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
      if (!file.startsWith(DIR + path.sep) || /geams-data|geams-server|geams-blobs|geams-hq-users|geams-secret|geams-vapid|\.key$|\.pem$|\.env/.test(file)) { res.writeHead(403); return res.end('Forbidden'); }
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

const _seeded = seedDefaultStations(), _scrubbed = scrubLegacyUnits();
server.listen(PORT, '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  const ips = [].concat(...Object.values(nets)).filter(n => n.family === 'IPv4' && !n.internal).map(n => n.address);
  console.log('GEAMS backend running');
  console.log('  This computer:  http://localhost:' + PORT + '/');
  ips.forEach(ip => console.log('  Same network:   http://' + ip + ':' + PORT + '/   (GPS/camera on phones need https — see top of this file)'));
  console.log('  Data file:      ' + DATA_FILE);
  console.log('  HQ login:       user "' + OWNER + '"' + (ownerGenerated ? ' password ' + ownerPass + '   <-- generated for this run; set GEAMS_HQ_ADMIN_PASSWORD to choose your own' : ' (password from GEAMS_HQ_ADMIN_PASSWORD)'));
  console.log('  Crew approval:  ' + (AUTO_APPROVE ? 'OFF (GEAMS_AUTO_APPROVE_UNITS=1: crews work at once)' : 'ON (a control room approves its own crews)') + '  | Phone codes: ' + (process.env.GEAMS_SMS_URL ? 'SMS gateway configured' : 'no SMS gateway (civilians stay unverified)') + (REQUIRE_VERIFIED ? '  | verified phone REQUIRED for civilian accounts' : ''));
  console.log('  Push alerts:    web push ready (public key ' + VAPID.pub.slice(0, 12) + '…)  | Outside timestamp: ' + (TSA_URL ? new URL(TSA_URL).host + (TSA_CA ? ' (verified here)' : ' (stored, not verified here)') : 'off') + '  | Inbound SMS: ' + (process.env.GEAMS_SMS_INBOUND_KEY ? 'on' : 'off'));
  console.log('  Permissions:    signed tokens, per-record role rules, field-level checks' + (_seeded ? '  | DEMO: default station passphrases seeded (' + _seeded + ')' : '') + (_scrubbed ? '  | moved ' + _scrubbed + ' old account hash(es) off the readable lists' : ''));
  console.log('  Ghana Post GPS: ' + (process.env.GHANAPOST_LOOKUP_URL ? 'lookup service configured' : 'lookup not configured (HQ can still enter coordinates or search a place)'));
});
