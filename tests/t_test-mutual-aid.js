const { chromium } = require('playwright');

const BASE = 'http://localhost:8831/geams-fire-service.html';
const ACCRA = { id: 'GH-GA-ACC-001-B9C1', name: 'Accra Central', lat: 5.5502, lng: -0.2174 };
const TEMA  = { id: 'GH-GA-ACC-007-F2A3', name: 'Tema', lat: 5.6698, lng: -0.0167 };

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS -', name); }
  else { fail++; console.log('  FAIL -', name, detail !== undefined ? '-> ' + JSON.stringify(detail) : ''); }
}

(async () => {
  const browser = await chromium.launch();
  // Two independent devices: separate browser contexts = separate storage,
  // exactly like two different phones. They only ever "talk" through the
  // shared sync layer (GeamsSync), never by sharing a JS heap or DOM.
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage(); // Accra Central crew — will request backup
  const pageB = await ctxB.newPage(); // Tema crew — will receive and accept backup

  pageA.on('console', m => { if (m.type() === 'error') console.log('  [A console error]', m.text()); });
  pageB.on('console', m => { if (m.type() === 'error') console.log('  [B console error]', m.text()); });

  console.log('\n1. Loading app on two independent devices (separate browser contexts)...');
  await pageA.goto(BASE);
  await pageB.goto(BASE);

  // Because GeamsSync falls back to localStorage (no dedicated backend in
  // this sandbox), and separate browser CONTEXTS do not share localStorage
  // (by design — like two different phones), bridge the two origins'
  // storage here for the purposes of this test only, by polling A's store
  // and mirroring writes into B's and vice versa. This stands in for the
  // real deployment's shared WebSocket backend without changing a single
  // line of app code or touching the sync API surface.
  // IMPORTANT: apply an incoming bridged write using the ORIGINAL setItem
  // on the receiving page, never the overridden one — otherwise the write
  // re-triggers that page's own override and the two pages echo the same
  // write back and forth forever, which can let a stale echo of an older
  // value clobber a newer one. This dedup/one-way-per-hop behavior is a
  // property of this test's storage bridge only; it has nothing to do with
  // the app code being tested.
  async function bridgeStorage(a, b, label) {
    await a.exposeFunction('__bridgeTo_' + label, async (k, v) => {
      await b.evaluate(([k, v]) => {
        if (window.__origSetItem) window.__origSetItem(k, v); else localStorage.setItem(k, v);
      }, [k, v]);
    });
    await a.evaluate((label) => {
      if (!window.__origSetItem) window.__origSetItem = localStorage.setItem.bind(localStorage);
      const origSet = window.__origSetItem;
      let applyingBridged = false;
      localStorage.setItem = function (k, v) {
        origSet(k, v);
        if (!applyingBridged) window['__bridgeTo_' + label](k, v);
      };
    }, label);
  }
  await bridgeStorage(pageA, pageB, 'A');
  await bridgeStorage(pageB, pageA, 'B');

  console.log('\n2. Logging in Page A as the demo Accra Central crew...');
  await pageA.fill('#login-name', 'Station Officer K. Mensah');
  await pageA.fill('#login-pass', 'Fire@2024!');
  await pageA.click('#login-btn');
  await pageA.waitForTimeout(1200);
  const crewA = await pageA.evaluate(() => FireData.crew?.name);
  check('Page A signed in', crewA === 'Station Officer K. Mensah', crewA);

  console.log('\n3. Registering Page B as a new Tema crew member via real signup flow...');
  await pageB.click('text=New crew member? Register');
  await pageB.fill('#su-name', 'FO J. Owusu');
  await pageB.selectOption('#su-rank', 'Fire Officer (FO)');
  await pageB.fill('#su-phone', '+233-24-5559999');
  await pageB.fill('#su-vehicle', 'Engine 9');
  await pageB.selectOption('#su-lcr', TEMA.id);
  await pageB.fill('#su-pass', 'tema123');
  await pageB.fill('#su-pass2', 'tema123');
  await pageB.click('#signup-btn');
  await pageB.waitForTimeout(1200);
  const crewB = await pageB.evaluate(() => FireData.crew ? { name: FireData.crew.name, lcrId: FireData.crew.lcrId } : null);
  check('Page B signed in to Tema jurisdiction', crewB && crewB.lcrId === TEMA.id, crewB);

  console.log('\n4. Simulating an LCR forwarding a real incident to Accra Central Fire (as the Station app would)...');
  const incident = {
    id: 'INC-TEST-001', type: 'Structure Fire', priority: 'critical',
    location: '12 Ring Road, Accra', lat: 5.556, lng: -0.199,
    notes: 'Multi-storey building, occupants reported trapped',
    serviceStatus: 'new', forwardedBy: 'Accra Central LCR',
  };
  await pageA.evaluate((inc) => {
    const raw = localStorage.getItem('geams:fire:GH-GA-ACC-001-B9C1:incidents');
    const m = raw ? JSON.parse(raw) : {};
    m[inc.id] = inc;
    localStorage.setItem('geams:fire:GH-GA-ACC-001-B9C1:incidents', JSON.stringify(m));
  }, incident);
  await pageA.waitForTimeout(3000);
  const queueHasIt = await pageA.evaluate(() => document.getElementById('screen-queue').innerHTML.includes('Structure Fire'));
  check('Page A queue shows the forwarded incident', queueHasIt);

  console.log('\n5. Page A crew accepts the call...');
  await pageA.click('text=Respond');
  await pageA.waitForTimeout(500);
  const jobA = await pageA.evaluate(() => FireData.currentJob ? { id: FireData.currentJob.id, lat: FireData.currentJob.lat, lng: FireData.currentJob.lng } : null);
  check('Page A has an active job matching the incident GPS', jobA && jobA.lat === incident.lat && jobA.lng === incident.lng, jobA);

  console.log('\n6. Page A opens Request Mutual Aid and checks nearby-station ranking is real distance, not fake...');
  const nearby = await pageA.evaluate(() => FireData.nearbyStations(FireData.crew.lcrId).slice(0,3).map(s => ({id:s.id, name:s.name, km:s.distanceKm})));
  const expectedTemaKm = haversineKm(ACCRA.lat, ACCRA.lng, TEMA.lat, TEMA.lng);
  const temaEntry = nearby.find(s => s.id === TEMA.id);
  check('Nearest-station distance to Tema matches real haversine calc', temaEntry && Math.abs(temaEntry.km - expectedTemaKm) < 0.01, { got: temaEntry, expected: expectedTemaKm });
  check('List is sorted nearest-first', nearby.every((s,i)=> i===0 || s.km >= nearby[i-1].km), nearby);

  console.log('\n7. Page A sends a real mutual-aid request to Tema...');
  await pageA.click('text=Request Mutual Aid');
  await pageA.waitForTimeout(300);
  await pageA.click(`button:has-text("Send Request")`);
  await pageA.waitForTimeout(500);
  const outgoing = await pageA.evaluate(() => FireMutualAid.myOutgoing());
  check('Outgoing request recorded with status pending', outgoing.length === 1 && outgoing[0].status === 'pending', outgoing);
  const reqId = outgoing[0]?.id;

  console.log('\n8. Page B (Tema, separate device/context) receives the request via the real sync channel...');
  await pageB.waitForTimeout(2500);
  const incomingB = await pageB.evaluate(() => FireMutualAid.myIncoming());
  check('Page B sees exactly one incoming mutual-aid request', incomingB.length === 1, incomingB);
  check('Incoming request carries the real incident GPS and station name', incomingB[0] && incomingB[0].lat === incident.lat && incomingB[0].originStationName === 'Accra Central', incomingB[0]);

  console.log('\n9. Page B navigates to Mutual Aid tab and accepts...');
  await pageB.click('text=Mutual Aid');
  await pageB.waitForTimeout(300);
  await pageB.click('text=Accept & Respond');
  await pageB.waitForTimeout(500);
  const jobB = await pageB.evaluate(() => FireData.currentJob ? { isMutualAid: FireData.currentJob.isMutualAid, lat: FireData.currentJob.lat, lng: FireData.currentJob.lng, origin: FireData.currentJob.mutualAidOrigin } : null);
  check('Page B now has an active mutual-aid job at the correct incident location', jobB && jobB.isMutualAid && jobB.lat === incident.lat && jobB.origin === 'Accra Central', jobB);

  console.log('\n10. Page A sees the acceptance (status + live map) in real time...');
  await pageA.waitForTimeout(2500);
  const recAfterAccept = await pageA.evaluate(() => FireMutualAid.recordFor(window.__reqId) , ).catch(()=>null);
  const recA = await pageA.evaluate((id) => FireMutualAid.recordFor(id), reqId);
  check('Page A\'s copy of the request shows accepted + responder identity', recA && recA.status === 'accepted' && recA.acceptedByName === 'FO J. Owusu', recA);
  check('Accepted record carries a live unit position (Tema station coords)', recA && Math.abs(recA.unitLat - TEMA.lat) < 0.001 && Math.abs(recA.unitLng - TEMA.lng) < 0.001, recA);

  await pageA.evaluate(() => FireApp.navigate('job'));
  await pageA.waitForTimeout(300);
  const jobScreenHtml = await pageA.evaluate(() => document.getElementById('screen-job').innerHTML);
  check('Page A\'s job screen shows the live mutual-aid status line', jobScreenHtml.includes('FO J. Owusu') && jobScreenHtml.includes('is responding'));

  console.log('\n11. Page B departs (en route) — real live position should propagate back to Page A\'s map marker...');
  await pageB.evaluate(() => FireApp.setStatus('en_route'));
  await pageA.waitForTimeout(3500); // one route tick (2s) + sync poll
  const recMoving = await pageA.evaluate((id) => FireMutualAid.recordFor(id), reqId);
  const moved = recMoving && (recMoving.unitLat !== TEMA.lat || recMoving.unitLng !== TEMA.lng) && recMoving.unitETA != null;
  check('Backup unit position updates propagate live to the origin station', moved, recMoving);

  console.log('\n12. Declined-request path (separate scenario) — verify honest negative outcome too...');
  const incident2 = { id:'INC-TEST-002', type:'Vehicle Fire', priority:'high', location:'Spintex Rd', lat:5.60, lng:-0.15, notes:'', serviceStatus:'new', forwardedBy:'Accra Central LCR' };
  await pageA.evaluate((inc) => {
    const raw = localStorage.getItem('geams:fire:GH-GA-ACC-001-B9C1:incidents');
    const m = raw ? JSON.parse(raw) : {};
    m[inc.id] = inc;
    localStorage.setItem('geams:fire:GH-GA-ACC-001-B9C1:incidents', JSON.stringify(m));
  }, incident2);
  // Page A must finish/clear its first job before accepting a second one
  await pageA.evaluate(() => FireApp.setStatus('on_scene'));
  await pageA.evaluate(() => FireApp.setStatus('complete'));
  await pageA.waitForTimeout(500);
  await pageA.evaluate(() => FireApp.navigate('queue'));
  await pageA.waitForTimeout(3000);
  await pageA.click('text=Respond');
  await pageA.waitForTimeout(400);
  await pageA.click('text=Request Mutual Aid');
  await pageA.waitForTimeout(300);
  await pageA.click(`button:has-text("Send Request")`);
  await pageA.waitForTimeout(2500); // let FireMutualAid's own watch tick refresh its local cache
  const outgoing2 = await pageA.evaluate(() => FireMutualAid.myOutgoing().find(r=>r.incidentId==='INC-TEST-002'));
  await pageB.waitForTimeout(2500);
  const reqId2 = outgoing2?.id;
  const incomingB2 = await pageB.evaluate((id) => FireMutualAid.recordFor(id), reqId2);
  check('Second request reached Page B', !!incomingB2, incomingB2);
  await pageB.evaluate(() => FireApp.navigate('aid'));
  await pageB.waitForTimeout(300);
  await pageB.click('text=Decline');
  await pageA.waitForTimeout(2500);
  const recDeclined = await pageA.evaluate((id) => FireMutualAid.recordFor(id), reqId2);
  check('Decline propagates back to origin as a real status, not silently', recDeclined && recDeclined.status === 'declined', recDeclined);

  console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====\n`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
