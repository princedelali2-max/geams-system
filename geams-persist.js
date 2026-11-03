#!/usr/bin/env node
/* GEAMS storage and backup layer.
 *
 * Without a database URL GEAMS keeps data in files next to the server, as before.
 * With GEAMS_DATABASE_URL (or DATABASE_URL) every incident record, HQ account, signing key and evidence file is also
 * written to a database, and restored from it when the server starts on an empty disk.
 *     postgres://user:pass@host:5432/dbname      PostgreSQL (needs the "pg" package: npm install pg)
 *     sqlite:/path/to/geams.db                   SQLite file (Node 22.5 or newer, no package needed)
 * A SQLite file on the same disk does NOT protect against a wiped disk. Use PostgreSQL, or a SQLite file on a persistent disk.
 *
 * Command line:   node geams-persist.js preboot | verify <backup> | restore <backup> [--force] | backup | status
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFileSync, spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');

const DATA_FILE = process.env.GEAMS_DATA || path.join(__dirname, 'geams-data.json');
const BASE = path.dirname(DATA_FILE);
const BLOB_DIR = process.env.GEAMS_BLOBS || path.join(BASE, 'geams-blobs');
const BACKUP_DIR = process.env.GEAMS_BACKUP_DIR || path.join(BASE, 'geams-backups');
const USERS_FILE = process.env.GEAMS_HQ_USERS || path.join(BASE, 'geams-hq-users.json');
const SECRET_FILE = path.join(BASE, 'geams-secret.key');
const VAPID_FILE = path.join(BASE, 'geams-vapid.json');
const MAX_FILE = (parseFloat(process.env.GEAMS_DB_MAX_FILE_MB) || 64) * 1024 * 1024;
const DB_URL = process.env.GEAMS_DATABASE_URL || process.env.DATABASE_URL || '';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/* files the database keeps copies of: logical name -> real path */
function mirrored() {
  const m = { 'hq-users.json': USERS_FILE, 'secret.key': SECRET_FILE, 'vapid.json': VAPID_FILE };
  return m;
}
function logicalName(fp) {
  const fixed = Object.entries(mirrored()).find(([, p]) => path.resolve(p) === path.resolve(fp)); if (fixed) return fixed[0];
  const rel = path.relative(BLOB_DIR, fp); if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return 'blobs/' + rel.split(path.sep).join('/');
  return null;
}
function physicalPath(name) {
  if (mirrored()[name]) return mirrored()[name];
  if (name.startsWith('blobs/')) { const p = path.join(BLOB_DIR, ...name.slice(6).split('/')); return p.startsWith(BLOB_DIR + path.sep) && !name.includes('..') ? p : null; }
  return null;
}

