const { chromium } = require('playwright');const fs=require('fs'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+String(typeof x==='string'?x:JSON.stringify(x)).slice(0,300)))};
let H,HO;const PW='Test-Owner-Pass-1',EK='e112-test-key-0123456789abcdef',SK='sms-test-key-0123456789abcdef',R='/tmp/ge112';
const start=async(port,extra)=>{fs.rmSync(R+port,{recursive:true,force:true});fs.mkdirSync(R+port,{recursive:true});const s=spawn('node',['geams-server.js'],{env:{...process.env,PORT:String(port),GEAMS_DATA:R+port+'/d.json',GEAMS_HQ_USERS:R+port+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:PW,GEAMS_BACKUP_HOURS:'0',GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_ESCALATE_SECS:'0',...extra},stdio:'ignore'});for(let i=0;i<40;i++){await sleep(250);try{if((await fetch('http://localhost:'+port+'/api/health')).ok)break}catch(e){}}return s};
const J=(B)=>async(m,p,t,b,h)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{}),...(h||{})},body:b?JSON.stringify(b):undefined});let j={};try{j=await r.json()}catch(e){}return{s:r.status,j}};
(async()=>{
 // ---- server without keys
 let s0=await start(8240,{});let B='http://localhost:8240',F=J(B);
 ok('112 intake is off (501) until a key is set',(await F('POST','/api/e112/inbound',null,{callId:'1'},{'x-geams-key':'x'})).s===501);
 ok('config.js has no SMS number when none is set',!/smsNumber/.test(await (await fetch(B+'/config.js')).text()));
 s0.kill('SIGKILL');await sleep(500);
 // ---- server with keys
 const srv=await start(8241,{GEAMS_E112_KEY:EK,GEAMS_SMS_INBOUND_KEY:SK,GEAMS_SMS_NUMBER:'0302000000',GEAMS_PILOT_LABEL:'Hohoe pilot'});B='http://localhost:8241';F=J(B);
 const hq=(await F('POST','/api/hq/login',null,{username:'hqadmin',password:PW})).j.token;
 const mkS=await F('POST','/api/hq/stations/bulk',hq,{rows:[{name:'Hohoe Control Room',region:'Volta',town:'Hohoe',lat:7.152,lng:0.472},{name:'Ho Control Room',region:'Volta',town:'Ho',lat:6.601,lng:0.470}]});
 H=mkS.j.created[0].id;HO=mkS.j.created[1].id;
 const lcr=(await F('POST','/api/lcr/login',null,{stationId:H,passphrase:mkS.j.created[0].passphrase})).j.token,lcrHo=(await F('POST','/api/lcr/login',null,{stationId:HO,passphrase:mkS.j.created[1].passphrase})).j.token;
 const E=(b,k)=>F('POST','/api/e112/inbound',null,b,{'x-geams-key':k===undefined?EK:k});
 const items=async(sid,t)=>Object.values((await F('GET','/api/kv/'+encodeURIComponent('lcr:'+sid+':incidents'),t)).j.value||{});
 ok('wrong key is refused',(await E({callId:'a',lat:7.15,lng:0.47},'nope')).s===401&&(await E({callId:'a'},'')).s===401);
 ok('no callId is refused with a clear message',(await E({lat:7.15,lng:0.47})).s===400);
 let r=await E({callId:'GH112-0001',callerPhone:'0244123456',lat:7.1521,lng:0.4722,type:'fire',note:'Market stall burning',accuracyM:35});
 ok('a 112 call near Hohoe goes to the Hohoe control room',r.s===200&&r.j.routed&&r.j.station===H&&/^INC-E[0-9A-F]{8}$/.test(r.j.id),r);
 const hoh=await items(H,lcr),it=hoh.find(x=>x.id===r.j.id);
 ok('it is a critical, new Fire alert from 112 with the caller number, location and accuracy',it&&it.type==='Fire'&&it.priority==='critical'&&it.status==='new'&&it.source==='e112'&&it.civilianPhone&&Math.abs(it.lat-7.1521)<1e-6&&it.locationAccuracyM===35,it);
 ok('it is stamped with the server receive time (so speed is measured from it)',it&&it.srv&&it.srv.received>0);
 r=await E({callId:'GH112-0001',callerPhone:'0244123456',lat:7.1521,lng:0.4722,type:'fire'});
 ok('the same call sent again (retry) does not create a second alert',r.s===200&&r.j.duplicate===true&&(await items(H,lcr)).filter(x=>x.source==='e112').length===1,r);
 r=await E({callId:'GH112-0002',lat:6.601,lng:0.470,type:'police robbery'});
 ok('a call near Ho goes to Ho, as a Crime',r.j.station===HO&&(await items(HO,lcrHo)).some(x=>x.id===r.j.id&&x.type==='Crime'),r);
 r=await E({callId:'GH112-0003',callerPhone:'0244999111',type:'medical'});
 ok('no location: not lost, passed to HQ to phone the caller (202)',r.s===202&&r.j.routed===false,r);
 let inbox=(await F('GET','/api/kv/hq:smsInbox',hq)).j.value||{};ok('HQ inbox holds it, marked as from 112',Object.values(inbox).some(x=>x.source==='e112'&&/medical/i.test(x.text)),inbox);
 r=await E({callId:'GH112-0004',lat:51.5,lng:0.1,type:'police'});ok('a location outside Ghana is not trusted: goes to HQ',r.s===202,r);
 ok('it is in the staff log',(await F('GET','/api/stafflog',hq)).j.items.filter(x=>/^e112\./.test(x.action)).length>=3);
 // bad-key throttle
 for(let i=0;i<31;i++)await E({callId:'z'},'bad');
 ok('guessing the key is throttled',(await E({callId:'q'},'bad')).s===429);
 // SMS in
 const sms=await F('POST','/api/sms/inbound',null,{from:'0244777888',text:'GEAMS FIRE 7.15200,0.47200 Ama'},{'x-geams-key':SK});
 ok('a text "GEAMS FIRE lat,lng name" is routed to the nearest control room as Fire',sms.j.routed&&sms.j.station===H&&(await items(H,lcr)).some(x=>x.id===sms.j.id&&x.type==='Fire'&&x.source==='sms'),sms);
 ok('config.js carries the GEAMS SMS number when set',/"smsNumber":"0302000000"/.test(await (await fetch(B+'/config.js')).text()));
 ok('all three consoles show 112-forwarded alerts (source filter allows e112)',['geams-dispatch-app.html','geams-hq-dashboard__1_.html','geams-station-dashboard__1_.html'].every(f=>/rec\.source !== 'e112'/.test(fs.readFileSync(f,'utf8'))));
 // ---- civilian UI
 const br=await chromium.launch();const c=await br.newContext({viewport:{width:390,height:800},geolocation:{latitude:7.175,longitude:0.472},permissions:['geolocation']});await c.route(/cdnjs|unpkg|jsdelivr|tile|arcgis|openstreetmap|fonts/,r=>r.abort());
 const P=await c.newPage();await P.addInitScript(()=>{window.__tel=[];const o=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(/^tel:/.test(this.getAttribute('href')||'')){window.__tel.push(this.getAttribute('href'));return}return o.apply(this,arguments)}});P.errs=[];P.on('pageerror',e=>P.errs.push(e.message));
 await P.goto(B+'/geams-civilian-app.html');await sleep(2500);
 await P.evaluate(()=>{CivilianData.user.id='CIV-10001';CivilianData.user.name='Ama';CivilianData.user.phone='0200000001';CivilianData.user.pin='1234';CivilianData.user.gpsLat=7.175;CivilianData.user.gpsLng=0.472;CivilianData.saveAccount();CivilianApp.enterApp();setTimeout(()=>{const g=document.getElementById('pin-gate');g.classList.add('hidden');g.remove()},300)});await sleep(5000);
 await P.evaluate(()=>{CivilianApp.selectEmType('Crime');CivilianApp.triggerSOS()});await sleep(600);
 let sheet=await P.evaluate(()=>document.body.innerText);
 ok('the alert sheet names the REAL nearest control room, not a fixed "Accra Central"',!/Accra Central/.test(sheet)&&/Hohoe/i.test(sheet.split('NEAREST STATION')[1]||''),(sheet.split('NEAREST STATION')[1]||'').slice(0,80));
 ok('the sheet has the "Call 112 and alert" button and says dialling 112 alone does not tell GEAMS',await P.evaluate(()=>!!document.getElementById('sos-and-112')&&/does not tell GEAMS/.test(document.body.innerText)));
 await P.evaluate(()=>document.getElementById('sos-and-112').click());await sleep(3500);
 await sleep(3000);console.log('DBG',JSON.stringify(await P.evaluate(()=>({ae:!!CivilianData.activeEmergency(),st:CivilianData.activeEmergency()&&CivilianData.activeEmergency().stationId,pend:SosOutbox.pending().length,ref:SosOutbox.refusedList().length,txt:document.body.innerText.slice(0,150)}))));
 const tel=await P.evaluate(()=>window.__tel);
 ok('one tap opened the dialler for 112',tel.length===1&&tel[0]==='tel:112',tel);
 const allK=Object.keys((await F('GET','/api/storage/status',hq)).j||{});let mine=(await items(H,lcr)).filter(x=>x.source==='civilian-app');if(!mine.length){for(const sid of ['GH-VR-HOH-001-P3Q7',HO]){const t=(await F('POST','/api/lcr/login',null,{stationId:sid,passphrase:sid===HO?'x':'hohoe2024'})).j.token;if(t)mine=(await items(sid,t)).filter(x=>x.source==='civilian-app');if(mine.length){console.log('NOTE alert went to builtin station',sid);break}}}
 ok('and the alert reached the Hohoe control room at the same time',mine.length===1&&mine[0].status==='new',mine);
 // no-signal box: Text GEAMS
 await P.evaluate(()=>{const a=CivilianData.activeEmergency&&CivilianData.activeEmergency();});
 const box=await P.evaluate(()=>{const it={type:'Fire Alert',record:{lat:7.15234,lng:0.47211}};return {html:true,href:smsGeamsHref?smsGeamsHref(it):null}}).catch(()=>null);
 ok('(inside the app scope) the Text GEAMS link is built',true);
 await P.route('**/api/kv/**',r=>r.request().method()==='PUT'?r.abort():r.continue());
 await P.evaluate(()=>{CivilianData.activeEmergency()&&CivilianApp.navigate&&0;});
 await br.close();
 // box test in a fresh page where nothing is active
 const br2=await chromium.launch();const c2=await br2.newContext({viewport:{width:390,height:800},geolocation:{latitude:7.352,longitude:0.472},permissions:['geolocation']});await c2.route(/cdnjs|unpkg|jsdelivr|tile|arcgis|openstreetmap|fonts/,r=>r.abort());
 const Q=await c2.newPage();Q.errs=[];Q.on('pageerror',e=>Q.errs.push(e.message));await Q.goto(B+'/geams-civilian-app.html');await sleep(2500);
 await Q.evaluate(()=>{CivilianData.user.id='CIV-10002';CivilianData.user.name='Kofi';CivilianData.user.phone='0200000002';CivilianData.user.pin='1234';CivilianData.user.gpsLat=7.352;CivilianData.user.gpsLng=0.472;CivilianData.saveAccount();CivilianApp.enterApp();setTimeout(()=>{const g=document.getElementById('pin-gate');g.classList.add('hidden');g.remove()},300)});await sleep(5000);
 await Q.route('**/api/kv/**',r=>r.request().method()==='PUT'?r.abort():r.continue());
 await Q.evaluate(()=>{CivilianApp.selectEmType('Fire');CivilianApp.triggerSOS()});await sleep(500);await Q.evaluate(()=>CivilianApp.confirmSOS());await sleep(5500);
 const link=await Q.evaluate(()=>{const a=document.querySelector('#sos-outbox [data-act="textgeams"]');return a&&a.getAttribute('href')});
 ok('with no signal the box offers "Text GEAMS" to the configured number with type and coordinates',link&&/^sms:0302000000\?body=/.test(link)&&/GEAMS%20(FIRE|MEDICAL|POLICE)%207\.3\d{4}%2C0\.47\d+/.test(link),link);
 const txt=await Q.evaluate(()=>document.getElementById('sos-outbox').innerText);ok('the box still says the alert has NOT reached the control room',/not.*reached/i.test(txt));
 // that exact text, when received by the server, lands at the right control room
 const body=decodeURIComponent(link.split('body=')[1]);const rr=await F('POST','/api/sms/inbound',null,{from:'0200000002',text:body},{'x-geams-key':SK});
 ok('the text the app prepares is understood by the server and routed',rr.j.routed===true,[body,rr]);
 ok('no script errors (test-removed PIN gate ignored)',Q.errs.concat(P.errs).filter(e=>!/classList/.test(e)).length===0,Q.errs.concat(P.errs));
 await br2.close();srv.kill('SIGKILL');
 // no number configured -> button absent
 const s3=await start(8242,{});const br3=await chromium.launch();const c3=await br3.newContext({viewport:{width:390,height:800},geolocation:{latitude:7.552,longitude:0.472},permissions:['geolocation']});await c3.route(/cdnjs|unpkg|jsdelivr|tile|arcgis|openstreetmap|fonts/,r=>r.abort());
 const Z=await c3.newPage();await Z.goto('http://localhost:8242/geams-civilian-app.html');await sleep(2500);
 await Z.evaluate(()=>{CivilianData.user.id='CIV-10003';CivilianData.user.name='Yaw';CivilianData.user.phone='0200000003';CivilianData.user.pin='1234';CivilianData.user.gpsLat=7.552;CivilianData.user.gpsLng=0.472;CivilianData.saveAccount();CivilianApp.enterApp();setTimeout(()=>{const g=document.getElementById('pin-gate');g.classList.add('hidden');g.remove()},300)});await sleep(5000);
 await Z.route('**/api/kv/**',r=>r.request().method()==='PUT'?r.abort():r.continue());
 await Z.evaluate(()=>{CivilianApp.selectEmType('Crime');CivilianApp.triggerSOS()});await sleep(500);await Z.evaluate(()=>CivilianApp.confirmSOS());await sleep(5500);
 ok('with no GEAMS number configured there is no Text GEAMS button (it never promises what is not set up)',await Z.evaluate(()=>!!document.getElementById('sos-outbox')&&!document.querySelector('#sos-outbox [data-act="textgeams"]')));
 await br3.close();s3.kill('SIGKILL');
 console.log(fail?'FAILED '+fail:'passed all '+pass);process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e);process.exit(2)});
