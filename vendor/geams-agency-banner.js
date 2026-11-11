/* Shows the message the crew's own HQ (Fire HQ or Ambulance HQ) sent, inside the fire / ambulance crew app.
 * It reads the real record agency:<kind>:broadcast over the normal sync link; nothing is invented.
 * It appears only while the app is open and connected, and the person can dismiss it. */
(function () {
  'use strict';
  const kind = /ambulance-service/.test(window.GEAMS_FILE || location.pathname) ? 'ambulance' : 'fire';
  let started = false, last = null;
  const seenKey = 'geams_hqmsg_seen_' + kind;
  const getSeen = () => { try { return localStorage.getItem(seenKey) || ''; } catch (e) { return ''; } };
  const setSeen = (v) => { try { localStorage.setItem(seenKey, v); } catch (e) { } };
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function myStation() { try { const t = (typeof GeamsSync !== 'undefined' && GeamsSync.token) || sessionStorage.getItem('geams_token') || ''; const b = t.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'); return (JSON.parse(atob(b + '==='.slice((b.length + 3) % 4))) || {}).l || null; } catch (e) { return null; } }
  function show(map) {
    const items = map && Array.isArray(map.items) ? map.items : []; const mine = myStation();
    const it = items.slice().reverse().find(x => Date.now() - x.at < 12 * 3600000 && (!x.sid || x.sid === mine));
    let el = document.getElementById('geams-hqmsg');
    if (!it || getSeen() === it.id) { if (el) el.remove(); return; }
    if (last === it.id && el) return; last = it.id;
    if (!el) { el = document.createElement('div'); el.id = 'geams-hqmsg'; el.setAttribute('role', 'alert'); document.body.appendChild(el); }
    el.style.cssText = 'position:fixed;left:8px;right:8px;top:8px;z-index:99998;padding:10px 12px;border-radius:10px;color:#fff;font:14px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45);background:' + (it.priority === 'urgent' ? '#b91c1c' : '#1d4ed8');
    el.innerHTML = '<b>' + (kind === 'fire' ? 'Fire' : 'Ambulance') + ' HQ' + (it.priority === 'urgent' ? ' · URGENT' : '') + '</b> <span style="opacity:.8;font-size:.8em">' + esc(new Date(it.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) + '</span><div>' + esc(it.message) + '</div><button type="button" style="margin-top:6px;min-height:36px;padding:4px 14px;border-radius:8px;border:1px solid #fff;background:transparent;color:#fff">Got it</button>';
    el.querySelector('button').onclick = () => { setSeen(it.id); el.remove(); };
  }
  function tryStart() {
    if (started || typeof GeamsSync === 'undefined' || !GeamsSync.token || GeamsSync.mode !== 'server') return;
    started = true; GeamsSync.watch('agency:' + kind + ':broadcast', null, show, 5000);
  }

  /* Two-way administrative messages with the crew's own HQ. Real calls to /api/unit/hq-chat; checked about every 6 seconds while the app is open. */
  const HQ = kind === 'fire' ? 'Fire HQ' : 'Ambulance HQ';
  let btn, panel, chatOpen = false, lastCount = -1, unread = 0, busy = false;
  const tok = () => (typeof GeamsSync !== 'undefined' && GeamsSync.token) || '';
  async function chatApi(method, q, body) {
    try { const r = await fetch('/api/unit/hq-chat' + (q || ''), { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok() }, body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json(); } catch (e) { } return { s: r.status, j }; } catch (e) { return { s: 0, j: { error: 'No connection' } }; }
  }
  function ensureUi() {
    if (btn) return;
    btn = document.createElement('button'); btn.type = 'button'; btn.id = 'geams-hqchat-btn'; btn.setAttribute('aria-label', 'Message ' + HQ);
    btn.style.cssText = 'position:fixed;left:10px;bottom:76px;z-index:99990;width:46px;height:46px;border-radius:50%;border:2px solid #fff;background:#1d4ed8;color:#fff;font-size:20px;box-shadow:0 4px 16px rgba(0,0,0,.4);cursor:pointer;padding:0';
    btn.innerHTML = '💬<span id="geams-hqchat-n" style="display:none;position:absolute;top:-6px;right:-6px;min-width:20px;height:20px;border-radius:10px;background:#dc2626;color:#fff;font:700 12px/20px system-ui;text-align:center;padding:0 4px"></span>';
    btn.onclick = () => togglePanel(true); document.body.appendChild(btn);
    panel = document.createElement('div'); panel.id = 'geams-hqchat'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Messages with ' + HQ);
    panel.style.cssText = 'display:none;position:fixed;left:0;right:0;bottom:0;z-index:2147483600;max-height:75vh;background:#0f172a;color:#e5e7eb;border-top:2px solid #1d4ed8;border-radius:14px 14px 0 0;font:14px/1.4 system-ui,sans-serif;box-shadow:0 -8px 30px rgba(0,0,0,.5);flex-direction:column';
    panel.innerHTML = '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #1f2937"><b style="flex:1">Message ' + HQ + '</b><button type="button" id="geams-hqchat-x" aria-label="Close" style="min-height:36px;min-width:36px;border-radius:8px;border:1px solid #475569;background:transparent;color:#fff">✕</button></div>'
      + '<div id="geams-hqchat-note" style="padding:6px 12px;font-size:.78em;color:#94a3b8">Administrative matters only (shifts, kit, leave, your account). In an emergency use the alert screens or call 112. Messages are delivered while both sides have the app open.</div>'
      + '<div id="geams-hqchat-list" style="flex:1;overflow:auto;padding:4px 12px;min-height:90px"></div><div id="geams-hqchat-err" role="alert" style="color:#fca5a5;font-size:.8em;padding:0 12px"></div>'
      + '<div style="display:flex;gap:8px;padding:10px 12px"><input id="geams-hqchat-in" maxlength="500" placeholder="Write to ' + HQ + '" aria-label="Message" style="flex:1;min-height:42px;border-radius:8px;border:1px solid #475569;background:#0b1220;color:#fff;padding:0 10px;font-size:16px"><button type="button" id="geams-hqchat-send" style="min-height:42px;padding:0 16px;border-radius:8px;border:0;background:#1d4ed8;color:#fff;font-weight:600">Send</button></div>';
    document.body.appendChild(panel);
    panel.querySelector('#geams-hqchat-x').onclick = () => togglePanel(false);
    panel.querySelector('#geams-hqchat-send').onclick = send;
    panel.querySelector('#geams-hqchat-in').onkeydown = (e) => { if (e.key === 'Enter') send(); };
  }
  function draw(items) {
    const L = document.getElementById('geams-hqchat-list'); if (!L) return; const atEnd = L.scrollTop + L.clientHeight >= L.scrollHeight - 30;
    L.innerHTML = items.length ? items.map(m => '<div style="margin:6px 0;text-align:' + (m.from === 'crew' ? 'right' : 'left') + '"><span style="display:inline-block;max-width:85%;text-align:left;padding:6px 10px;border-radius:10px;background:' + (m.from === 'crew' ? '#1d4ed8' : '#1f2937') + '">' + esc(m.text) + '</span><br><span style="font-size:.72em;color:#94a3b8">' + esc(m.from === 'crew' ? 'You' : m.by) + ' · ' + esc(new Date(m.at).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })) + '</span></div>').join('') : '<p style="color:#94a3b8">No messages yet.</p>';
    if (atEnd || items.length !== lastCount) L.scrollTop = L.scrollHeight; lastCount = items.length;
  }
  function badge(n) { unread = n; const e = document.getElementById('geams-hqchat-n'); if (e) { e.style.display = n ? 'block' : 'none'; e.textContent = n > 9 ? '9+' : n; } }
  async function poll() {
    if (busy || !tok() || typeof GeamsSync === 'undefined' || GeamsSync.mode !== 'server') return; busy = true;
    try { const r = await chatApi('GET', chatOpen ? '?read=1' : ''); if (r.s === 200) { ensureUi(); badge(chatOpen ? 0 : r.j.unread); if (chatOpen) draw(r.j.items); } } finally { busy = false; }
  }
  function togglePanel(open) { ensureUi(); chatOpen = open; panel.style.display = open ? 'flex' : 'none'; btn.style.display = open ? 'none' : 'block'; if (open) { lastCount = -1; poll(); setTimeout(() => { const i = document.getElementById('geams-hqchat-in'); if (i) i.focus(); }, 100); } }
  async function send() {
    const i = document.getElementById('geams-hqchat-in'), e = document.getElementById('geams-hqchat-err'), v = i.value.trim(); if (!v) return; e.textContent = '';
    const r = await chatApi('POST', '', { message: v }); if (r.s !== 200) { e.textContent = r.j.error || 'Not sent. Check your connection and try again.'; return; } i.value = ''; draw(r.j.items);
  }
  setInterval(poll, 6000); window.addEventListener('load', () => setTimeout(poll, 1500));
  setInterval(tryStart, 3000); window.addEventListener('load', tryStart);
})();