/* ── adapters ── */
async function openDb(url) {
  if (!url) return null;
  let db;
  if (/^postgres(ql)?:/i.test(url)) {
    let pg; try { pg = require('pg'); } catch (e) { throw new Error('A PostgreSQL address is set, but the "pg" package is not installed. Run: npm install pg'); }
    const ssl = process.env.GEAMS_DATABASE_SSL === '1' ? { rejectUnauthorized: false } : undefined;
    const pool = new pg.Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 8000, idleTimeoutMillis: 30000, ssl });
    pool.on('error', () => {});
    const q = (sql, p) => pool.query(sql, p);
    db = {
      kind: 'postgres',
      async init() {
        await q('CREATE TABLE IF NOT EXISTS geams_kv (k TEXT PRIMARY KEY, val TEXT NOT NULL, v BIGINT NOT NULL, ts BIGINT NOT NULL)');
        await q('CREATE TABLE IF NOT EXISTS geams_files (name TEXT PRIMARY KEY, data BYTEA NOT NULL, size BIGINT NOT NULL, sha256 TEXT NOT NULL, mtime BIGINT NOT NULL)');
      },
      async kvAll() { return (await q('SELECT k, val, v, ts FROM geams_kv')).rows.map(r => ({ k: r.k, val: r.val, v: Number(r.v), ts: Number(r.ts) })); },
      async kvPut(rows) {
        const c = await pool.connect(); try { await c.query('BEGIN');
          for (const r of rows) await c.query('INSERT INTO geams_kv (k,val,v,ts) VALUES ($1,$2,$3,$4) ON CONFLICT (k) DO UPDATE SET val=EXCLUDED.val, v=EXCLUDED.v, ts=EXCLUDED.ts', [r.k, r.val, r.v, r.ts]);
          await c.query('COMMIT'); } catch (e) { try { await c.query('ROLLBACK'); } catch (x) {} throw e; } finally { c.release(); }
      },
      async kvClear() { await q('DELETE FROM geams_kv'); },
      async fileList() { return (await q('SELECT name, size, sha256, mtime FROM geams_files')).rows.map(r => ({ name: r.name, size: Number(r.size), sha256: r.sha256, mtime: Number(r.mtime) })); },
      async fileGet(name) { const r = (await q('SELECT data FROM geams_files WHERE name=$1', [name])).rows[0]; return r ? r.data : null; },
      async filePut(name, buf, mtime) { await q('INSERT INTO geams_files (name,data,size,sha256,mtime) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (name) DO UPDATE SET data=EXCLUDED.data, size=EXCLUDED.size, sha256=EXCLUDED.sha256, mtime=EXCLUDED.mtime', [name, buf, buf.length, sha(buf), mtime]); },
      async fileClear() { await q('DELETE FROM geams_files'); },
      async ping() { await q('SELECT 1'); },
      async close() { await pool.end(); }
    };
  } else {
    let sq; try { sq = require('node:sqlite'); } catch (e) { throw new Error('SQLite storage needs Node 22.5 or newer (this is ' + process.version + '). Use a PostgreSQL address instead.'); }
    const file = url.replace(/^sqlite:(\/\/)?/i, '') || path.join(BASE, 'geams.db'); fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const d = new sq.DatabaseSync(file); d.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
    db = {
      kind: 'sqlite', file,
      async init() {
        d.exec('CREATE TABLE IF NOT EXISTS geams_kv (k TEXT PRIMARY KEY, val TEXT NOT NULL, v INTEGER NOT NULL, ts INTEGER NOT NULL)');
        d.exec('CREATE TABLE IF NOT EXISTS geams_files (name TEXT PRIMARY KEY, data BLOB NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, mtime INTEGER NOT NULL)');
      },
      async kvAll() { return d.prepare('SELECT k, val, v, ts FROM geams_kv').all().map(r => ({ k: r.k, val: r.val, v: Number(r.v), ts: Number(r.ts) })); },
      async kvPut(rows) { d.exec('BEGIN'); try { const st = d.prepare('INSERT INTO geams_kv (k,val,v,ts) VALUES (?,?,?,?) ON CONFLICT(k) DO UPDATE SET val=excluded.val, v=excluded.v, ts=excluded.ts'); for (const r of rows) st.run(r.k, r.val, r.v, r.ts); d.exec('COMMIT'); } catch (e) { try { d.exec('ROLLBACK'); } catch (x) {} throw e; } },
      async kvClear() { d.exec('DELETE FROM geams_kv'); },
      async fileList() { return d.prepare('SELECT name, size, sha256, mtime FROM geams_files').all().map(r => ({ name: r.name, size: Number(r.size), sha256: r.sha256, mtime: Number(r.mtime) })); },
      async fileGet(name) { const r = d.prepare('SELECT data FROM geams_files WHERE name=?').get(name); return r ? Buffer.from(r.data) : null; },
      async filePut(name, buf, mtime) { d.prepare('INSERT INTO geams_files (name,data,size,sha256,mtime) VALUES (?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET data=excluded.data, size=excluded.size, sha256=excluded.sha256, mtime=excluded.mtime').run(name, buf, buf.length, sha(buf), mtime); },
      async fileClear() { d.exec('DELETE FROM geams_files'); },
      async ping() { d.prepare('SELECT 1').get(); },
      async close() { d.close(); }
    };
  }
  await db.init();
  return db;
}

function walk(dir, out) { out = out || []; let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; } for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } return out; }
function readLocalStore() { try { const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; } }
function writeAtomic(fp, data) { fs.mkdirSync(path.dirname(fp), { recursive: true }); const t = fp + '.tmp'; fs.writeFileSync(t, data); fs.renameSync(t, fp); }

