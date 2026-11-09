/* GEAMS diagnostics: (1) reports app errors to HQ so problems are found, (2) tells people when a newer version of the app is waiting. */
(function () {
  const build = window.GEAMS_BUILD || '', file = window.GEAMS_FILE || location.pathname.split('/').pop();
  let sent = 0; const seen = new Set();
  const tok = () => { try { return sessionStorage.getItem('geams_token') || sessionStorage.getItem('geams_hq_token') || ''; } catch (e) { return ''; } };
  function report(msg, src, line, stack) {
    try {
      msg = String(msg || '').slice(0, 300); const key = msg + '|' + src + '|' + line;
      if (!msg || seen.has(key) || sent >= 5) return; seen.add(key); sent++;
      fetch('/api/clientlog', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', ...(tok() ? { Authorization: 'Bearer ' + tok() } : {}) }, body: JSON.stringify({ app: file, build, msg, src: String(src || '').split('/').pop().slice(0, 80), line: line | 0, stack: String(stack || '').slice(0, 600), online: navigator.onLine, ua: navigator.userAgent.slice(0, 120) }) }).catch(() => {});
    } catch (e) {}
  }
  window.addEventListener('error', (e) => { if (e && e.target && e.target !== window) return; report(e.message, e.filename, e.lineno, e.error && e.error.stack); });
  window.addEventListener('unhandledrejection', (e) => { const r = e.reason; report('Unhandled: ' + (r && r.message ? r.message : r), '', 0, r && r.stack); });
  async function checkVersion() {
    if (!build || !navigator.onLine) return;
    try {
      const r = await fetch('/api/version?f=' + encodeURIComponent(file), { cache: 'no-store' }); if (!r.ok) return; const j = await r.json();
      if (j.build && j.build !== build && !document.getElementById('geams-update')) {
        const b = document.createElement('div'); b.id = 'geams-update'; b.setAttribute('data-no-i18n', '1');
        b.style.cssText = 'position:fixed;left:8px;right:8px;top:8px;z-index:100001;background:#0b3d91;color:#fff;border-radius:10px;padding:10px 12px;font:600 13px system-ui,sans-serif;display:flex;gap:10px;align-items:center;box-shadow:0 2px 12px rgba(0,0,0,.5)';
        b.innerHTML = '<span style="flex:1">A newer version of GEAMS is ready.</span><button id="geams-update-go" style="background:#fff;color:#0b3d91;border:0;border-radius:6px;padding:6px 12px;font-weight:700">Update now</button><button id="geams-update-later" style="background:transparent;color:#cfe0ff;border:0;padding:6px">Later</button>';
        document.body.appendChild(b); document.getElementById('geams-update-go').onclick = () => location.reload(); document.getElementById('geams-update-later').onclick = () => b.remove();
      }
    } catch (e) {}
  }
  window.GeamsDiag = { report, checkVersion, build, file };
  setTimeout(checkVersion, 4000); setInterval(checkVersion, 5 * 60000);
})();
