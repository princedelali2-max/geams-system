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
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, X-Geams-Name');
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

    if (p.startsWith('/api/kv/')) {
      const key = decodeURIComponent(p.slice(8));
      if (!key || key.length > 300) return json(res, 400, { error: 'bad key' });
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
      if (!file.startsWith(DIR + path.sep) || /geams-data|geams-server|geams-blobs/.test(file)) { res.writeHead(403); return res.end('Forbidden'); }
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
});