/* ── start-up: make the disk match the database (runs before the server loads its files) ── */
async function preboot(log) {
  log = log || console.log; const db = await openDb(DB_URL); if (!db) return { skipped: true };
  const res = { kvFromDb: 0, kvToDb: 0, filesFromDb: 0, filesToDb: 0, skippedBig: 0 };
  try {
    const rows = await db.kvAll(), local = readLocalStore(), merged = {}, push = [];
    for (const r of rows) { try { merged[r.k] = { value: JSON.parse(r.val), v: r.v, ts: r.ts }; } catch (e) { log('  Storage: skipped an unreadable database row ' + r.k); } }
    res.kvFromDb = Object.keys(merged).length;
    for (const [k, rec] of Object.entries(local)) {
      if (!rec || typeof rec !== 'object' || typeof rec.v !== 'number') continue;
      const d = merged[k]; if (!d || rec.v > d.v || (rec.v === d.v && rec.ts > d.ts && JSON.stringify(rec.value) !== JSON.stringify(d.value))) { merged[k] = rec; push.push({ k, val: JSON.stringify(rec.value), v: rec.v, ts: rec.ts }); }
    }
    if (push.length) { for (let i = 0; i < push.length; i += 200) await db.kvPut(push.slice(i, i + 200)); res.kvToDb = push.length; }
    if (Object.keys(merged).length) writeAtomic(DATA_FILE, JSON.stringify(merged));
    const have = new Map((await db.fileList()).map(f => [f.name, f]));
    const names = new Set(have.keys());
    for (const [n, p] of Object.entries(mirrored())) if (fs.existsSync(p)) names.add(n);
    for (const p of walk(BLOB_DIR)) { const n = logicalName(p); if (n) names.add(n); }
    for (const n of names) {
      const p = physicalPath(n); if (!p) continue; const d = have.get(n); let st = null; try { st = fs.statSync(p); } catch (e) {}
      if (d && !st) { if (d.size > MAX_FILE) { res.skippedBig++; continue; } const buf = await db.fileGet(n); if (buf) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf, n === 'secret.key' || n === 'vapid.json' ? { mode: 0o600 } : undefined); fs.utimesSync(p, new Date(d.mtime), new Date(d.mtime)); res.filesFromDb++; } }
      else if (!d && st) { if (st.size > MAX_FILE) { res.skippedBig++; continue; } await db.filePut(n, fs.readFileSync(p), Math.round(st.mtimeMs)); res.filesToDb++; }
      else if (d && st && d.size !== st.size) {
        if (Math.round(st.mtimeMs) > d.mtime && st.size <= MAX_FILE) { await db.filePut(n, fs.readFileSync(p), Math.round(st.mtimeMs)); res.filesToDb++; }
        else if (d.mtime >= Math.round(st.mtimeMs) && d.size <= MAX_FILE) { const buf = await db.fileGet(n); if (buf) { fs.writeFileSync(p, buf); fs.utimesSync(p, new Date(d.mtime), new Date(d.mtime)); res.filesFromDb++; } }
      }
    }
  } finally { await db.close(); }
  log('  Storage:        ' + (DB_URL.startsWith('postgres') ? 'PostgreSQL' : 'SQLite') + ' ready. Restored from it: ' + res.kvFromDb + ' records, ' + res.filesFromDb + ' files. Copied into it: ' + res.kvToDb + ' records, ' + res.filesToDb + ' files.' + (res.skippedBig ? ' ' + res.skippedBig + ' files over the size cap were left out.' : ''));
  return res;
}

