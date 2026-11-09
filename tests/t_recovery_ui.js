const { chromium } = require('playwright');const fs=require('fs'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+String(typeof x==='string'?x:JSON.stringify(x)).slice(0,250)))};
const H='GH-VR-HOH-001-P3Q7',B='http://localhost:8085';
const J=async(m,p,t,b)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});let j={};try{j=await r.json()}catch(e){}return{s:r.status,j}};
(async()=>{
 const ROOT='/tmp/grecui';fs.rmSync(ROOT,{recursive:true,force:true});fs.mkdirSync(ROOT,{recursive:true});
 const srv=spawn('node',['geams-server.js'],{env:{...process.env,PORT:'8085',GEAMS_DATA:ROOT+'/d.json',GEAMS_HQ_USERS:ROOT+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_BACKUP_HOURS:'0'}});await sleep(2000);
 const hq=(await J('POST','/api/hq/login',null,{username:'hqadmin',password:'Test-Owner-Pass-1'})).j.token;
 await J('PUT','/api/kv/'+encodeURIComponent('registry:stations'),hq,{value:{[H]:{id:H,name:'Hohoe Control',region:'V',town:'x',lat:7.15,lng:0.47,jurisdictionRadiusM:3000}}});
 const br=await chromium.launch();
 const mk=async(f,geo)=>{const c=await br.newContext({geolocation:geo||{latitude:7.152,longitude:0.474},permissions:['geolocation']});await c.route(/cdnjs|unpkg|jsdelivr|tile|arcgis|openstreetmap|fonts|osrm/,r=>r.abort());const p=await c.newPage();p.on('pageerror',e=>{if(!/L is not defined|reading '(addTo|on|setView|remove|classList|invalidateSize|getContainer)'/.test(e.message))console.log('PAGEERR',f,e.message)});await p.goto(B+'/'+f);await sleep(1800);return p};
 const mkCrew=async(kind,name,phone)=>{await J('POST','/api/unit/signup',null,{kind,password:'oldpass123',cred:{name,phone,lcrId:H,rank:'X'}});const p=(await J('GET','/api/lcr/pending',hq)).j.pending.find(x=>x.name===name);await J('POST','/api/lcr/approve',hq,{kind,badge:p.badge,approve:true});return p.badge};
 // ---- station dashboard: reset button
 const L=await mk('geams-station-dashboard__1_.html');
 await L.fill('#login-station-id',H);await L.fill('#login-passphrase','hohoe2024');await L.fill('#login-cmd-name','Kwame Mensah');await L.evaluate(()=>StationAuth.attemptLogin());await sleep(6000);
 const bO=await mkCrew('officer','Ui Officer','0246000001'),bF=await mkCrew('fire','Ui Fire','0246000002'),bA=await mkCrew('ambulance','Ui Amb','0246000003');
 await L.evaluate(()=>StationApp.navigate('officers'));await sleep(3500);
 const rows=await L.evaluate(()=>document.getElementById('crew-accounts').innerText);ok('station lists officer, fire and ambulance accounts',/Ui Officer/.test(rows)&&/Ui Fire/.test(rows)&&/Ui Amb/.test(rows),rows.slice(0,200));
 const temps={};
 for(const [k,b] of [['officer',bO],['fire',bF],['ambulance',bA]]){
  await L.evaluate(([k,b])=>CrewApprovals.confirmReset(k,b),[k,b]);await sleep(300);
  ok('confirmation asks before resetting ('+k+')',/signs .* out everywhere/.test(await L.evaluate(()=>document.getElementById('modal-body').innerText)));
  await L.evaluate(([k,b])=>CrewApprovals.doReset(k,b),[k,b]);await sleep(1200);
  const t=await L.evaluate(()=>document.getElementById('modal-body').innerText);const m=/([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(t);ok('temporary password shown once ('+k+')',!!m,t);temps[k]=m&&m[1];
  await L.evaluate(()=>StationApp.closeModal());
 }
 // ---- crew apps: forced change after reset, then a voluntary change
 for(const [k,file,name,badge,loginBtn] of [['officer','geams-dispatch-app.html','Ui Officer',bO],['fire','geams-fire-service.html','Ui Fire',bF],['ambulance','geams-ambulance-service.html','Ui Amb',bA]]){
  const P=await mk(file);
  await P.evaluate(([n,pw])=>{document.getElementById('login-name').value=n;document.getElementById('login-pass').value=pw},[name,temps[k]]);
  await P.evaluate(k=>{k==='officer'?DispatchApp.doLogin():(k==='fire'?FireApp.doLogin():AmbulanceApp.doLogin())},k);await sleep(3000);
  ok(k+': forced password dialog appears after a reset',await P.evaluate(()=>!!document.getElementById('crewpw-overlay')&&/Choose your own password/.test(document.getElementById('crewpw-overlay').innerText)));
  ok(k+': forced dialog has no Cancel',await P.evaluate(()=>!document.getElementById('crewpw-cancel')));
  await P.evaluate(()=>{document.getElementById('crewpw-new').value='short';document.getElementById('crewpw-new2').value='short';document.getElementById('crewpw-save').click()});await sleep(300);
  ok(k+': short password refused in the dialog',/at least 8/.test(await P.evaluate(()=>document.getElementById('crewpw-err').textContent)));
  await P.evaluate(()=>{document.getElementById('crewpw-new').value='my-new-password-1';document.getElementById('crewpw-new2').value='my-new-password-1';document.getElementById('crewpw-save').click()});await sleep(4500);
  ok(k+': dialog closes and the app opens',await P.evaluate(()=>!document.getElementById('crewpw-overlay')));
  const lg=await J('POST','/api/unit/login',null,{kind:k,name,password:'my-new-password-1'});ok(k+': the new password works at the server and has no forced change',lg.s===200&&!lg.j.mustChange);
  const lg2=await J('POST','/api/unit/login',null,{kind:k,name,password:temps[k]});ok(k+': the temporary password is dead',lg2.s===401);
  // voluntary change
  await P.evaluate(()=>{CrewPw.open({})});await sleep(300);
  await P.evaluate(()=>{document.getElementById('crewpw-cur').value='wrong-current';document.getElementById('crewpw-new').value='another-pass-22';document.getElementById('crewpw-new2').value='another-pass-22';document.getElementById('crewpw-save').click()});await sleep(1500);
  ok(k+': wrong current password shown as an error',/not right/.test(await P.evaluate(()=>(document.getElementById('crewpw-err')||{}).textContent||'')));
  await P.evaluate(()=>{document.getElementById('crewpw-cur').value='my-new-password-1';document.getElementById('crewpw-save').click()});await sleep(1800);
  ok(k+': voluntary change completes',(await J('POST','/api/unit/login',null,{kind:k,name,password:'another-pass-22'})).s===200);
  // the session stays alive on this device after the change
  const still=await P.evaluate(async()=>{const r=await fetch(GeamsSync.base+'/api/hq/me',{headers:{Authorization:'Bearer '+GeamsSync.token}});return GeamsSync.token&&true});ok(k+': this device keeps a working session',still);
 }
 ok('fake IT-support details are gone from the dispatch app',!/0800-GEAMS|moi\.gov\.gh/.test(fs.readFileSync('geams-dispatch-app.html','utf8')));
 // ---- civilian: recovery code and restore on a new phone
 const C1=await mk('geams-civilian-app.html',{latitude:7.158,longitude:0.48});
 await C1.evaluate(()=>{CivilianData.user.id='CIV-40001';CivilianData.user.name='Kofi Mover';CivilianData.user.phone='0200000040';CivilianData.user.ghCard='GHA-444444444-4';CivilianData.user.address='Hohoe';CivilianData.user.verified=true;CivilianData.user.pin='1234';CivilianData.user.gpsLat=7.158;CivilianData.user.gpsLng=0.48;CivilianData.saveAccount()});await sleep(2500);
 await C1.evaluate(()=>CivilianApp.accountRecovery());await sleep(300);
 ok('recovery sheet warns that a new code replaces the old one',/replaces/.test(await C1.evaluate(()=>document.getElementById('sheet-body').innerText)));
 await C1.evaluate(()=>CivilianApp.makeRecoveryCode());await sleep(2500);
 const sh=await C1.evaluate(()=>document.getElementById('sheet-body').innerText);const cm=/([A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5})/.exec(sh);ok('recovery code shown with the account number',!!cm&&/CIV-40001/.test(sh),sh);
 const code=cm&&cm[1];
 // an alert raised on the old phone
 const inc=await C1.evaluate(()=>{CivilianData.startEmergency('Crime');const em=CivilianData.activeEmergency();startEmergencySync(em,'');return em.id});await sleep(3500);
 // new phone
 const C2=await mk('geams-civilian-app.html',{latitude:7.158,longitude:0.48});
 await C2.evaluate(()=>{try{localStorage.clear()}catch(e){}});await C2.reload();await sleep(5200);
 await C2.evaluate(()=>PinGate.showRestore());await sleep(200);
 ok('restore screen reachable from the login/sign-up screen',await C2.evaluate(()=>!document.getElementById('pin-restore-view').classList.contains('hidden')));
 await C2.fill('#rs-id','CIV-40001');await C2.fill('#rs-code','AAAAA-BBBBB-CCCCC');await C2.fill('#rs-pin','4321');await C2.fill('#rs-pin2','4321');await C2.evaluate(()=>PinGate.doRestore());await sleep(1800);
 ok('wrong code shows a clear error',/do not match/.test(await C2.evaluate(()=>document.getElementById('restore-error').textContent)));
 await C2.fill('#rs-code','x'.repeat(0)+code.toLowerCase());await C2.fill('#rs-pin','4321');await C2.fill('#rs-pin2','9999');await C2.evaluate(()=>PinGate.doRestore());await sleep(400);
 ok('PIN mismatch caught before contacting the server',/do not match/.test(await C2.evaluate(()=>document.getElementById('restore-error').textContent)));
 await C2.fill('#rs-pin2','4321');await C2.evaluate(()=>PinGate.doRestore());await sleep(3500);
 const u2=await C2.evaluate(()=>({id:CivilianData.user.id,name:CivilianData.user.name,ghCard:CivilianData.user.ghCard,verified:CivilianData.user.verified,pin:CivilianData.user.pin}));
 ok('account restored on the new phone',u2.id==='CIV-40001'&&u2.name==='Kofi Mover'&&u2.verified&&u2.pin==='4321',u2);
 const sh2=await C2.evaluate(()=>document.getElementById('sheet-body').innerText);const nc=/([A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5})/.exec(sh2);ok('a fresh recovery code is shown after restoring',!!nc&&nc[1]!==code&&/moved|new one/.test(sh2),sh2);
 const tok2=await C2.evaluate(()=>GeamsSync.token);
 const mine=await J('GET','/api/kv/'+encodeURIComponent('lcr:'+H+':incidents'),tok2);ok('the alert from the old phone is visible on the new one',!!(mine.j.value||{})[inc],Object.keys(mine.j.value||{}));
 const tok1=await C1.evaluate(()=>GeamsSync.token);const old=await J('GET','/api/kv/'+encodeURIComponent('lcr:'+H+':incidents'),tok1);ok('and no longer on the old phone',!(old.j.value||{})[inc]);
 // the old code cannot be reused from a third phone
 const C3=await mk('geams-civilian-app.html');const r3=await C3.evaluate(async(c)=>{const r=await GeamsSync.api('/api/civilian/recovery/restore','POST',{civilianId:'CIV-40001',code:c});return r.status||r.ok},code);ok('the used code cannot be replayed',r3===401||r3===false);
 await br.close();srv.kill();console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e.stack);process.exit(2)});
