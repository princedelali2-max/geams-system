/* GEAMS display settings and accessibility.
 * (1) Settings the person chooses: text size, high contrast, reduced motion, language. Saved on this device only.
 * (2) Always on: names for icon-only buttons, keyboard access for clickable boxes, and a spoken announcement of pop-up messages
 *     so a screen reader says what a sighted person sees. Nothing here sends data anywhere. */
(function () {
  if (window.GeamsA11y) return;
  const KEY = 'geams_a11y', root = document.documentElement;
  const DEF = { size: 0, contrast: 0, motion: 0 };            // size: 0 normal, 1 large, 2 largest. motion: 0 follow phone, 1 reduce always
  const SIZES = [1, 1.15, 1.3];
  let st = Object.assign({}, DEF);
  try { st = Object.assign(st, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {} };

  const css = document.createElement('style'); css.id = 'geams-a11y-css';
  css.textContent =
    'html.a11y-size1,html.a11y-size2{zoom:var(--a11y-zoom)}' +
    'html.a11y-hc{filter:contrast(1.28) saturate(1.1)}' +
    'html.a11y-hc :focus-visible,html.a11y-kb :focus-visible{outline:3px solid #ffd400!important;outline-offset:2px!important}' +
    'html.a11y-hc button,html.a11y-hc input,html.a11y-hc select,html.a11y-hc textarea{border-color:currentColor!important}' +
    'html.a11y-rm *,html.a11y-rm *::before,html.a11y-rm *::after{animation-duration:.001s!important;animation-iteration-count:1!important;transition-duration:.001s!important;scroll-behavior:auto!important}' +
    ':focus-visible{outline:2px solid #4da3ff;outline-offset:2px}' +
    '#geams-a11y-fab{position:fixed;left:8px;bottom:8px;z-index:2147483100;width:38px;height:38px;border-radius:50%;border:1px solid #3a4a5c;background:rgba(16,26,36,.92);color:#e6eef6;font:700 14px system-ui,sans-serif;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 6px rgba(0,0,0,.5);padding:0;cursor:pointer}' +
    '@media (min-width:900px){#geams-a11y-fab{left:auto;right:12px;bottom:12px}}' +
    '#geams-sr-live{position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden}';
  document.head.appendChild(css);

  function apply() {
    root.classList.remove('a11y-size1', 'a11y-size2'); if (st.size > 0) { root.classList.add('a11y-size' + st.size); root.style.setProperty('--a11y-zoom', SIZES[st.size]); }
    root.classList.toggle('a11y-hc', !!st.contrast);
    const rm = st.motion === 1 || (st.motion === 0 && window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    root.classList.toggle('a11y-rm', !!rm);
  }
  apply();
  window.addEventListener('keydown', (e) => { if (e.key === 'Tab') root.classList.add('a11y-kb'); });

  function panel() {
    const old = document.getElementById('a11y-overlay'); if (old) old.remove();
    const o = document.createElement('div'); o.id = 'a11y-overlay'; o.setAttribute('data-no-i18n', '1'); o.setAttribute('role', 'dialog'); o.setAttribute('aria-modal', 'true'); o.setAttribute('aria-label', 'Display and language settings');
    o.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;padding:16px';
    const btn = (id, on, label) => '<button type="button" data-k="' + id + '" aria-pressed="' + (on ? 'true' : 'false') + '" style="flex:1;padding:10px 6px;margin:3px;border-radius:8px;border:1px solid ' + (on ? '#1f9d6a' : '#3a4a5c') + ';background:' + (on ? '#12392b' : 'transparent') + ';color:#e6eef6;font-size:14px">' + label + '</button>';
    const lang = window.GeamsI18n ? window.GeamsI18n.LANGS.find(l => l.code === window.GeamsI18n.current()) : null;
    o.innerHTML = '<div style="width:100%;max-width:380px;max-height:92vh;overflow:auto;background:#101a24;border:1px solid #2c3d4f;border-radius:14px;padding:18px;color:#e6eef6;font-family:system-ui,sans-serif">' +
      '<div style="font-size:17px;font-weight:700;margin-bottom:4px">Display and language</div>' +
      '<div style="font-size:12.5px;color:#9db0c3;line-height:1.45;margin-bottom:10px">Saved on this device only. They change how the app looks, never what it does.</div>' +
      '<div style="font-size:13px;font-weight:600;margin:8px 0 2px">Text size</div><div style="display:flex">' + btn('size0', st.size === 0, 'Normal') + btn('size1', st.size === 1, 'Large') + btn('size2', st.size === 2, 'Largest') + '</div>' +
      '<div style="font-size:13px;font-weight:600;margin:8px 0 2px">Contrast</div><div style="display:flex">' + btn('hc0', !st.contrast, 'Standard') + btn('hc1', !!st.contrast, 'Higher contrast') + '</div>' +
      '<div style="font-size:13px;font-weight:600;margin:8px 0 2px">Movement</div><div style="display:flex">' + btn('rm0', st.motion === 0, 'Follow my phone') + btn('rm1', st.motion === 1, 'Reduce movement') + '</div>' +
      (window.GeamsI18n ? '<div style="font-size:13px;font-weight:600;margin:8px 0 2px">Language</div><button type="button" id="a11y-lang" style="width:100%;padding:10px;margin:3px 0;border-radius:8px;border:1px solid #3a4a5c;background:transparent;color:#e6eef6;font-size:14px;text-align:left">🌐 ' + (lang ? lang.name : 'English') + ' — change</button>' : '') +
      (window.GeamsGuide && GeamsGuide.has() ? '<div style="font-size:13px;font-weight:600;margin:10px 0 2px">Help</div><button type="button" id="a11y-tour" style="width:100%;padding:10px;margin:3px 0;border-radius:8px;border:1px solid #3a4a5c;background:transparent;color:#e6eef6;font-size:14px;text-align:left">🧭 Take the guided tour' + (GeamsGuide.done() ? ' (done before)' : '') + '</button>' : '') +
      '<div style="font-size:11.5px;color:#9db0c3;line-height:1.4;margin-top:8px">Larger text works best on current Chrome, Edge and Safari. Higher contrast darkens and sharpens colours but does not redesign the screens.</div>' +
      '<button type="button" id="a11y-reset" style="width:100%;margin-top:8px;padding:9px;border-radius:8px;border:1px solid #3a4a5c;background:transparent;color:#cfd9e3">Reset to normal</button>' +
      '<button type="button" id="a11y-close" style="width:100%;margin-top:6px;padding:10px;border-radius:8px;border:1px solid #3a4a5c;background:#1b2b3b;color:#fff">Done</button></div>';
    document.body.appendChild(o);
    const close = () => { o.remove(); if (opener && opener.focus) try { opener.focus(); } catch (e) {} }, opener = document.activeElement;
    o.querySelector('#a11y-close').onclick = close; o.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    o.querySelectorAll('button[data-k]').forEach(b => b.onclick = () => {
      const k = b.dataset.k; if (k.slice(0, 4) === 'size') st.size = +k.slice(4); else if (k === 'hc0' || k === 'hc1') st.contrast = k === 'hc1' ? 1 : 0; else st.motion = k === 'rm1' ? 1 : 0;
      save(); apply(); panel(); const nb = document.querySelector('#a11y-overlay button[data-k="' + k + '"]'); if (nb) nb.focus();
    });
    const rs = o.querySelector('#a11y-reset'); rs.onclick = () => { st = Object.assign({}, DEF); save(); apply(); panel(); };
    const tb = o.querySelector('#a11y-tour'); if (tb) tb.onclick = () => { o.remove(); GeamsGuide.start(); };
    const lg = o.querySelector('#a11y-lang'); if (lg) lg.onclick = () => { o.remove(); window.GeamsI18n.pick(); };
    (o.querySelector('button[aria-pressed="true"]') || o.querySelector('#a11y-close')).focus();
  }

  /* ---- Always on: names and keyboard access ---- */
  const EMOJI_NAMES = { '✕': 'Close', '×': 'Close', '✖': 'Close', '←': 'Back', '‹': 'Back', '☰': 'Menu', '⋮': 'More', '…': 'More', '+': 'Add', '−': 'Remove', '🔔': 'Notifications', '⚙': 'Settings', '⚙️': 'Settings', '🔍': 'Search', '📞': 'Call', '📍': 'Location', '🎤': 'Voice', '📷': 'Camera', '➤': 'Send', '↑': 'Send', '🗑': 'Delete', '🗑️': 'Delete', '↻': 'Refresh', '🔄': 'Refresh', '⟳': 'Refresh', '❌': 'Close', '✓': 'Done', '✔': 'Done', '🚨': 'Emergency', '💬': 'Chat', '🔒': 'Lock' };
  const nameOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent || '').replace(/\s+/g, ' ').trim());
  let fixed = 0;
  function label(el) {
    try {
      if (el.matches && el.matches('button,[role=button],a[href]')) {
        if (!el.getAttribute('aria-label') && !(el.textContent || '').replace(/[\s\p{Extended_Pictographic}‍️]/gu, '').length) {
          const n = el.getAttribute('title') || EMOJI_NAMES[(el.textContent || '').trim()] || (el.querySelector('img[alt]') || {}).alt || ''; if (n) { el.setAttribute('aria-label', n); fixed++; }
        } else if (!el.getAttribute('aria-label') && /^[✕×✖←‹☰⋮…+−↻⟳➤↑]$/.test((el.textContent || '').trim())) { el.setAttribute('aria-label', EMOJI_NAMES[el.textContent.trim()]); fixed++; }
      }
      if (el.matches && el.matches('div,span,li,tr,td,section,article,p,img') && (el.hasAttribute('onclick') || el.__geamsClick) && !el.closest('button,a[href]') && !(el.querySelector && el.querySelector('button,input,select,textarea,a[href],[onclick]'))) {
        if (!el.getAttribute('role')) { el.setAttribute('role', 'button'); fixed++; }
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
        if (!el.getAttribute('aria-label') && !(el.textContent || '').trim()) { const n = el.getAttribute('title') || el.getAttribute('alt'); if (n) el.setAttribute('aria-label', n); }
      }
      if (el.matches && el.matches('input,select,textarea') && el.type !== 'hidden' && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')) {
        const hasLabel = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]') || el.closest('label');
        if (!hasLabel) { const n = el.getAttribute('placeholder') || el.getAttribute('title'); if (n) { el.setAttribute('aria-label', n); fixed++; } }
      }
    } catch (e) {}
  }
  function sweep(r) { if (!r || r.nodeType !== 1) return; label(r); r.querySelectorAll && r.querySelectorAll('button,[role=button],a[href],input,select,textarea,[onclick]').forEach(label); }
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.getAttribute && e.target.getAttribute('role') === 'button' && !/^(BUTTON|A|INPUT)$/.test(e.target.tagName)) { e.preventDefault(); e.target.click(); }
  });

  /* Pop-up messages are read out. The app's own toast boxes are watched and their text is copied to a hidden live region. */
  let live = null; const said = new WeakSet();
  function announce(el) {
    if (!live || said.has(el)) return; said.add(el); const t = (el.textContent || '').replace(/\s+/g, ' ').trim(); if (!t) return;
    live.textContent = ''; setTimeout(() => { live.textContent = t.slice(0, 240); }, 50);
  }
  function boot() {
    live = document.createElement('div'); live.id = 'geams-sr-live'; live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); live.setAttribute('data-no-i18n', '1'); document.body.appendChild(live);
    sweep(document.body);
    new MutationObserver((ms) => { ms.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType !== 1) return; sweep(n); if ((n.className && /toast/i.test(String(n.className))) || (n.id && /toast/i.test(n.id))) announce(n); n.querySelectorAll && n.querySelectorAll('[class*="toast"]').forEach(announce); })); }).observe(document.body, { childList: true, subtree: true });
    if (document.documentElement.getAttribute('data-a11y-fab') !== '0' && !document.getElementById('geams-a11y-fab')) {
      const f = document.createElement('button'); f.id = 'geams-a11y-fab'; f.type = 'button'; f.setAttribute('aria-label', 'Display and language settings'); f.setAttribute('title', 'Display and language'); f.setAttribute('data-no-i18n', '1'); f.textContent = 'Aa'; f.onclick = panel; document.body.appendChild(f);
    }
  }
  window.GeamsA11y = { open: panel, state: () => Object.assign({}, st), set: (o) => { Object.assign(st, o); save(); apply(); }, labelled: () => fixed };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