/* ── run-time writer used by the server ── */
function createWriter() {
  const W = { enabled: !!DB_URL, kind: DB_URL ? (/^postgres/i.test(DB_URL) ? 'postgres' : 'sqlite') : 'files', ok: true, lastError: null, lastFlush: null, lastOkFlush: null, pending: 0, flushed: 0 };
  let db = null, dirtyKV = new Map(), dirtyFiles = new Set(), timer = null, flushing = null, getStore = null, connecting = null;
  const connect = async () => { if (db) return db; if (!connecting) connecting = openDb(DB_URL).then(d => { db = d; return d; }).catch(e => { connecting = null; throw e; }); return connecting; };
  W.attach = (storeGetter) => { getStore = storeGetter; if (W.enabled) connect().catch(e => { W.ok = false; W.lastError = String(e.message || e); console.log('Storage: cannot reach the database:', W.lastError); }); };
  const sched = (ms) => { if (!W.enabled || timer) return; timer = setTimeout(() => { timer = null; W.flush().catch(() => {}); }, ms); };
  W.markKV = (key) => { if (!W.enabled) return; if (key == null) { const s = getStore ? getStore() : {}; for (const k of Object.keys(s)) dirtyKV.set(k, true); } else dirtyKV.set(key, true); W.pending = dirtyKV.size + dirtyFiles.size; sched(400); };
  W.markFile = (fp) => { if (!W.enabled) return; const n = logicalName(fp); if (!n) return; dirtyFiles.add(n); W.pending = dirtyKV.size + dirtyFiles.size; sched(1500); };
  W.flush = async () => {
    if (!W.enabled) return;
    if (flushing) { await flushing.catch(() => {}); if (!dirtyKV.size && !dirtyFiles.size) return; }
    flushing = (async () => {
      const kv = dirtyKV, files = dirtyFiles; dirtyKV = new Map(); dirtyFiles = new Set(); W.lastFlush = Date.now();
      try {
        const d = await connect(), s = getStore ? getStore() : {}, rows = [];
        for (const k of kv.keys()) { const rec = s[k]; if (rec) rows.push({ k, val: JSON.stringify(rec.value === undefined ? null : rec.value), v: rec.v, ts: rec.ts }); }
        for (let i = 0; i < rows.length; i += 200) await d.kvPut(rows.slice(i, i + 200));
        for (const n of files) { const p = physicalPath(n); let st; try { st = fs.statSync(p); } catch (e) { continue; } if (st.size > MAX_FILE) { console.log('Storage: ' + n + ' is over the database size cap and is only on disk'); continue; } await d.filePut(n, fs.readFileSync(p), Math.round(st.mtimeMs)); }
        W.ok = true; W.lastError = null; W.lastOkFlush = Date.now(); W.flushed += rows.length + files.size;
      } catch (e) {
        for (const k of kv.keys()) dirtyKV.set(k, true); for (const n of files) dirtyFiles.add(n);
        W.ok = false; W.lastError = String(e.message || e); console.log('Storage: database write failed, will retry:', W.lastError); setTimeout(() => sched(1), 5000);
      } finally { W.pending = dirtyKV.size + dirtyFiles.size; }
    })();
    try { await flushing; } finally { flushing = null; }
  };
  W.ping = async () => { if (!W.enabled) return true; try { const d = await connect(); await d.ping(); return true; } catch (e) { W.ok = false; W.lastError = String(e.message || e); return false; } };
  W.close = async () => { try { await W.flush(); if (db) await db.close(); } catch (e) {} };
  return W;
}

/* ── backups ── */
const MAGIC = Buffer.from('GEAMSBK1');
const passOf = () => process.env.GEAMS_BACKUP_PASSPHRASE || '';
async function encryptFile(src, dst, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), key = crypto.scryptSync(pass, salt, 32), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = fs.createWriteStream(dst); out.write(Buffer.concat([MAGIC, salt, iv]));
  await pipeline(fs.createReadStream(src), c, out, { end: false }); out.write(c.getAuthTag()); await new Promise((r) => out.end(r));
}
async function decryptFile(src, dst, pass) {
  const st = fs.statSync(src), fd = fs.openSync(src, 'r'), head = Buffer.alloc(36), tag = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 36, 0); fs.readSync(fd, tag, 0, 16, st.size - 16); fs.closeSync(fd);
  if (!head.subarray(0, 8).equals(MAGIC)) throw new Error('Not a GEAMS backup file');
  const key = crypto.scryptSync(pass, head.subarray(8, 24), 32), d = crypto.createDecipheriv('aes-256-gcm', key, head.subarray(24, 36)); d.setAuthTag(tag);
  try { await pipeline(fs.createReadStream(src, { start: 36, end: st.size - 17 }), d, fs.createWriteStream(dst)); } catch (e) { try { fs.unlinkSync(dst); } catch (x) {} throw new Error('Wrong passphrase, or the backup file is damaged'); }
}
const tarList = (f) => execFileSync('tar', ['-tzf', f], { maxBuffer: 1 << 28 }).toString().split('\n').filter(Boolean);

