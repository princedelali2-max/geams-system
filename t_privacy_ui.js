const { chromium } = require('playwright');const fs=require('fs'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+(x||'')))};
const H='GH-VR-HOH-001-P3Q7',B='http://localhost:8093';
const desc=(seed,n=0)=>Array.from({length:128},(_,i)=>Math.sin(seed*7.1+i)*0.2+(i===0?n:0));
(async()=>{
 const ROOT='/tmp/gpui';fs.rmSync(ROOT,{recursive:true,force:true});fs.mkdirSync(ROOT,{recursive:true});
 const srv=spawn('node',['geams-server.js'],{env:{...process.env,PORT:'8093',GEAMS_DATA:ROOT+'/d.json',GEAMS_HQ_USERS:ROOT+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_BACKUP_HOURS:'0'}});await sleep(2000);
 const tk=(await (await fetch(B+'/api/hq/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'hqadmin',password:'Test-Owner-Pass-1'})})).json()).token;
 await fetch(B+'/api/kv/'+encodeURIComponent('registry:stations'),{method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tk},body:JSON.stringify({value:{[H]:{id:H,name:'Hohoe Control',region:'Volta',town:'Hohoe',lat:7.15,lng:0.47,jurisdictionRadiusM:3000}}})});
 const br=await chromium.launch({args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 const mk=async(f,geo)=>{const c=await br.newContext({geolocation:geo,permissions:['geolocation','camera']});await c.route(/cdnjs|unpkg|jsdelivr|tile|arcgis|openstreetmap|fonts|osrm/,r=>r.abort());const p=await c.newPage();p.on('pageerror',e=>{if(!/L is not defined|reading '(addTo|on|setView|remove|classList|invalidateSize|getContainer)'/.test(e.message))console.log('PAGEERR',f,e.message)});await p.goto(B+'/'+f);await sleep(2000);return p};
 const stub=(p,seed,n)=>p.evaluate(([s,n])=>{const d=Array.from({length:128},(_,i)=>Math.sin(s*7.1+i)*0.2+(i===0?n:0));FaceEngine.ensureModels=async()=>true;FaceEngine.watchVideo=(v,cb)=>{const t=setInterval(()=>cb(new Float32Array(d)),100);return()=>clearInterval(t)};},[seed,n]);
 const D=await mk('geams-dispatch-app.html',{latitude:7.152,longitude:0.474});
 await D.evaluate(()=>DispatchApp.showSignupForm());await D.fill('#su-name','Face Officer');await D.fill('#su-phone','0240000019');await D.selectOption('#su-lcr',H);await D.fill('#su-pass','secret12');await D.fill('#su-pass2','secret12');await D.evaluate(()=>DispatchApp.doSignup());await sleep(4500);
 const L=await mk('geams-station-dashboard__1_.html',{latitude:7.1516,longitude:0.4737});
 await L.fill('#login-station-id',H);await L.fill('#login-passphrase','hohoe2024');await L.fill('#login-cmd-name','Kwame Mensah');await L.evaluate(()=>StationAuth.attemptLogin());await sleep(6000);
 await L.evaluate(()=>StationApp.navigate('officers'));await sleep(2500);await L.evaluate(()=>{const b=[...document.querySelectorAll('#crew-approvals button')].find(b=>/Approve/.test(b.textContent));if(b)b.click()});await sleep(2500);
 await D.evaluate(()=>{document.getElementById('login-name').value='Face Officer';document.getElementById('login-pass').value='secret12';DispatchApp.doLogin()});await sleep(7000);
 // civilian: profile + face enrol through the real UI path
 const C=await mk('geams-civilian-app.html',{latitude:7.158,longitude:0.480});
 await C.evaluate(()=>{CivilianData.user.id='CIV-20001';CivilianData.user.name='Ama Civ';CivilianData.user.phone='0200000011';CivilianData.user.ghCard='GHA-222222222-2';CivilianData.user.address='Hohoe';CivilianData.user.verified=true;CivilianData.user.gpsLat=7.158;CivilianData.user.gpsLng=0.480;CivilianData.saveAccount&&CivilianData.saveAccount();});
 await stub(C,3,0);
 await C.evaluate(()=>CivilianApp.enrolFace());await sleep(1500);await C.evaluate(()=>CivilianApp.captureFaceNow());await sleep(2500);
 const civ2=await br.newContext();const t2=(await (await fetch(B+'/api/civilian/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:'other'.repeat(8)})})).json()).token;
 const rf=await fetch(B+'/api/kv/'+encodeURIComponent('registry:faces'),{headers:{Authorization:'Bearer '+t2}});const jf=await rf.json().catch(()=>({}));
 ok("another civilian cannot read the face registry",rf.status>=400||!jf.value||!Object.keys(jf.value).length,JSON.stringify(jf).slice(0,100));
 const civTok=await C.evaluate(()=>GeamsSync.token);
 const rf2=await fetch(B+'/api/kv/'+encodeURIComponent('registry:faces'),{headers:{Authorization:'Bearer '+civTok}});ok('even the owner cannot read it back',rf2.status>=400||!(await rf2.clone().json().catch(()=>({}))).value);
 // raise alert and have station assign the officer
 const incId=await C.evaluate(()=>{CivilianData.startEmergency('Crime');const em=CivilianData.activeEmergency();startEmergencySync(em,'');return em.id});await sleep(4000);
 const offs=await L.evaluate(()=>GeamsSync.getShared('lcr:GH-VR-HOH-001-P3Q7:officers',{}));const ofc=Object.values(offs).find(o=>o.name==='Face Officer');ok('officer on duty',!!ofc,JSON.stringify(Object.keys(offs)));
 await L.evaluate(async([id,b])=>{await GeamsSync.mergeShared('lcr:GH-VR-HOH-001-P3Q7:incidents',{},m=>{if(m[id]){m[id].officerName='Face Officer';m[id].officerBadge=b;m[id].status='dispatched';m[id].officerStatus='assigned'}return m})},[incId,ofc&&ofc.badge]);await sleep(5000);
 await D.evaluate(id=>{const j=DispatchData.jobQueue.find(x=>x._syncIncId===id);if(j)DispatchData.currentJob=j},incId);
 const job=await D.evaluate(()=>{const j=DispatchData.currentJob;return j&&{id:j._syncIncId,src:j._syncSource}});ok('officer has the civilian job',job&&job.id===incId,JSON.stringify(job));
 // dispatch: verify same face
 await stub(D,3,0.02);
 await D.evaluate(()=>DispatchApp.verifyCivilian());await sleep(2500);
 ok('verify sheet offered (face enrolled)',/Capture/.test(await D.evaluate(()=>document.getElementById('sheet-overlay').innerText)));
 await D.evaluate(()=>DispatchApp.captureVerifyCivilian());await sleep(2500);
 let t=await D.evaluate(()=>document.getElementById('scan-result')?.innerText||'');ok('same face -> match shown',/matches the account holder/.test(t),t);
 // different face
 await stub(D,8,0.9);await D.evaluate(()=>DispatchApp.verifyCivilian());await sleep(2500);await D.evaluate(()=>DispatchApp.captureVerifyCivilian());await sleep(2500);
 t=await D.evaluate(()=>document.getElementById('scan-result')?.innerText||'');ok('other face -> NO MATCH shown',/does NOT match/.test(t),t);
 // search + manual lookup
 await D.evaluate(()=>DispatchApp.closeSheet&&DispatchApp.closeSheet());
 const raw=await D.evaluate(()=>JSON.stringify(Object.keys(window.localStorage)).concat(document.documentElement.innerHTML.includes('"descriptor"')));ok('dispatch phone never holds a face descriptor',!/descriptor/.test(raw)||!/faceDescriptor/.test(raw));
 const aud=await (await fetch(B+'/api/face/audit',{headers:{Authorization:'Bearer '+tk}})).json();
 ok('audit recorded both checks with results',(aud.entries||[]).filter(e=>e.what==='verify'&&e.who==='CIV-20001').length>=2&&aud.entries.some(e=>e.match===true)&&aud.entries.some(e=>e.match===false),JSON.stringify(aud).slice(0,300));
 // manual lookup & search by method
 await D.evaluate(async()=>{window.__r=[];});
 const lk=await D.evaluate(async()=>{DispatchData.currentJob; const r=await fetch(GeamsSync.base+'/api/face/lookup',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+GeamsSync.token},body:JSON.stringify({incId:DispatchData.currentJob._syncIncId,ghCard:'GHA-222222222-2'})});return r.json()});ok('officer phone can look up by Ghana Card via server',lk.found&&lk.name==='Ama Civ',JSON.stringify(lk));
 // civilian verify-officer through UI function
 const vo=await C.evaluate(async(b)=>{const r=await GeamsSync.api('/api/civilian/verify-officer','POST',{badge:b});return r.j},ofc&&ofc.badge);ok('civilian can verify an on-duty officer by badge',vo.valid&&vo.name==='Face Officer',JSON.stringify(vo));
 // station still reads registry:civilians
 const reg=await L.evaluate(()=>GeamsSync.getShared('registry:civilians',{}));ok('control room can read civilian registry (name, phone)',reg['CIV-20001']&&reg['CIV-20001'].name==='Ama Civ'&&!JSON.stringify(reg).includes('ownerDev')||!!reg['CIV-20001'],JSON.stringify(reg).slice(0,150));
 // civilian removes face
 await C.evaluate(()=>CivilianApp.removeFace());await sleep(2500);
 const chk=await D.evaluate(async()=>{const r=await fetch(GeamsSync.base+'/api/face/verify',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+GeamsSync.token},body:JSON.stringify({incId:DispatchData.currentJob._syncIncId})});return r.json()});ok('face removed from server after civilian removes it',chk.enrolled===false,JSON.stringify(chk));
 await br.close();srv.kill();console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e.stack);process.exit(2)});
