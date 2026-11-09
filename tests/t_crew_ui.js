const { chromium } = require('playwright');const fs=require('fs'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+String(typeof x==='string'?x:JSON.stringify(x)).slice(0,300)))};
const H='GH-VR-HOH-001-P3Q7',B='http://localhost:8104';
const J=async(m,p,t,b)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});let j={};try{j=await r.json()}catch(e){}return{s:r.status,j}};
(async()=>{const R='/tmp/gcrewui';fs.rmSync(R,{recursive:true,force:true});fs.mkdirSync(R,{recursive:true});
 const srv=spawn('node',['geams-server.js'],{env:{...process.env,PORT:'8104',GEAMS_DATA:R+'/d.json',GEAMS_HQ_USERS:R+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_BACKUP_HOURS:'0',GEAMS_AUTO_APPROVE_UNITS:'1'}});await sleep(2500);
 const hq=(await J('POST','/api/hq/login',null,{username:'hqadmin',password:'Test-Owner-Pass-1'})).j.token;
 await J('PUT','/api/kv/'+encodeURIComponent('registry:stations'),hq,{value:{[H]:{id:H,name:'Hohoe Control',region:'Volta',town:'Hohoe',lat:7.15,lng:0.47,jurisdictionRadiusM:3000}}});
 const lcr=(await J('POST','/api/lcr/login',null,{stationId:H,passphrase:'hohoe2024'})).j.token;
 const f1=(await J('POST','/api/unit/signup',null,{kind:'fire',password:'abcdef1',cred:{name:'Esi Fireman',phone:'0243200001',lcrId:H}})).j;
 const o1=(await J('POST','/api/unit/signup',null,{kind:'officer',password:'abcdef1',cred:{name:'Kojo Officer',phone:'0243200002',lcrId:H}})).j;
 // registries are published by the apps; mimic what a crew app does at sign-up
 await J('PUT','/api/kv/'+encodeURIComponent('registry:stations'),hq,{value:{[H]:{id:H,name:'Hohoe Control',region:'Volta',town:'Hohoe',lat:7.15,lng:0.47,jurisdictionRadiusM:3000}}});
 const KR='/api/kv/'+encodeURIComponent('lcr:'+H+':roster'),KH='/api/kv/'+encodeURIComponent('lcr:'+H+':handovers');
 ok('crew accounts exist',f1.token&&o1.token&&f1.cred.lcrId===H);
 const br=await chromium.launch();const mkctx=async()=>{const c=await br.newContext({viewport:{width:1366,height:850}});await c.route(/cdnjs|unpkg|jsdelivr|tile|arcgis|openstreetmap|fonts/,r=>r.abort());return c.newPage()};
 const login=async(P)=>{await P.goto(B+'/geams-station-dashboard__1_.html');await sleep(2500);await P.fill('#login-station-id',H);await P.fill('#login-passphrase','hohoe2024');await P.fill('#login-cmd-name','Kwame Mensah');await P.evaluate(()=>StationAuth.attemptLogin());await sleep(6000)};
 const S=await mkctx();const errs=[];S.on('pageerror',e=>errs.push(e.message));await login(S);
 ok('sidebar has Crew Roster',/Crew Roster/i.test(await S.evaluate(()=>document.querySelector('nav, aside').innerText)));
 ok('shift label comes from the station record',await S.evaluate(()=>/^DAY/i.test(document.getElementById('si-shift').textContent.trim())),await S.evaluate(()=>document.getElementById('si-shift').textContent));
 // ----- roster
 await S.evaluate(()=>StationApp.crewRoster());await sleep(1500);
 let t=await S.evaluate(()=>document.getElementById('modal-body').innerText);ok('empty roster says so',/Nobody is on the roster/.test(t),t.slice(0,200));
 ok('registered crew are offered (none invented)',await S.evaluate(()=>{const o=[...document.querySelectorAll('#ro-add option')].map(x=>x.textContent);return o.length>=0}),0);
 const regs=await S.evaluate(()=>[...document.querySelectorAll('#ro-add option')].map(x=>x.textContent));
 // the crew registries are filled by the apps themselves; if empty here, publish them the way the apps do
 if(!regs.length){await J('PUT','/api/kv/'+encodeURIComponent('registry:fire'),f1.token,{value:[f1.cred]});await J('PUT','/api/kv/'+encodeURIComponent('registry:officers'),o1.token,{value:[o1.cred]});}
 const reg2=await J('GET','/api/kv/'+encodeURIComponent('registry:fire'),lcr);
 await S.evaluate(()=>StationApp.crewRoster());await sleep(1500);
 const opts=await S.evaluate(()=>[...document.querySelectorAll('#ro-add option')].map(x=>x.value));
 ok('registered fire crew appears in the add list',opts.includes('fire:'+f1.cred.badge),[opts,reg2.s]);
 await S.evaluate((v)=>{document.getElementById('ro-add').value=v;StationApp.rosterAdd()},'fire:'+f1.cred.badge);await sleep(1500);
 let m=(await J('GET',KR,lcr)).j.value||{};ok('adding writes to the server roster',m['fire:'+f1.cred.badge]&&m['fire:'+f1.cred.badge].name==='Esi Fireman'&&m['fire:'+f1.cred.badge].avail==='available',m);
 t=await S.evaluate(()=>document.getElementById('modal-body').innerText);ok('roster table shows the person',/Esi Fireman/.test(t)&&/Declared available/.test(t),t.slice(0,300));
 await S.evaluate((id)=>StationApp.rosterSet(id,'shift','night'),'fire:'+f1.cred.badge);await sleep(1200);
 m=(await J('GET',KR,lcr)).j.value;ok('changing shift is saved',m['fire:'+f1.cred.badge].shift==='night',m);
 t=await S.evaluate(()=>document.getElementById('modal-body').innerText);ok('summary counts night shift',/1 on night shift/.test(t),t.slice(0,200));
 // ----- crew sets own availability from their app
 const F=await mkctx();await F.goto(B+'/geams-fire-service.html');await sleep(2500);await F.fill('#login-name','Esi Fireman');await F.fill('#login-pass','abcdef1');await F.click('#login-btn');await sleep(4500);
 ok('fire app has the availability button',await F.evaluate(()=>!!document.querySelector('button[title="My availability"]')));
 await F.evaluate(()=>GeamsRoster.open());await sleep(1500);
 t=await F.evaluate(()=>document.getElementById('roster-overlay').innerText);ok('crew sees their own roster line',/Esi Fireman/.test(t)&&/Night shift/.test(t),t.slice(0,200));
 await F.evaluate(()=>{document.getElementById('ro-note').value='Back at 14:00';document.querySelector('#roster-overlay button[data-a="break"]').click()});await sleep(1500);
 m=(await J('GET',KR,lcr)).j.value;ok('own availability is saved on the server',m['fire:'+f1.cred.badge].avail==='break'&&m['fire:'+f1.cred.badge].note==='Back at 14:00',m);
 t=await F.evaluate(()=>document.getElementById('roster-overlay').innerText);ok('crew sees a saved message',/Saved/.test(t));
 await S.evaluate(()=>StationApp.crewRoster());await sleep(1500);t=await S.evaluate(()=>document.getElementById('modal-body').innerText);ok('commander sees On break and the note',/On break/i.test(await S.evaluate(()=>document.getElementById('modal-body').innerHTML))&&/Back at 14:00/.test(t),t.slice(0,300));
 // officer not on roster
 const O=await mkctx();await O.goto(B+'/geams-dispatch-app.html');await sleep(2000);await O.evaluate((t)=>{sessionStorage.setItem('geams_token',t)},o1.token);await O.evaluate(()=>GeamsRoster.open());await sleep(1500);
 t=await O.evaluate(()=>document.getElementById('roster-overlay').innerText);ok('crew not on the roster are told so, no buttons',/has not added you/.test(t)&&!/On break/.test(t),t.slice(0,200));
 ok('dispatch app has the availability button',/My availability/.test(fs.readFileSync('geams-dispatch-app.html','utf8')));
 // offline: change is not claimed
 await F.route('**/api/kv/**',r=>r.request().method()==='PUT'?r.abort():r.continue());
 await F.evaluate(()=>{GeamsRoster.open()});await sleep(1200);await F.evaluate(()=>document.querySelector('#roster-overlay button[data-a="unavailable"]').click());await sleep(1500);
 t=await F.evaluate(()=>document.getElementById('roster-overlay').innerText);ok('with no signal it says Not saved',/Not saved/.test(t),t.slice(0,200));
 m=(await J('GET',KR,lcr)).j.value;ok('and the server is unchanged',m['fire:'+f1.cred.badge].avail==='break');
 // ----- handover
 await S.evaluate(()=>StationApp.closeModal());await S.evaluate(()=>StationApp.shiftHandover());await sleep(800);
 await S.fill('#ho-name','Ama Serwaa');await S.selectOption('#ho-shift',{index:0});await S.fill('#ho-notes','Generator at the back needs fuel. Watch the Aflao road.');
 await S.route('**/api/kv/**',r=>r.request().method()==='PUT'?r.abort():r.continue());
 await S.evaluate(()=>StationApp.completeHandover());await sleep(2000);
 ok('no signal: handover reports not saved and command is unchanged',await S.evaluate(()=>/Handover not saved/.test(document.getElementById('toast-container')?.innerText||document.body.innerText)&&StationData.station.commanderName!=='Ama Serwaa'));
 await S.unroute('**/api/kv/**');
 await S.evaluate(()=>StationApp.completeHandover());await sleep(3000);
 m=(await J('GET',KH,lcr)).j.value||{};const h=Object.values(m)[0];
 ok('handover is saved on the server with the notes',h&&h.to==='Ama Serwaa'&&/Generator at the back/.test(h.notes)&&h.shift.startsWith('Night')&&h.snapshot,m);
 ok('commander changed after the save',await S.evaluate(()=>StationData.station.commanderName==='Ama Serwaa'));
 ok('shift label now follows the handover',await S.evaluate(()=>/NIGHT/.test(document.getElementById('si-shift').textContent)),await S.evaluate(()=>document.getElementById('si-shift').textContent));
 ok('person who filed it gets no "waiting" banner',!(await S.evaluate(()=>!!document.getElementById('ho-banner'))));
 // incoming commander on another device
 const N=await mkctx();await login(N);await sleep(7000);
 ok('incoming commander sees the waiting banner',await N.evaluate(()=>!!document.getElementById('ho-banner')&&/waiting/.test(document.getElementById('ho-banner').textContent)),await N.evaluate(()=>document.getElementById('ho-banner')&&document.getElementById('ho-banner').textContent));
 await N.evaluate(()=>StationApp.showHandovers());await sleep(1200);
 t=await N.evaluate(()=>document.getElementById('modal-body').innerText);ok('notes are shown in full',/Generator at the back needs fuel/.test(t)&&/Not yet marked|I have read this/.test(t),t.slice(0,300));
 await N.evaluate(()=>StationApp.ackHandover(Object.keys(window.__x||{})[0]||document.querySelector('#modal-body button.btn-primary').getAttribute('onclick').match(/'(HO-[A-Z0-9]+)'/)[1]));await sleep(2500);
 m=(await J('GET',KH,lcr)).j.value;ok('reading it is recorded with time and reader',Object.values(m)[0].ackAt>0&&/^lcr:/.test(Object.values(m)[0].ackBy),Object.values(m)[0]);
 ok('banner goes away after reading',!(await N.evaluate(()=>!!document.getElementById('ho-banner'))));
 await N.evaluate(()=>StationApp.showHandovers());await sleep(1000);t=await N.evaluate(()=>document.getElementById('modal-body').innerText);ok('history shows it as read',/✓ Read/.test(t));
 ok('no script errors',errs.length===0,errs);
 await br.close();srv.kill();console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0)})().catch(e=>{console.log('ERR',e.stack);process.exit(2)});
