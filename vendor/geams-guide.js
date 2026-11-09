/* GEAMS guided tour. A short, step-by-step walk through the real screens of the app you are in.
 * It only points at buttons that exist and explains them. It never creates test alerts, fake incidents or fake people.
 * For hands-on practice, a control room uses the Drill button, which makes a clearly labelled [DRILL] incident. */
(function () {
  if (window.GeamsGuide) return;
  const F = location.pathname.split('/').pop();
  const T = (re) => ({ text: re });       // find a visible control by its words
  const TOURS = {
    'geams-civilian-app.html': { gate: '#nav-tabs, .nav-tab', blockedBy: '#boot-screen, #pin-gate:not(.hidden)', steps: [
      { sel: '.nav-tab[data-screen="home"]', title: 'Home', text: 'Home shows your nearest control room and the state of your connection. The big hold-to-send button here raises an alert.', before: "CivilianApp.navigate('home')" },
      { sel: '.nav-tab[data-screen="emergency"]', title: 'Emergency', text: 'Pick what is wrong and who you need (police, fire or ambulance). Your phone\'s own location is sent with the alert.' },
      { sel: '.nav-tab[data-screen="report"]', title: 'Report', text: 'Use this for something that is not an emergency right now, such as a crime you saw earlier. It goes to your control room.' },
      { sel: '.nav-tab[data-screen="track"]', title: 'Track', text: 'After you send an alert, follow what is happening here: who has been told and who is on the way.' },
      { sel: '.nav-tab[data-screen="chat"]', title: 'Chat', text: 'Talk to the control room about an alert you have sent.' },
      { sel: '.nav-tab[data-screen="profile"]', title: 'Profile and settings', text: 'Your recovery code, privacy choices, language, text size and feedback are here. Save your recovery code: it is how you get your account back on a new phone.', before: "CivilianApp.navigate('profile')" },
      { sel: null, title: 'Please do not test the emergency button', text: 'Every alert goes to real responders. This tour has not sent anything. If you want to practise, ask your control room to run a drill.' } ] },
    'geams-dispatch-app.html': { gate: '#sidebar, #bottom-nav', blockedBy: '#boot-screen', steps: [
      { sel: '.side-tab[data-screen="job"], .nav-tab[data-screen="job"]', title: 'Jobs', text: 'New jobs sent to you by your control room appear here. Accept one to start, then update its status as you go.', before: "DispatchApp.navigate('job')" },
      { sel: '.side-tab[data-screen="map"], .nav-tab[data-screen="map"]', title: 'Live map', text: 'Your position and the job location. Your location is the phone\'s GPS; if GPS is off, you will see a warning.' },
      { sel: '.side-tab[data-screen="comms"], .nav-tab[data-screen="comms"]', title: 'Comms', text: 'Messages with your control room. If you have no signal, messages you send wait on the phone and go when the signal returns.' },
      { sel: '.side-tab[data-screen="evidence"], .nav-tab[data-screen="evidence"]', title: 'Evidence', text: 'Add photos and notes to a job. Files are sealed when stored so any later change can be detected.' },
      { sel: '.side-tab[data-screen="profile"], .nav-tab[data-screen="profile"]', title: 'Profile', text: 'Your details, password, feedback and availability are here.', before: "DispatchApp.navigate('profile')" },
      { sel: T(/My availability/i), title: 'My availability', text: 'Tell your commander if you are available, on a break or unavailable. It is what you declare, it does not stop alerts reaching you.' },
      { sel: '.sos-mini-btn, [onclick*="officerSOS"]', title: 'Officer SOS', text: 'Only for when you are in danger. It alerts your control room. Do not press it to test.' } ] },
    'geams-fire-service.html': { gate: '#main-view', blockedBy: '#main-view[style*="display:none"], #main-view[style*="display: none"]', steps: [
      { sel: '.nav-tab[data-screen="queue"]', title: 'Calls', text: 'Fire calls for your station arrive here. Take one to start a response.', before: "FireApp.navigate('queue')" },
      { sel: '.nav-tab[data-screen="job"]', title: 'Active response', text: 'The job you are working: status, location and updates. Updates made with no signal wait on the phone and send later.' },
      { sel: '.nav-tab[data-screen="aid"]', title: 'Mutual aid', text: 'Ask another station for help, or answer a request from one.' },
      { sel: 'button[title="My availability"]', title: 'My availability', text: 'Say whether you can take a call. Your commander sees it on the station roster.' },
      { sel: 'button[title="Send feedback"]', title: 'Feedback', text: 'Tell HQ about a problem or an idea. It goes to the GEAMS team, not to the public.' },
      { sel: 'button[title="End Shift"]', title: 'End shift', text: 'Signs you out at the end of your shift.' } ] },
    'geams-ambulance-service.html': { gate: '#main-view', blockedBy: '#main-view[style*="display:none"], #main-view[style*="display: none"]', steps: [
      { sel: '.nav-tab[data-screen="queue"]', title: 'Calls', text: 'Ambulance calls for your station arrive here. Take one to start a response.', before: "AmbulanceApp.navigate('queue')" },
      { sel: '.nav-tab[data-screen="job"]', title: 'Active response', text: 'The job you are working: status, location and updates. Updates made with no signal wait on the phone and send later.' },
      { sel: '.nav-tab[data-screen="aid"]', title: 'Mutual aid', text: 'Ask another station for help, or answer a request from one.' },
      { sel: 'button[title="My availability"]', title: 'My availability', text: 'Say whether you can take a call. Your commander sees it on the station roster.' },
      { sel: 'button[title="Send feedback"]', title: 'Feedback', text: 'Tell HQ about a problem or an idea. It goes to the GEAMS team, not to the public.' },
      { sel: 'button[title="End Shift"]', title: 'End shift', text: 'Signs you out at the end of your shift.' } ] },
    'geams-station-dashboard__1_.html': { gate: '#app', blockedBy: '#app[style*="display:none"], #app[style*="display: none"]', steps: [
      { sel: '.nav-item[data-page="dashboard"]', title: 'Dashboard', text: 'The map and the numbers for your station. Counts come from the live records, not from sample data.', before: "StationApp.navigate('dashboard')" },
      { sel: '.nav-item[data-page="incidents"]', title: 'Incidents', text: 'Every alert for your station. Open one to assign it, update it, merge duplicates or resolve it.' },
      { sel: '.nav-item[data-page="dispatch"]', title: 'Dispatch', text: 'Send an officer, fire crew or ambulance to an incident.' },
      { sel: '.nav-item[data-page="officers"]', title: 'Officers', text: 'Officers who are signed in right now, with their last known position.' },
      { sel: '.nav-item[data-page="backup"]', title: 'Backup requests', text: 'Ask neighbouring stations for help, or answer their requests.' },
      { sel: T(/Crew Roster/i), title: 'Crew roster', text: 'Set who is on day or night shift. Crew mark themselves available or on break from their own app.' },
      { sel: T(/Shift Handover/i), title: 'Shift handover', text: 'Write notes for the next commander. They are saved and cannot be edited, and the incoming commander confirms they have read them.' },
      { sel: T(/Drill/i), before: "StationApp.navigate('incidents')", title: 'Drill: practise safely', text: 'A drill makes a clearly labelled [DRILL] incident so you can practise dispatching. It is left out of reports and analytics. Use this, not real alerts, to train.' },
      { sel: T(/Station Lockdown/i), title: 'Station lockdown', text: 'Records a lockdown so HQ and neighbours can see it. It cannot lock doors or divert calls: use your radio for that.' } ] },
    'geams-hq-dashboard__1_.html': { gate: '#sidebar', blockedBy: '#hq-login.show', steps: [
      { sel: '.nav-item[data-page="overview"]', title: 'Overview', text: 'National picture built from the live records of every control room.', before: "GeamsApp.navigate('overview')" },
      { sel: '.nav-item[data-page="incidents"]', title: 'Incidents', text: 'All incidents across stations. Drills are marked and left out of analytics.' },
      { sel: '.nav-item[data-page="stations"]', title: 'Stations', text: 'Add or disable stations and issue each control room its login.' },
      { sel: '.nav-item[data-page="officers"]', title: 'Officers', text: 'Officers signed in now, by station.' },
      { sel: '.nav-item[data-page="analytics"]', title: 'Analytics', text: 'Response times and volumes, worked out from the records. Updates sent from a crew phone after a delay are timed when the server received them.' },
      { sel: '.nav-item[data-page="broadcast"]', title: 'Broadcast', text: 'Send an alert to civilians and officers in chosen areas.' },
      { sel: '.nav-item[data-page="security"]', title: 'Security', text: 'Sign-ins, retention, abuse controls, staff action log, app errors and feedback are managed here.' },
      { sel: '.nav-item[data-page="syshealth"]', title: 'System health', text: 'Whether the server, storage and backups are working.' } ] }
  };
  const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.01; };
  function find(sel) {
    if (!sel) return null;
    if (typeof sel === 'string') { const els = [...document.querySelectorAll(sel)]; return els.find(vis) || null; }
    const re = sel.text, els = [...document.querySelectorAll('button,.btn,.nav-item,.side-tab,.nav-tab,[onclick],a')];
    return els.filter(vis).find(e => re.test((e.textContent || '').trim()) && (e.textContent || '').trim().length < 60) || null;
  }
  let i = 0, tour = null, o = null, ring = null, opts = {};
  const clean = () => { if (o) o.remove(); if (ring) ring.remove(); o = ring = null; document.removeEventListener('keydown', onKey, true); };
  function onKey(e) { if (e.key === 'Escape') { clean(); } else if (e.key === 'ArrowRight') { go(1); } else if (e.key === 'ArrowLeft') { go(-1); } }
  async function show() {
    const s = tour.steps[i]; let el = null;
    if (s.before) { try { new Function(s.before)(); } catch (e) {} await new Promise(r => setTimeout(r, 450)); }
    el = find(s.sel);
    if (!ring) { ring = document.createElement('div'); ring.id = 'guide-ring'; ring.style.cssText = 'position:fixed;z-index:2147483200;border:3px solid #ffd400;border-radius:10px;box-shadow:0 0 0 9999px rgba(0,0,0,.55);pointer-events:none;transition:all .2s'; document.body.appendChild(ring); }
    if (el) { try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {} await new Promise(r => setTimeout(r, 120)); const r = el.getBoundingClientRect(); const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;   // text-size setting zooms the page; rectangles come back in screen pixels
      Object.assign(ring.style, { left: (r.left / z - 4) + 'px', top: (r.top / z - 4) + 'px', width: (r.width / z + 8) + 'px', height: (r.height / z + 8) + 'px', display: 'block' }); }
    else { Object.assign(ring.style, { display: 'block', left: '50%', top: '40%', width: '0', height: '0' }); }
    const n = tour.steps.length;
    o.innerHTML = '<div style="font-size:11.5px;color:#9db0c3;margin-bottom:2px">Step ' + (i + 1) + ' of ' + n + (s.sel && !el ? ' · this button is not on screen right now' : '') + '</div><div style="font-size:16px;font-weight:700;margin-bottom:4px">' + esc(s.title) + '</div><div style="font-size:13.5px;line-height:1.5;color:#dbe6f0">' + esc(s.text) + '</div>'
      + '<div style="display:flex;gap:8px;margin-top:12px"><button type="button" data-g="x" style="padding:9px 12px;border-radius:8px;border:1px solid #3a4a5c;background:transparent;color:#cfd9e3">' + (i === n - 1 ? 'Close' : 'Skip tour') + '</button><span style="flex:1"></span>'
      + (i > 0 ? '<button type="button" data-g="b" style="padding:9px 14px;border-radius:8px;border:1px solid #3a4a5c;background:transparent;color:#e6eef6">Back</button>' : '') + (i < n - 1 ? '<button type="button" data-g="n" style="padding:9px 16px;border-radius:8px;border:0;background:#1f9d6a;color:#fff;font-weight:700">Next</button>' : '<button type="button" data-g="d" style="padding:9px 16px;border-radius:8px;border:0;background:#1f9d6a;color:#fff;font-weight:700">Done</button>') + '</div>';
    o.querySelector('[data-g="x"]').onclick = clean; const bb = o.querySelector('[data-g="b"]'), nn = o.querySelector('[data-g="n"]'), dd = o.querySelector('[data-g="d"]');
    if (bb) bb.onclick = () => go(-1); if (nn) { nn.onclick = () => go(1); nn.focus(); } if (dd) { dd.onclick = () => { try { localStorage.setItem('geams_tour_' + F, '1'); } catch (e) {} clean(); }; dd.focus(); }
  }
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function go(d) { i = Math.max(0, Math.min(tour.steps.length - 1, i + d)); show(); }
  function start(op) {
    opts = op || {}; clean(); tour = TOURS[F]; const ov = document.getElementById('a11y-overlay'); if (ov) ov.remove();
    o = document.createElement('div'); o.id = 'guide-card'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-label', 'Guided tour'); o.setAttribute('data-no-i18n', '1');
    o.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:16px;width:calc(100% - 24px);max-width:420px;z-index:2147483300;background:#101a24;border:1px solid #2c3d4f;border-radius:14px;padding:14px 16px;color:#e6eef6;font-family:system-ui,sans-serif;box-shadow:0 6px 30px rgba(0,0,0,.6)';
    document.body.appendChild(o); document.addEventListener('keydown', onKey, true);
    const blocked = !opts.skipGate && tour && ((tour.gate && !find(tour.gate)) || (tour.blockedBy && [...document.querySelectorAll(tour.blockedBy)].some(vis)));
    if (!tour || blocked) { tour = { steps: [{ sel: null, title: tour ? 'Sign in first' : 'No tour here', text: tour ? 'The tour points at the real screens, which appear after you sign in. Sign in, then open Display and language and choose "Take the guided tour".' : 'This screen has no guided tour.' }] }; }
    i = 0; show();
  }
  window.GeamsGuide = { start, has: () => !!TOURS[F], steps: () => (TOURS[F] ? TOURS[F].steps.length : 0), done: () => { try { return localStorage.getItem('geams_tour_' + F) === '1'; } catch (e) { return false; } } };
})();
