/* GEAMS: "My availability" for officers, fire and ambulance crews.
 * It shows the crew member's own line of the station roster and lets them say Available, On break or Unavailable.
 * The commander adds people to the roster; a crew member can only change their own availability, and the server enforces that. */
(function () {
  if (window.GeamsRoster) return;
  const tok = () => { try { return (typeof GeamsSync !== 'undefined' && GeamsSync.token) || sessionStorage.getItem('geams_token') || ''; } catch (e) { return ''; } };
  const who = () => { try { const p = JSON.parse(atob(tok().split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); return ['officer', 'fire', 'ambulance'].includes(p.r) && p.b && p.l ? { id: p.r + ':' + p.b, lcr: p.l } : null; } catch (e) { return null; } };
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const AV = [['available', 'Available', '#1f9d6a'], ['break', 'On break', '#d29922'], ['unavailable', 'Unavailable', '#c0392b']];
  const SH = { day: 'Day shift', night: 'Night shift', off: 'Not on shift' };
  async function open() {
    const old = document.getElementById('roster-overlay'); if (old) old.remove();
    const o = document.createElement('div'); o.id = 'roster-overlay'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-modal', 'true'); o.setAttribute('aria-label', 'My availability');
    o.style.cssText = 'position:fixed;inset:0;z-index:2147483500;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;padding:16px';
    document.body.appendChild(o);
    const close = () => o.remove();
    const draw = (html) => { o.innerHTML = '<div style="width:100%;max-width:400px;max-height:92vh;overflow:auto;background:#101a24;border:1px solid #2c3d4f;border-radius:14px;padding:18px;color:#e6eef6;font-family:system-ui,sans-serif"><div style="font-size:17px;font-weight:700;margin-bottom:6px">🕑 My availability</div>' + html + '<button type="button" id="ro-close" style="width:100%;margin-top:10px;padding:10px;border-radius:8px;border:1px solid #3a4a5c;background:transparent;color:#cfd9e3">Close</button></div>'; o.querySelector('#ro-close').onclick = close; };
    const me = who(); if (!me) { draw('<div style="font-size:13px;color:#f0b4ae;line-height:1.5">You are not signed in on this device, so your availability cannot be saved.</div>'); return; }
    draw('<div style="font-size:13px;color:#9db0c3">Loading…</div>');
    const KEY = 'lcr:' + me.lcr + ':roster';
    let map; try { map = await GeamsSync.getShared(KEY, {}); } catch (e) { map = null; }
    if (!map) { draw('<div style="font-size:13px;color:#f0b4ae;line-height:1.5">Could not reach the server. Your availability is not changed. Try again when there is signal.</div>'); return; }
    const mine = map[me.id];
    if (!mine) { draw('<div style="font-size:13px;color:#cfd9e3;line-height:1.5">Your control room has not added you to the station roster yet, so there is nothing to change. Ask your commander to add you (Station dashboard → Crew roster).</div>'); return; }
    const view = (m) => {
      draw('<div style="font-size:12.5px;color:#9db0c3;line-height:1.45;margin-bottom:8px">' + esc(m.name) + ' · ' + esc(SH[m.shift] || m.shift) + '. Your control room sees this. It does not stop alerts reaching you, so use it only to say whether you can take a job.</div>' +
        '<div style="display:flex;gap:6px">' + AV.map(a => '<button type="button" data-a="' + a[0] + '" aria-pressed="' + (m.avail === a[0]) + '" style="flex:1;padding:10px 4px;border-radius:8px;border:2px solid ' + (m.avail === a[0] ? a[2] : '#3a4a5c') + ';background:' + (m.avail === a[0] ? a[2] + '33' : 'transparent') + ';color:#e6eef6;font-size:13px">' + a[1] + '</button>').join('') + '</div>' +
        '<input id="ro-note" maxlength="120" placeholder="Short note (optional), e.g. back at 14:00" value="' + esc(m.note) + '" style="width:100%;box-sizing:border-box;margin-top:8px;padding:10px;border-radius:8px;border:1px solid #3a4a5c;background:#0b1118;color:#fff;font-size:14px"/>' +
        '<div id="ro-msg" role="status" style="font-size:12px;margin-top:8px;min-height:16px;color:#9db0c3"></div>');
      o.querySelectorAll('button[data-a]').forEach(b => b.onclick = async () => {
        const note = o.querySelector('#ro-note').value, msg = o.querySelector('#ro-msg'); msg.textContent = 'Saving…';
        try {
          let fresh = null;
          const saved = await GeamsSync.mergeShared(KEY, {}, (cur) => { cur = cur || {}; if (!cur[me.id]) return cur; cur[me.id] = Object.assign({}, cur[me.id], { avail: b.dataset.a, note }); fresh = cur[me.id]; return cur; });
          if (saved === false) { msg.style.color = '#f0b4ae'; msg.textContent = 'Not saved. There is no signal, or the server refused it. Your availability is unchanged.'; return; }
          if (!fresh) { msg.style.color = '#f0b4ae'; msg.textContent = 'You are no longer on the roster.'; return; }
          view(fresh);
          const m2 = o.querySelector('#ro-msg'); if (m2) { m2.style.color = '#6fd3a8'; m2.textContent = 'Saved. Your control room can see it.'; }
        } catch (e) { msg.style.color = '#f0b4ae'; msg.textContent = 'Not saved: ' + (e && e.message ? e.message : 'no connection') + '. Try again.'; }
      });
    };
    view(mine);
  }
  window.GeamsRoster = { open };
})();
