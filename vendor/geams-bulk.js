/* GEAMS bulk setup: paste or load a spreadsheet (CSV), preview, create, then print the login sheet.
   GeamsBulk.open('crew')      control room / HQ screens: adds crew with one-time temporary passwords
   GeamsBulk.open('stations')  HQ owner: adds control rooms with one-time passphrases
   Passwords are made by the server, shown once, and never stored in readable form. */
(function () {
  'use strict';
  const tok = () => { try { return (typeof GeamsSync !== 'undefined' && GeamsSync.token) || sessionStorage.getItem('geams_token') || ''; } catch (e) { return ''; } };
  const base = () => { try { return (typeof GeamsSync !== 'undefined' && GeamsSync.base) || ''; } catch (e) { return ''; } };
  const hx = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MODES = {
    crew: {
      title: 'Add crew in bulk', endpoint: '/api/lcr/crew/bulk', cols: ['name', 'phone', 'rank', 'vehicle', 'vehicleType'],
      alias: { fullname: 'name', 'full name': 'name', mobile: 'phone', telephone: 'phone', tel: 'phone', phonenumber: 'phone', 'phone number': 'phone', unit: 'vehicle', 'vehicle type': 'vehicleType', vehicletype: 'vehicleType' },
      sample: 'name,phone,rank,vehicle\nKwame Mensah,0244000001,Constable,Patrol 3\nAma Owusu,0244000002,Corporal,Patrol 4',
      help: 'Columns: <b>name</b> and <b>phone</b> are required; rank, vehicle and vehicleType are optional. People are approved at once for your control room. Each gets a temporary password and must choose their own at first sign-in.',
      needs: ['name', 'phone'], secret: 'tempPassword', secretLabel: 'Temporary password', kinds: true
    },
    stations: {
      title: 'Add control rooms in bulk', endpoint: '/api/hq/stations/bulk', cols: ['name', 'region', 'town', 'lat', 'lng', 'phone', 'radiusM'],
      alias: { latitude: 'lat', longitude: 'lng', lon: 'lng', long: 'lng', radius: 'radiusM', 'radius m': 'radiusM', 'station name': 'name', mobile: 'phone' },
      sample: 'name,region,town,lat,lng,phone,radiusM\nHohoe Control Room,Volta,Hohoe,7.152,0.472,0362000001,5000\nHo Control Room,Volta,Ho,6.601,0.470,0362000002,5000',
      help: 'Columns: <b>name, region, town, lat, lng</b> are required (decimal degrees inside Ghana); phone and radiusM (metres, default 5000) are optional. Each control room gets a station ID and a one-time passphrase.',
      needs: ['name', 'region', 'town', 'lat', 'lng'], secret: 'passphrase', secretLabel: 'Passphrase', kinds: false
    }
  };
  let mode = null, rows = [], result = null, kind = 'officer';
  function parseCSV(text) {
    text = String(text || '').replace(/^﻿/, ''); const first = text.split(/\r?\n/)[0] || ''; const d = first.includes('\t') ? '\t' : (first.split(';').length > first.split(',').length ? ';' : ',');
    const out = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true; else if (c === d) { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(x => x.trim())) out.push(row); row = []; }
      else cur += c;
    }
    row.push(cur); if (row.some(x => x.trim())) out.push(row); return out;
  }
  function toRows(text, M) {
    const t = parseCSV(text); if (t.length < 2) return { error: 'Put the column names on the first line, then one person per line.' };
    const head = t[0].map(h => { const k = h.trim().toLowerCase(); const a = M.alias[k]; if (a) return a; const m = M.cols.find(c => c.toLowerCase() === k); return m || k; });
    const miss = M.needs.filter(n => !head.includes(n)); if (miss.length) return { error: 'Missing column(s): ' + miss.join(', ') + '. Found: ' + head.join(', ') };
    return { rows: t.slice(1).map(r => { const o = {}; head.forEach((h, i) => { if (M.cols.includes(h)) o[h] = (r[i] || '').trim(); }); return o; }) };
  }
  async function call(body) {
    const r = await fetch(base() + MODES[mode].endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok() }, body: JSON.stringify(body) });
    let j = {}; try { j = await r.json(); } catch (e) {} return { ok: r.ok, status: r.status, j };
  }
  function shell() {
    let el = document.getElementById('geams-bulk'); if (el) el.remove();
    el = document.createElement('div'); el.id = 'geams-bulk'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', MODES[mode].title);
    el.style.cssText = 'position:fixed;inset:0;z-index:2147483500;background:rgba(0,0,0,.72);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:16px;font-family:system-ui,sans-serif';
    el.innerHTML = '<style>@media print{body>*:not(#geams-bulk){display:none!important}#geams-bulk{position:static!important;background:#fff!important;padding:0!important;display:block!important}#geams-bulk .nop{display:none!important}#geams-bulk .card{break-inside:avoid;border:1px solid #000!important;color:#000!important;background:#fff!important}}#geams-bulk input,#geams-bulk textarea,#geams-bulk select{font:inherit}#geams-bulk button{cursor:pointer}</style><div id="gb-box" style="background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:12px;max-width:760px;width:100%;padding:16px"></div>';
    document.body.appendChild(el); return el.querySelector('#gb-box');
  }
  const btn = (id, label, st) => '<button id="' + id + '" style="border:0;border-radius:8px;padding:9px 14px;font-weight:700;' + (st || 'background:#374151;color:#fff') + '">' + label + '</button>';
  function step1(msg) {
    const M = MODES[mode], b = shell();
    b.innerHTML = '<div class="nop"><div style="font-size:1.1rem;font-weight:800">' + hx(M.title) + '</div>'
      + '<div style="font-size:.8rem;line-height:1.5;margin:6px 0 10px;color:#9ca3af">' + M.help + ' Paste from a spreadsheet, or load a .csv file. Nothing is created until you press Create.</div>'
      + (M.kinds ? '<label style="font-size:.8rem">These people are: <select id="gb-kind" style="background:#1f2937;color:#fff;border:1px solid #4b5563;border-radius:6px;padding:5px"><option value="officer">Police officers</option><option value="fire">Fire crew</option><option value="ambulance">Ambulance crew</option></select></label>' : '')
      + '<textarea id="gb-text" rows="9" spellcheck="false" style="width:100%;margin-top:8px;background:#0b1220;color:#e5e7eb;border:1px solid #4b5563;border-radius:8px;padding:8px;font-family:ui-monospace,monospace;font-size:.78rem" placeholder="' + hx(M.sample) + '"></textarea>'
      + '<div id="gb-msg" role="alert" style="font-size:.8rem;margin:6px 0;color:#fca5a5;min-height:1.2em">' + hx(msg || '') + '</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap"><input id="gb-file" type="file" accept=".csv,.txt,text/csv" style="font-size:.78rem;color:#9ca3af">' + btn('gb-prev', 'Preview', 'background:#2563eb;color:#fff') + btn('gb-x', 'Close') + btn('gb-ex', 'Download an example', 'background:transparent;color:#93c5fd;border:1px solid #374151') + '</div></div>';
    if (M.kinds) b.querySelector('#gb-kind').value = kind;
    b.querySelector('#gb-x').onclick = close; b.querySelector('#gb-ex').onclick = () => download('geams-example-' + mode + '.csv', M.sample + '\n');
    b.querySelector('#gb-file').onchange = (e) => { const f = e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { b.querySelector('#gb-text').value = String(rd.result || ''); }; rd.readAsText(f); };
    b.querySelector('#gb-prev').onclick = preview;
  }
  async function preview() {
    const M = MODES[mode], b = document.getElementById('gb-box'); if (M.kinds) kind = b.querySelector('#gb-kind').value;
    const p = toRows(b.querySelector('#gb-text').value, M); if (p.error) { const t0 = b.querySelector('#gb-text').value; step1(p.error); document.getElementById('gb-text').value = t0; return; }
    rows = p.rows; const r = await call({ kind, rows, dry: true });
    if (!r.ok) { const t = b.querySelector('#gb-text').value; step1(r.j.error || 'Could not check the list (error ' + r.status + ').'); document.getElementById('gb-text').value = t; return; }
    result = r.j; step2();
  }
  function step2() {
    const M = MODES[mode], b = shell(), c = result.created, s = result.skipped;
    const cols = M.cols.filter(k => c.some(x => x[k] !== undefined && x[k] !== ''));
    b.innerHTML = '<div class="nop"><div style="font-size:1.1rem;font-weight:800">Check before creating</div>'
      + '<div style="font-size:.85rem;margin:6px 0"><b style="color:#86efac">' + c.length + ' will be created</b>' + (s.length ? ' · <b style="color:#fca5a5">' + s.length + ' will be skipped</b>' : '') + '</div>'
      + (c.length ? '<div style="overflow:auto;max-height:200px;border:1px solid #374151;border-radius:8px"><table style="width:100%;font-size:.74rem;border-collapse:collapse"><tr style="text-align:left;color:#9ca3af">' + cols.map(k => '<th style="padding:4px 6px">' + hx(k) + '</th>').join('') + '</tr>' + c.map(x => '<tr style="border-top:1px solid #374151">' + cols.map(k => '<td style="padding:4px 6px">' + hx(x[k]) + '</td>').join('') + '</tr>').join('') + '</table></div>' : '')
      + (s.length ? '<div style="margin-top:8px;font-size:.78rem;color:#fca5a5"><b>Skipped (fix these and run again, or ignore them):</b><ul style="margin:4px 0 0 18px">' + s.map(x => '<li>Line ' + (x.row + 1) + ' — ' + hx(x.name) + ': ' + hx(x.reason) + '</li>').join('') + '</ul></div>' : '')
      + '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">' + (c.length ? btn('gb-go', 'Create ' + c.length, 'background:#16a34a;color:#fff') : '') + btn('gb-back', 'Back') + btn('gb-x', 'Close') + '</div><div id="gb-msg" role="alert" style="font-size:.8rem;margin-top:6px;color:#fca5a5"></div></div>';
    b.querySelector('#gb-x').onclick = close; b.querySelector('#gb-back').onclick = () => step1();
    const go = b.querySelector('#gb-go'); if (go) go.onclick = async () => {
      go.disabled = true; go.textContent = 'Creating…'; const r = await call({ kind, rows, dry: false });
      if (!r.ok) { go.disabled = false; go.textContent = 'Create ' + c.length; b.querySelector('#gb-msg').textContent = (r.j.error || 'Failed (error ' + r.status + ')') + ' Nothing was created.'; return; }
      result = r.j; step3();
    };
  }
  function sheetHTML() {
    const M = MODES[mode], st = result.station; const stamp = new Date().toLocaleString();
    return result.created.map(x => '<div class="card" style="border:1px solid #6b7280;border-radius:10px;padding:12px;margin:0 0 10px;background:#1f2937">'
      + '<div style="font-weight:800;font-size:1rem">' + hx(x.name) + '</div>'
      + (mode === 'crew' ? '<div style="font-size:.8rem">' + hx(({ officer: 'Police officer', fire: 'Fire crew', ambulance: 'Ambulance crew' })[x.kind]) + (st ? ' · ' + hx(st.name) : '') + '</div><div style="font-size:.85rem;margin-top:6px">Sign in with your <b>name</b> exactly as printed above and this password. Badge: <b>' + hx(x.badge) + '</b></div>'
        : '<div style="font-size:.8rem">' + hx(x.town) + ', ' + hx(x.region) + '</div><div style="font-size:.85rem;margin-top:6px">Station ID: <b style="font-family:monospace">' + hx(x.id) + '</b></div>')
      + '<div style="font-size:.85rem;margin-top:4px">' + hx(M.secretLabel) + ': <b style="font-family:monospace;font-size:1.15rem;letter-spacing:.06em">' + hx(x[M.secret]) + '</b></div>'
      + '<div style="font-size:.7rem;margin-top:6px;color:#9ca3af">' + (mode === 'crew' ? 'Choose your own password when you first sign in. Do not share this sheet. ' : 'Keep this private. Give it only to the commander. ') + 'Printed ' + hx(stamp) + '.</div></div>').join('');
  }
  function step3() {
    const M = MODES[mode], b = shell(), c = result.created;
    b.innerHTML = '<div class="nop"><div style="font-size:1.1rem;font-weight:800;color:#86efac">' + c.length + ' created</div>'
      + '<div style="font-size:.82rem;line-height:1.5;margin:6px 0;color:#fbbf24">' + hx(result.note) + ' Once you close this screen, these ' + hx(M.secretLabel.toLowerCase()) + 's cannot be shown again. They can only be reset.</div>'
      + (result.skipped.length ? '<div style="font-size:.78rem;color:#fca5a5;margin-bottom:6px">' + result.skipped.length + ' line(s) were skipped (see the preview you just saw).</div>' : '')
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0">' + btn('gb-print', '🖨 Print login sheets', 'background:#2563eb;color:#fff') + btn('gb-csv', 'Download as CSV') + btn('gb-x', 'Done — I have saved them') + '</div></div>'
      + '<div id="gb-sheet">' + sheetHTML() + '</div>';
    b.querySelector('#gb-x').onclick = () => { if (confirm('The passwords will be gone from this screen. Have you printed or saved them?')) close(); };
    b.querySelector('#gb-print').onclick = () => window.print();
    b.querySelector('#gb-csv').onclick = () => { const keys = Object.keys(c[0] || {}); const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; download('geams-login-sheet-' + mode + '.csv', keys.join(',') + '\n' + c.map(x => keys.map(k => q(x[k])).join(',')).join('\n') + '\n'); };
  }
  function download(name, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
  function close() { const el = document.getElementById('geams-bulk'); if (el) el.remove(); result = null; rows = []; }
  window.GeamsBulk = { open(m) { if (!MODES[m]) return; mode = m; result = null; step1(); }, parseCSV, toRows: (t, m) => toRows(t, MODES[m]) };
})();
