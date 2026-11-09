/* GEAMS language switch. Translates the words already on screen using small JSON files in vendor/lang/.
 * Anything without a translation stays in English. Files can be corrected by a native speaker without touching code. */
(function () {
  const LANGS = [{ code: 'en', name: 'English' }, { code: 'tw', name: 'Twi (Akan)' }, { code: 'ha', name: 'Hausa' }, { code: 'ee', name: 'Ewe' }, { code: 'gaa', name: 'Ga' }, { code: 'dag', name: 'Dagbani' }];
  let dict = {}, cur = 'en', obs = null; const orig = new Map(), origAttr = new Map(); const EMO = /^((?:[\p{Extended_Pictographic}‍️←→×✓✅📍\s]+))/u;
  /* The civilian app and the staff apps use different word lists. Staff screens show live incident data (types, statuses, names),
   * so they only ever get a short list of button and menu words (staff-<code>.json), never the civilian list. */
  const STAFF = !/geams-civilian-app/.test(location.pathname), langFile = (c) => 'vendor/lang/' + (STAFF ? 'staff-' : '') + c + '.json';
  const stored = () => { try { return localStorage.getItem('geams_lang') || 'en'; } catch (e) { return 'en'; } };
  const tr = (s) => { const t = s.replace(/\s+/g, ' ').trim(); if (!t) return null; if (dict[t]) return s.replace(t.length ? s.trim() : s, dict[t]); const m = EMO.exec(t); if (m) { const rest = t.slice(m[0].length).trim(); if (rest && dict[rest]) return s.replace(rest, dict[rest]); } return null; };
  function walk(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => { const p = n.parentElement; return p && !/^(SCRIPT|STYLE|TEXTAREA|CODE)$/.test(p.tagName) && !p.closest('[data-no-i18n]') ? 1 : 2; } }); let n;
    while ((n = w.nextNode())) { if (orig.has(n) && n.nodeValue === orig.get(n).out) continue; const o = n.nodeValue, t = tr(o); if (t != null && t !== o) { orig.set(n, { src: o, out: t }); n.nodeValue = t; } }
    root.querySelectorAll && root.querySelectorAll('[placeholder]').forEach((el) => { const o = origAttr.get(el) || el.getAttribute('placeholder'), t = dict[o]; if (t) { origAttr.set(el, o); el.setAttribute('placeholder', t); } });
  }
  function restore() { orig.forEach((v, n) => { if (n.isConnected) n.nodeValue = v.src; }); orig.clear(); origAttr.forEach((o, el) => el.setAttribute('placeholder', o)); origAttr.clear(); }
  async function set(code) {
    cur = code; try { localStorage.setItem('geams_lang', code); } catch (e) {}
    if (obs) { obs.disconnect(); obs = null; } restore(); dict = {}; document.documentElement.lang = code === 'gaa' || code === 'dag' ? 'en' : code;
    if (code === 'en') return true;
    try { const r = await fetch(langFile(code), { cache: 'no-cache' }); if (!r.ok) throw 0; const j = await r.json(); Object.keys(j).forEach((k) => { if (k.slice(0, 2) !== '__' && j[k] && j[k] !== k) dict[k] = j[k]; }); } catch (e) { cur = 'en'; return false; }
    walk(document.body); obs = new MutationObserver((ms) => { obs.disconnect(); ms.forEach((m) => { m.addedNodes.forEach((n) => { if (n.nodeType === 1) walk(n); else if (n.nodeType === 3 && n.parentElement) walk(n.parentElement); }); if (m.type === 'characterData' && m.target.parentElement) walk(m.target.parentElement); }); obs.observe(document.body, { childList: true, subtree: true, characterData: true }); });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true }); return true;
  }
  async function pick() {
    const old = document.getElementById('i18n-overlay'); if (old) old.remove();
    const counts = {}; await Promise.all(LANGS.filter(l => l.code !== 'en').map(async (l) => { try { const r = await fetch(langFile(l.code), { cache: 'no-cache' }); const j = r.ok ? await r.json() : {}; counts[l.code] = Object.keys(j).filter(k => k.slice(0, 2) !== '__' && j[k] && j[k] !== k).length; } catch (e) { counts[l.code] = 0; } }));
    const o = document.createElement('div'); o.id = 'i18n-overlay'; o.setAttribute('data-no-i18n', '1'); o.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;padding:16px';
    o.innerHTML = '<div style="width:100%;max-width:380px;background:#101a24;border:1px solid #2c3d4f;border-radius:14px;padding:18px;color:#e6eef6;font-family:system-ui,sans-serif"><div style="font-size:17px;font-weight:700;margin-bottom:6px">🌐 Language</div><div style="font-size:12.5px;color:#9db0c3;line-height:1.45;margin-bottom:10px">' + (STAFF ? 'Only a few button and menu words are translated in the staff apps. Incident details, statuses and names always stay in English so nothing is misread.' : 'Only the main buttons and labels are translated so far.') + ' These translations are drafts and may contain mistakes. Messages from the control room stay as written. In an emergency, the SOS button works in any language.</div>'
      + LANGS.map(l => { const n = l.code === 'en' ? 1 : counts[l.code]; const off = !n; return '<button data-l="' + l.code + '" ' + (off ? 'disabled' : '') + ' style="display:flex;justify-content:space-between;width:100%;padding:11px 12px;margin:5px 0;border-radius:8px;border:1px solid ' + (l.code === cur ? '#1f9d6a' : '#3a4a5c') + ';background:' + (l.code === cur ? '#12392b' : 'transparent') + ';color:' + (off ? '#6b7c8d' : '#e6eef6') + ';font-size:15px"><span>' + l.name + '</span><span style="font-size:12px;color:#9db0c3">' + (l.code === 'en' ? '' : off ? 'not available yet' : n + ' phrases · unchecked draft') + '</span></button>'; }).join('')
      + '<button id="i18n-close" style="width:100%;margin-top:8px;padding:10px;border-radius:8px;border:1px solid #3a4a5c;background:transparent;color:#cfd9e3">Close</button></div>';
    document.body.appendChild(o); o.querySelector('#i18n-close').onclick = () => o.remove();
    o.querySelectorAll('button[data-l]').forEach(b => b.onclick = async () => { await set(b.dataset.l); o.remove(); });
  }
  window.GeamsI18n = { set, pick, current: () => cur, LANGS };
  const go = () => { const c = stored(); if (c !== 'en') set(c); }; if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
})();
