/* GEAMS: sign-in boxes are always empty for the next person.
 * Clears username, password, passphrase, Station ID and recovery fields (a) when a sign-in screen appears (after sign-out, page reopened or
 * "back"), (b) when it disappears after a successful sign-in, and (c) on load, to beat browser autofill. It never clears a box the person
 * is typing in. It also tells the browser not to remember these fields. Nothing is sent anywhere. */
(function () {
  const IDS = ['login-name', 'login-pass', 'login-station-id', 'login-passphrase', 'login-cmd-user', 'login-cmd-pass', 'hq-user', 'hq-pass', 'u', 'pw',
    'su-pass', 'su-pass2', 'np1', 'np2', 'rs-id', 'rs-code', 'rs-pin', 'rs-pin2', 'rs-phone', 'rs-sms'];
  const vis = (el) => !!(el.offsetParent || el.getClientRects().length);
  const state = new Map(), touched = new Set();
  function prep(el) {
    if (el.dataset.lcPrep) return; el.dataset.lcPrep = '1';
    el.setAttribute('autocomplete', el.type === 'password' ? 'new-password' : 'off'); el.setAttribute('autocorrect', 'off');
    /* typed by a person (or filled by a script on purpose), not a browser autofill or restore: those carry no typing inputType */
    el.addEventListener('input', (e) => { if (!e.isTrusted || /^(insert(Text|FromPaste|FromDrop|Composition)|delete)/.test(e.inputType || '')) touched.add(el); });
  }
  function wipe(el) { if (el.value !== '') el.value = ''; touched.delete(el); }
  function tick(initial) {
    IDS.forEach((id) => {
      const el = document.getElementById(id); if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName)) return; prep(el);
      const v = vis(el), was = state.get(el);
      if (v && was !== true) { if (!touched.has(el)) wipe(el); }                                /* sign-in screen just appeared */
      else if (!v && was === true) wipe(el);                             // signed in: do not leave credentials in the page
      else if (v && initial && !touched.has(el) && document.activeElement !== el) wipe(el); // browser autofill right after load
      state.set(el, v);
    });
  }
  const go = () => { tick(true); [250, 800, 1800].forEach((t) => setTimeout(() => tick(true), t)); setInterval(() => tick(false), 400); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
  window.addEventListener('pageshow', () => { state.clear(); tick(true); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(false); });
})();
