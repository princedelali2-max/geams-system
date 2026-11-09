const { chromium } = require('playwright');const fs=require('fs'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+String(typeof x==='string'?x:JSON.stringify(x)).slice(0,300)))};
const B='http://localhost:8114',A='GH-VR-HOH-001-P3Q7';
const J=async(m,p,t,b)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});let j={};try{j=await r.json()}catch(e){}return{s:r.status,j}};
(async()=>{const R='/tmp/gcivsend';fs.rmSync(R,{recursive:true,force:true});fs.mkdirSync(R,{recursive:true});
 const srv=spawn('node',['geams-server.js'],{env:{...process.env,PORT:'8114',GEAMS_DATA:R+'/d.json',GEAMS_HQ_USERS:R+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_BACKUP_HOURS:'0',GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_ESCALATE_SECS:'0',GEAMS_PILOT_LABEL:'Hohoe pilot'}});await sleep(2500);
 const hq=(await J('POST','/api/hq/login',null,{username:'hqadmin',password:'Test-Owner-Pass-1'})).j.token;
 await J('PUT','/api/kv/'+encodeURIComponent('registry:stations'),hq,{value:{[A]:{id:A,name:'Hohoe Control',region:'V',town:'Hohoe',lat:7.15,lng:0.47,jurisdictionRadiusM:3000}}});
 const lcr=(await J('POST','/api/lcr/login',null,{stationId:A,passphrase:'hohoe2024'})).j.token,K='/api/kv/'+encodeURIComponent('lcr:'+A+':incidents');
 // ---- server: pause
 const civ=(await J('POST','/api/civilian/session',null,{secret:'civsend'+'x'.repeat(26)})).j.token;
 const rec=(id,x)=>({id,type:'Fire',priority:'critical',status:'new',location:'Somewhere',lat:7.15,lng:0.47,civilianId:'CIV-77777',civilianName:'Test',createdAt:new Date().toISOString(),source:'civilian-app',...x});
 ok('only the HQ owner can pause',(await J('POST','/api/hq/pilot',lcr,{paused:true})).s===403&&(await J('POST','/api/hq/pilot',civ,{paused:true})).s===403&&(await J('POST','/api/hq/pilot',null,{paused:true})).s===403);
 ok('pause key readable by civilians, never writable by them',(await J('GET','/api/kv/hq:pilot',civ)).s===200&&(await J('PUT','/api/kv/hq:pilot',civ,{value:{paused:true}})).s===403&&(await J('PUT','/api/kv/hq:pilot',hq,{value:{paused:true}})).s===403);
 let r=await J('POST','/api/hq/pilot',hq,{paused:true,message:'Control room power failure'});ok('HQ owner can pause',r.s===200&&r.j.paused);
 let st=(await J('GET','/api/kv/hq:pilot',civ)).j.value;ok('the stored message always includes 112',/112/.test(st.message)&&/power failure/.test(st.message),st);
 r=await J('PUT',K,civ,{value:{P1:rec('P1')}});ok('server refuses a new civilian alert while paused, with the message',r.s===422&&/power failure/.test(r.j.error)&&/112/.test(r.j.error),r);
 ok('staff are not blocked by the pause',(await J('PUT',K,lcr,{value:{W1:rec('W1',{source:'walk-in',civilianId:undefined})}})).s===200);
 r=await J('POST','/api/hq/pilot',hq,{paused:false});ok('HQ can resume',r.s===200&&!r.j.paused);
 r=await J('PUT',K,civ,{value:{P1:rec('P1',{ownerDev:undefined})}});ok('alerts are accepted again after resume',r.s===200,r);
 ok('pause and resume are in the staff log',(await J('GET','/api/stafflog',hq)).j.items.filter(x=>/^pilot\./.test(x.action)).length===2);
 // ---- ids
 // ---- browser
 const br=await chromium.launch();const c=await br.newContext({viewport:{width:390,height:800},geolocation:{latitude:7.152,longitude:0.472},permissions:['geolocation']});await c.route(/cdnjs|unpkg|jsdelivr|tile|arcgis|openstreetmap|fonts/,r=>r.abort());
 const P=await c.newPage();await P.addInitScript(()=>{window.__toasts='';new MutationObserver(m=>{m.forEach(x=>x.addedNodes.forEach(n=>{if(n.innerText)window.__toasts+=' '+n.innerText}))}).observe(document,{childList:true,subtree:true})});P.errs=[];P.on('pageerror',e=>P.errs.push(e.message+' @'+(e.stack||'').split('\n')[1]));
 await P.goto(B+'/geams-civilian-app.html');await sleep(2500);
 await P.evaluate(()=>{CivilianData.user.id='CIV-10001';CivilianData.user.name='Ama';CivilianData.user.phone='0200000001';CivilianData.user.pin='1234';CivilianData.user.gpsLat=7.152;CivilianData.user.gpsLng=0.472;CivilianData.saveAccount();CivilianApp.enterApp();setTimeout(()=>{const g=document.getElementById('pin-gate');g.classList.add('hidden');g.remove()},300)});await sleep(5000);
 const strip=()=>P.evaluate(()=>{const e=document.getElementById('pilot-strip');return e&&{t:e.innerText,bg:getComputedStyle(e).backgroundColor}});
 let sp=await strip();ok('pilot strip shows the label and 112',sp&&/Hohoe pilot/.test(sp.t)&&/112/.test(sp.t),sp);
 ok('ids are 6 random letters/digits and never repeat in 2,000 tries',await P.evaluate(()=>{const s=new Set();for(let i=0;i<2000;i++)s.add(newIncId());return s.size===2000&&[...s].every(x=>/^INC-[0-9A-Z]{6}$/.test(x))}));
 // normal send
 await P.evaluate(()=>{CivilianApp.selectEmType('Fire');CivilianApp.triggerSOS()});await sleep(500);await P.evaluate(()=>CivilianApp.confirmSOS());await sleep(1500);
 let inc=(await J('GET',K,lcr)).j.value;let mine=Object.values(inc).filter(x=>x.civilianId==='CIV-10001');
 ok('normal send reaches the server once, with a new-style number',mine.length===1&&/^INC-[0-9A-Z]{6}$/.test(mine[0].id),mine.map(x=>x.id));
 ok('"ALERT SENT" is shown only after delivery',await P.evaluate(()=>/ALERT SENT/.test(document.getElementById('toast-container')?document.getElementById('toast-container').innerText:document.body.innerText)));
 await P.evaluate(()=>{const em=CivilianData.activeEmergency();if(em)CivilianData.stopEmergency();});
 // no signal
 await P.evaluate(()=>{window.__toasts=''});
 await P.route('**/api/kv/**',r=>r.request().method()==='PUT'?r.abort():r.continue());
 await P.evaluate(()=>{CivilianData.user.gpsLat=7.172;CivilianData.user.gpsLng=0.472;CivilianApp.selectEmType('Medical');CivilianApp.triggerSOS()});await sleep(500);await P.evaluate(()=>CivilianApp.confirmSOS());await sleep(5500);
 const tt=await P.evaluate(()=>document.body.innerText);
 ok('with no signal it never claims the alert was sent',!/ALERT SENT/.test((await P.evaluate(()=>window.__toasts||'')) + '')&&/No signal/.test(tt)&&/has not reached the control room/.test(tt),tt.slice(0,200)+' || '+(await P.evaluate(()=>document.getElementById('sos-outbox')?.innerText)));
 ok('no-signal box offers Call 112',await P.evaluate(()=>!!document.querySelector('#sos-outbox a[href="tel:112"]')));
 inc=(await J('GET',K,lcr)).j.value;ok('and nothing is on the server yet',Object.values(inc).filter(x=>x.civilianId==='CIV-10001').length===1);
 await P.unroute('**/api/kv/**');await sleep(10000);
 inc=(await J('GET',K,lcr)).j.value;mine=Object.values(inc).filter(x=>x.civilianId==='CIV-10001');
 ok('when signal returns the saved alert is delivered, once',mine.length===2,mine.map(x=>x.type));
 ok('the no-signal box goes away after delivery',!(await P.evaluate(()=>!!document.getElementById('sos-outbox'))));
 await P.evaluate(()=>{const em=CivilianData.activeEmergency();if(em)CivilianData.stopEmergency();});
 // refused: blocked sender
 await J('POST','/api/abuse/set',hq,{civilianId:'CIV-10001',level:'block',reason:'test'});
 await P.evaluate(()=>{CivilianData.user.gpsLat=7.192;CivilianData.user.gpsLng=0.472;CivilianApp.selectEmType('Crime');CivilianApp.triggerSOS()});await sleep(500);await P.evaluate(()=>CivilianApp.confirmSOS());await sleep(3500);
 const rb=await P.evaluate(()=>{const e=document.getElementById('sos-outbox');return e&&{t:e.innerText,tel:!!e.querySelector('a[href="tel:112"]'),bg:getComputedStyle(e).backgroundColor}});
 ok('a refused alert shows a red "NOT accepted" box with the server\'s words and Call 112',rb&&/NOT accepted/.test(rb.t)&&/call 112/i.test(rb.t)&&/No control room has this alert/.test(rb.t)&&rb.tel,rb);
 ok('the app stops pretending an alert is active',await P.evaluate(()=>!CivilianData.activeEmergency()&&!document.getElementById('logo-dot').classList.contains('emergency')));
 ok('it is not retried forever',await P.evaluate(()=>SosOutbox.pending().length===0&&SosOutbox.refusedList().length===1));
 ok('it did not jump to the "help is coming" screen',await P.evaluate(()=>!/WAITING FOR OFFICER|Officer Assigned/i.test(document.querySelector('.screen.active,#screen-emergency.active')?.innerText||'')));
 inc=(await J('GET',K,lcr)).j.value;ok('nothing reached any control room',Object.values(inc).filter(x=>x.civilianId==='CIV-10001'&&x.type==='Crime').length===0);
 await P.click('#sos-outbox [data-act="dismiss"]');await sleep(300);ok('Dismiss clears it',!(await P.evaluate(()=>!!document.getElementById('sos-outbox'))));
 await J('POST','/api/abuse/set',hq,{civilianId:'CIV-10001',level:'none',reason:'test'});
 // collision defence
 const existing=Object.keys((await J('GET',K,lcr)).j.value)[0];
 const col=await P.evaluate(async(id)=>{const r=await SosOutbox.submit({id,stationId:'GH-VR-HOH-001-P3Q7',stationName:'x',type:'Fire',record:{id,type:'Fire',priority:'critical',status:'new',location:'x',lat:7.15,lng:0.47,civilianId:'CIV-10001',civilianName:'A',createdAt:new Date().toISOString(),source:'civilian-app'}});return{r,rf:SosOutbox.refusedList().map(x=>x.refused.why)}},existing);
 ok('a number that is already used is never silently swallowed',col.r==='refused'&&/already used|belongs to someone else/.test(col.rf.join()),col);
 await P.evaluate(()=>SosOutbox.refusedList().forEach(x=>SosOutbox.dismiss(x.id)));
 // paused in the browser
 await J('POST','/api/hq/pilot',hq,{paused:true,message:'Control room power failure'});await sleep(7000);
 sp=await strip();ok('when HQ pauses, the strip turns red with HQ\'s message and Call 112',sp&&/paused/i.test(sp.t)&&/power failure/.test(sp.t)&&/112/.test(sp.t)&&/rgb\(185, 28, 28\)/.test(sp.bg),sp);
 ok('the strip has a real call link',await P.evaluate(()=>!!document.querySelector('#pilot-strip a[href="tel:112"]')));
 await P.evaluate(()=>CivilianApp.triggerSOS());await sleep(600);
 ok('the send button shows a "paused" sheet, not the send screen',await P.evaluate(()=>/Alerts are paused/.test(document.body.innerText)&&!/SEND .* ALERT/.test(document.getElementById('sheet-content')?document.getElementById('sheet-content').innerText:'')));
 await P.evaluate(()=>CivilianApp.closeSheet());
 await J('POST','/api/hq/pilot',hq,{paused:false});await sleep(7000);
 sp=await strip();ok('after resume the strip is back to the normal notice',sp&&/being tested/.test(sp.t)&&!/paused/i.test(sp.t),sp);
 ok('no script errors (the test-removed PIN gate is ignored)',P.errs.filter(e=>!/showLogin/.test(e)).length===0,P.errs);
 // HQ screen
 const H=await (await br.newContext({viewport:{width:1366,height:850}})).newPage();H.errs=[];H.on('pageerror',e=>H.errs.push(e.message));H.on('dialog',d=>d.accept());await H.context().route(/cdnjs|unpkg|jsdelivr|tile|arcgis|fonts/,r=>r.abort());
 await H.goto(B+'/geams-hq-dashboard__1_.html');await sleep(2500);await H.fill('#hq-user','hqadmin');await H.fill('#hq-pass','Test-Owner-Pass-1');await H.click('#hq-login-btn');await sleep(4500);
 ok('HQ has the pause button',await H.evaluate(()=>/Pause \/ resume civilian alerts/.test(document.body.innerHTML)));
 await H.evaluate(()=>HqOps.pilotDialog());await sleep(500);await H.fill('#pz-msg','Network down at Hohoe');await H.evaluate(()=>HqOps.setPilot(true));await sleep(1500);
 st=(await J('GET','/api/kv/hq:pilot',civ)).j.value;ok('HQ screen pauses alerts and stores the message with 112',st&&st.paused&&/Network down/.test(st.message)&&/112/.test(st.message),st);
 await sleep(4500);ok('HQ sees a banner while paused',await H.evaluate(()=>/CIVILIAN ALERTS ARE PAUSED/.test(document.getElementById('hq-pilot-banner')?.textContent||'')));
 await H.evaluate(()=>HqOps.pilotDialog());await sleep(500);await H.evaluate(()=>HqOps.setPilot(false));await sleep(1500);
 st=(await J('GET','/api/kv/hq:pilot',civ)).j.value;ok('HQ screen resumes alerts',st&&st.paused===false,st);
 await sleep(4500);ok('banner is gone after resume',!(await H.evaluate(()=>!!document.getElementById('hq-pilot-banner'))));
 ok('no HQ script errors',H.errs.length===0,H.errs);
 await br.close();srv.kill();console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0)})().catch(e=>{console.log('ERR',e.stack);process.exit(2)});
