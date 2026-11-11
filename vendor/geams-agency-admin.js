/* National HQ owner: create, reset, disable and re-enable Fire HQ and Ambulance HQ accounts.
 * Every action is a real call to /api/hq/agency. Passwords are shown once and are never stored readable. */
(function () {
  'use strict';
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tok = () => { try { return sessionStorage.getItem('geams_hq_token') || sessionStorage.getItem('geams_token') || (typeof GeamsSync !== 'undefined' && GeamsSync.token) || ''; } catch (e) { return ''; } };
  async function api(method, body) {
    let r; try { r = await fetch('/api/hq/agency', { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok() }, body: body ? JSON.stringify(body) : undefined }); } catch (e) { return { s: 0, j: { error: 'No connection to the GEAMS server' } }; }
    let j = {}; try { j = await r.json(); } catch (e) { } return { s: r.status, j };
  }
  let el;
  function shell(inner) {
    if (!el) { el = document.createElement('div'); el.id = 'geams-agadmin'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Fire and Ambulance HQ accounts'); document.body.appendChild(el); }
    el.style.cssText = 'position:fixed;inset:0;z-index:99990;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;padding:12px;font:14px/1.45 system-ui,sans-serif;color:#e5e7eb';
    el.innerHTML = '<div style="background:#111827;border:1px solid #374151;border-radius:12px;padding:16px;width:min(640px,100%);max-height:92vh;overflow:auto">' + inner + '</div>';
  }
  const close = () => { if (el) { el.remove(); el = null; } };
  const btn = (id, t, st) => '<button type="button" id="' + id + '" style="min-height:38px;padding:6px 12px;border-radius:8px;border:1px solid #4b5563;background:#1f2937;color:#fff;cursor:pointer;' + (st || '') + '">' + t + '</button>';
  const inp = 'width:100%;background:#0b1220;color:#fff;border:1px solid #4b5563;border-radius:8px;padding:8px;min-height:38px;box-sizing:border-box';
  async function list(msg) {
    const r = await api('GET'); if (r.s !== 200) { shell('<h3 style="margin:0 0 8px">Fire and Ambulance HQ accounts</h3><p style="color:#fca5a5">' + esc(r.j.error || 'Could not load') + '</p>' + btn('ag-x', 'Close')); el.querySelector('#ag-x').onclick = close; return; }
    const rows = r.j.accounts.map((a, i) => '<tr style="border-bottom:1px solid #1f2937"><td style="padding:6px">' + (a.kind === 'fire' ? '🚒 Fire' : '🚑 Ambulance') + '</td><td>' + esc(a.name) + '<br><span style="color:#9ca3af;font-size:.8em">' + esc(a.username) + (a.lastLogin ? ' · last sign-in ' + esc(new Date(a.lastLogin).toLocaleString()) : ' · never signed in') + (a.mustChange ? ' · temporary password not yet changed' : '') + '</span></td><td>' + (a.disabled ? '<b style="color:#fca5a5">Disabled</b>' : 'Active') + '</td><td style="white-space:nowrap">' + btn('ag-r' + i, 'Reset password') + ' ' + btn('ag-d' + i, a.disabled ? 'Enable' : 'Disable', a.disabled ? '' : 'border-color:#ef4444;color:#fecaca') + '</td></tr>').join('');
    shell('<h3 style="margin:0 0 6px">Fire and Ambulance HQ accounts</h3><p style="color:#9ca3af;font-size:.85em;margin:0 0 8px">Fire and Ambulance report to their own HQ, not to Police. Control rooms still receive every alert and forward it to the nearest station. Each HQ sees only its own service.</p>'
      + (msg ? '<p style="color:#86efac">' + esc(msg) + '</p>' : '')
      + '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.9em">' + (rows || '<tr><td style="color:#9ca3af;padding:8px">No HQ accounts yet.</td></tr>') + '</table></div>'
      + '<h4 style="margin:14px 0 4px">Create an HQ account</h4><div style="display:grid;gap:6px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))"><select id="ag-k" style="' + inp + '"><option value="fire">Fire HQ</option><option value="ambulance">Ambulance HQ</option></select><input id="ag-u" placeholder="Username (e.g. firehq.kofi)" autocapitalize="off" style="' + inp + '"><input id="ag-n" placeholder="Full name" style="' + inp + '"></div>'
      + '<div id="ag-e" role="alert" style="color:#fca5a5;min-height:1.3em;font-size:.85em;margin:4px 0"></div><div style="display:flex;gap:8px;flex-wrap:wrap">' + btn('ag-c', 'Create', 'background:#16a34a;border-color:#16a34a') + btn('ag-x', 'Close') + '</div>');
    el.querySelector('#ag-x').onclick = close;
    el.querySelector('#ag-c').onclick = async () => { const x = await api('POST', { action: 'create', kind: el.querySelector('#ag-k').value, username: el.querySelector('#ag-u').value, name: el.querySelector('#ag-n').value }); if (x.s !== 200) { el.querySelector('#ag-e').textContent = x.j.error || 'Failed'; return; } secret(x.j, 'Account created'); };
    r.j.accounts.forEach((a, i) => {
      el.querySelector('#ag-r' + i).onclick = async () => { if (!confirm('Make a new temporary password for ' + a.name + '? The current one stops working.')) return; const x = await api('POST', { action: 'reset', kind: a.kind, username: a.username }); if (x.s !== 200) { alert(x.j.error || 'Failed'); return; } secret(x.j, 'New temporary password'); };
      el.querySelector('#ag-d' + i).onclick = async () => { const x = await api('POST', { action: a.disabled ? 'enable' : 'disable', kind: a.kind, username: a.username }); if (x.s !== 200) { alert(x.j.error || 'Failed'); return; } list(a.disabled ? 'Enabled.' : 'Disabled. Their sign-ins ended.'); };
    });
  }
  function secret(j, title) {
    shell('<h3 style="margin:0 0 6px">' + esc(title) + '</h3><p>' + (j.kind === 'fire' ? 'Fire HQ' : 'Ambulance HQ') + ' · ' + esc(j.name) + '<br>Username: <b>' + esc(j.username) + '</b></p><p style="font-size:1.4rem;font-family:monospace;letter-spacing:.04em"><b>' + esc(j.password) + '</b></p><p style="color:#fcd34d;font-size:.85em">Shown once. Hand it over in person. They open <b>' + (j.kind === 'fire' ? 'geams-fire-hq.html' : 'geams-ambulance-hq.html') + '</b>, sign in, and must choose their own password.</p>' + btn('ag-o', 'Done', 'background:#16a34a;border-color:#16a34a'));
    el.querySelector('#ag-o').onclick = () => list();
  }
  window.GeamsAgencyAdmin = { open() { list(); } };
})();