async function makeBackup(getStore, opts) {
  opts = opts || {}; const enc = !!passOf(), stamp = new Date().toISOString().replace(/[-:.]/g, '');
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stage = fs.mkdtempSync(path.join(require('os').tmpdir(), 'geams-bk-'));
  try {
    const store = getStore ? getStore() : readLocalStore(), manifest = { format: 'geams-backup-v1', createdAt: new Date().toISOString(), encrypted: enc, keys: Object.keys(store).length, files: {}, includes: [], omitted: [] };
    const put = (name, buf) => { fs.mkdirSync(path.dirname(path.join(stage, name)), { recursive: true }); fs.writeFileSync(path.join(stage, name), buf); manifest.files[name] = { size: buf.length, sha256: sha(buf) }; };
    put('data.json', Buffer.from(JSON.stringify(store))); manifest.includes.push('data.json');
    if (fs.existsSync(USERS_FILE)) { put('hq-users.json', fs.readFileSync(USERS_FILE)); manifest.includes.push('hq-users.json'); }
    for (const [n, p] of [['secret.key', SECRET_FILE], ['vapid.json', VAPID_FILE]]) { if (!fs.existsSync(p)) continue; if (enc) { put(n, fs.readFileSync(p)); manifest.includes.push(n); } else manifest.omitted.push(n + ' (kept out because this backup is not encrypted; set GEAMS_BACKUP_PASSPHRASE to include it)'); }
    let nb = 0; for (const p of walk(BLOB_DIR)) { const rel = 'blobs/' + path.relative(BLOB_DIR, p).split(path.sep).join('/'); put(rel, fs.readFileSync(p)); nb++; } manifest.blobFiles = nb;
    fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 1));
    const tgz = path.join(BACKUP_DIR, 'geams-backup-' + stamp + '.tar.gz.tmp');
    execFileSync('tar', ['-czf', tgz, '-C', stage, '.'], { maxBuffer: 1 << 26 });
    const final = path.join(BACKUP_DIR, 'geams-backup-' + stamp + (enc ? '.tar.gz.enc' : '.tar.gz'));
    if (enc) { await encryptFile(tgz, final, passOf()); fs.unlinkSync(tgz); } else fs.renameSync(tgz, final);
    const keep = Math.max(1, parseInt(process.env.GEAMS_BACKUP_KEEP, 10) || 7);
    const all = listBackups(); for (const b of all.slice(keep)) { try { fs.unlinkSync(path.join(BACKUP_DIR, b.name)); } catch (e) {} }
    const info = { name: path.basename(final), size: fs.statSync(final).size, createdAt: manifest.createdAt, encrypted: enc, keys: manifest.keys, blobFiles: nb, omitted: manifest.omitted };
    if (process.env.GEAMS_BACKUP_PUT_URL && !opts.noPush) { try { info.offsite = await pushOffsite(final); } catch (e) { info.offsite = 'failed: ' + e.message; } }
    return info;
  } finally { try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) {} }
}
async function pushOffsite(file) {
  const base = process.env.GEAMS_BACKUP_PUT_URL.replace(/\/+$/, ''), h = { 'Content-Type': 'application/octet-stream', 'Content-Length': String(fs.statSync(file).size) };
  if (process.env.GEAMS_BACKUP_PUT_AUTH) h.Authorization = process.env.GEAMS_BACKUP_PUT_AUTH;
  const r = await fetch(base + '/' + path.basename(file), { method: 'PUT', headers: h, body: fs.readFileSync(file), signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error('the offsite store answered ' + r.status); return 'sent';
}
function listBackups() {
  let names = []; try { names = fs.readdirSync(BACKUP_DIR); } catch (e) { return []; }
  return names.filter(n => /^geams-backup-[0-9TZ]+\.tar\.gz(\.enc)?$/.test(n)).map(n => { const st = fs.statSync(path.join(BACKUP_DIR, n)); return { name: n, size: st.size, createdAt: new Date(st.mtimeMs).toISOString(), encrypted: n.endsWith('.enc') }; }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
/* open a backup (decrypting if needed) into a scratch folder and check every file against its fingerprint */
async function unpack(file) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'geams-rs-')); let tgz = file;
  try {
    if (file.endsWith('.enc')) { if (!passOf()) throw new Error('This backup is encrypted. Set GEAMS_BACKUP_PASSPHRASE to open it.'); tgz = path.join(dir, '_dec.tar.gz'); await decryptFile(file, tgz, passOf()); }
    for (const n of tarList(tgz)) if (/(^|\/)\.\.(\/|$)|^\//.test(n)) throw new Error('Backup contains an unsafe path: ' + n);
    execFileSync('tar', ['-xzf', tgz, '-C', dir, '--no-same-owner', '--exclude=_dec.tar.gz'], { maxBuffer: 1 << 26 });
    const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); if (mf.format !== 'geams-backup-v1') throw new Error('Unknown backup format');
    const bad = [];
    for (const [n, m] of Object.entries(mf.files)) { const p = path.join(dir, n); if (!fs.existsSync(p)) bad.push(n + ' is missing'); else if (sha(fs.readFileSync(p)) !== m.sha256) bad.push(n + ' does not match its fingerprint'); }
    return { dir, manifest: mf, bad };
  } catch (e) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (x) {} throw e; }
}
async function verifyBackup(file) {
  const u = await unpack(file);
  try { JSON.parse(fs.readFileSync(path.join(u.dir, 'data.json'), 'utf8')); } catch (e) { u.bad.push('data.json is not valid'); }
  fs.rmSync(u.dir, { recursive: true, force: true });
  return { ok: !u.bad.length, problems: u.bad, createdAt: u.manifest.createdAt, keys: u.manifest.keys, blobFiles: u.manifest.blobFiles, encrypted: u.manifest.encrypted, omitted: u.manifest.omitted };
}
/* put a backup back: must be run with the server stopped */
async function restoreBackup(file, force) {
  const u = await unpack(file);
  try {
    if (u.bad.length) throw new Error('Backup is damaged: ' + u.bad.join('; '));
    const have = fs.existsSync(DATA_FILE) || walk(BLOB_DIR).length;
    if (have && !force) throw new Error('This folder already has GEAMS data. Stop the server and add --force to replace it (the current data is kept in a "pre-restore" folder).');
    if (have) { const keepDir = path.join(BASE, 'pre-restore-' + Date.now()); fs.mkdirSync(keepDir, { recursive: true }); for (const p of [DATA_FILE, USERS_FILE, SECRET_FILE, VAPID_FILE, BLOB_DIR]) if (fs.existsSync(p)) fs.renameSync(p, path.join(keepDir, path.basename(p))); }
    fs.mkdirSync(BASE, { recursive: true });
    fs.copyFileSync(path.join(u.dir, 'data.json'), DATA_FILE);
    for (const [n, p] of Object.entries(mirrored())) { const s = path.join(u.dir, n); if (fs.existsSync(s)) { fs.copyFileSync(s, p); if (n !== 'hq-users.json') fs.chmodSync(p, 0o600); } }
    if (fs.existsSync(path.join(u.dir, 'blobs'))) execFileSync('cp', ['-a', path.join(u.dir, 'blobs') + '/.', BLOB_DIR + '/'], { stdio: 'ignore' }); else fs.mkdirSync(BLOB_DIR, { recursive: true });
    let toDb = null;
    if (DB_URL) {
      const db = await openDb(DB_URL);
      try {
        await db.kvClear(); await db.fileClear(); const s = readLocalStore(), rows = Object.entries(s).map(([k, r]) => ({ k, val: JSON.stringify(r.value), v: r.v, ts: r.ts }));
        for (let i = 0; i < rows.length; i += 200) await db.kvPut(rows.slice(i, i + 200)); let nf = 0;
        for (const [n, p] of Object.entries(mirrored())) if (fs.existsSync(p)) { await db.filePut(n, fs.readFileSync(p), Math.round(fs.statSync(p).mtimeMs)); nf++; }
        for (const p of walk(BLOB_DIR)) { const n = logicalName(p), st = fs.statSync(p); if (n && st.size <= MAX_FILE) { await db.filePut(n, fs.readFileSync(p), Math.round(st.mtimeMs)); nf++; } }
        toDb = { keys: rows.length, files: nf };
      } finally { await db.close(); }
    }
    return { restored: true, keys: u.manifest.keys, blobFiles: u.manifest.blobFiles, database: toDb, omitted: u.manifest.omitted };
  } finally { try { fs.rmSync(u.dir, { recursive: true, force: true }); } catch (e) {} }
}

module.exports = { DB_URL, BASE, BACKUP_DIR, preboot, createWriter, makeBackup, listBackups, verifyBackup, restoreBackup, openDb, logicalName, pushOffsite };

if (require.main === module) {
  const [cmd, arg, flag] = process.argv.slice(2);
  (async () => {
    if (cmd === 'preboot') { await preboot(); }
    else if (cmd === 'backup') { console.log(JSON.stringify(await makeBackup(null), null, 1)); }
    else if (cmd === 'verify' && arg) { const r = await verifyBackup(arg); console.log(JSON.stringify(r, null, 1)); process.exit(r.ok ? 0 : 3); }
    else if (cmd === 'restore' && arg) { console.log(JSON.stringify(await restoreBackup(arg, flag === '--force'), null, 1)); }
    else if (cmd === 'status') { console.log(JSON.stringify({ database: DB_URL ? DB_URL.replace(/\/\/[^@]*@/, '//***@') : null, backups: listBackups() }, null, 1)); }
    else { console.log('Usage: node geams-persist.js preboot | backup | verify <file> | restore <file> [--force] | status'); process.exit(2); }
  })().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
}
