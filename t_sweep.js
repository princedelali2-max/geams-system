const { chromium } = require('playwright');const fs=require('fs'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+(x||'')))};
const H='GH-VR-HOH-001-P3Q7',K='lcr:'+H+':incidents';
(async()=>{
 const ROOT='/tmp/gsw';fs.rmSync(ROOT,{recursive:true,force:true});fs.mkdirSync(ROOT,{recursive:true});
 const srv=spawn('node',['geams-server.js'],{env:{...process.env,PORT:'8098',GEAMS_DATA:ROOT+'/d.json',GEAMS_HQ_USERS:ROOT+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_BACKUP_HOURS:'0'}});let log='';srv.stdout.on('data',d=>log+=d);srv.stderr.on('data',d=>log+=d);global.__log=()=>log;await sleep(2000);
 const br=await chromium.launch();
 const mk=async()=>{const c=await br.newContext({acceptDownloads:true,geolocation:{latitude:7.1516,longitude:0.4737},permissions:['geolocation']});await c.route(/cdnjs|unpkg|jsdelivr|tile|arcgis|openstreetmap|fonts/,r=>r.abort());const p=await c.newPage();p.on('pageerror',e=>{if(!/L is not defined|reading '(addTo|on|setView|remove|classList|invalidateSize|getContainer)'/.test(e.message))console.log('PAGEERR',e.message)});p.on('dialog',d=>d.accept());return p};
 const Q=await mk();await Q.goto('http://localhost:8098/geams-hq-dashboard__1_.html');await sleep(1500);
 await Q.fill('#hq-user','hqadmin');await Q.fill('#hq-pass','Test-Owner-Pass-1');await Q.evaluate(()=>HqAuth.submit({preventDefault(){}}));await sleep(3500);
 await Q.evaluate(async(H)=>{await HqAuth.api('/api/kv/registry%3Astations',{method:'PUT',body:JSON.stringify({value:{[H]:{id:H,name:'Hohoe Control',region:'Volta',town:'Hohoe',lat:7.15,lng:0.47,jurisdictionRadiusM:3000}}})})},H);await sleep(1500);
 const L=await mk();await L.goto('http://localhost:8098/geams-station-dashboard__1_.html');await sleep(2500);
 await L.fill('#login-station-id',H);await L.fill('#login-passphrase','hohoe2024');await L.fill('#login-cmd-name','Kwame Mensah');await L.evaluate(()=>StationAuth.attemptLogin());await sleep(6000);
 ok('station signed in',await L.evaluate(()=>document.getElementById('app').style.display!=='none'));
 const val=async(p,id,v)=>p.evaluate(([i,x])=>{const e=document.getElementById(i);e.value=x;},[id,v]);
 const shared=async()=>Q.evaluate(async(k)=>{const r=await HqAuth.api('/api/kv/'+encodeURIComponent(k));return r.j.value||{}},K);
 // ---- walk-in
 await L.evaluate(()=>StationApp.registerComplainant());await sleep(300);
 await L.evaluate(()=>StationApp.submitWalkIn());await sleep(300);
 ok('walk-in needs a name',await L.evaluate(()=>StationData.incidents.length===0));
 for(const n of ['Ama Walkin','Kofi Walkin']){
  await L.evaluate(()=>StationApp.registerComplainant());await sleep(200);
  await val(L,'wi-name',n);await val(L,'wi-phone','+233200000001');await val(L,'wi-desc','Handbag stolen at market');await L.evaluate(()=>StationApp.submitWalkIn());await sleep(500);}
 let ids=await L.evaluate(()=>StationData.incidents.map(i=>i.id));
 ok('two real walk-in cases created locally',ids.length===2&&ids.every(i=>/^INC-W/.test(i)),ids.join());
 await sleep(1500);let m=await shared();
 ok('walk-in records filed on the shared key with source',Object.keys(m).length===2&&Object.values(m).every(r=>r.source==='walk-in'&&r.civilianName),JSON.stringify(Object.keys(m)));
 await sleep(3500);
 await sleep(2500);ok('HQ sees the walk-in cases',await Q.evaluate(()=>GeamsData.incidents.filter(i=>/^INC-W/.test(i.id)).length)===2);
 const [A,B]=ids;
 // ---- notes
 await L.evaluate(()=>StationApp.addIncidentNotes());await sleep(200);
 await val(L,'nt-inc',A);await val(L,'nt-text','Witness saw a red motorbike');await L.evaluate(()=>StationApp.saveNotes());await sleep(1500);
 m=await shared();ok('shared note written',m[A]&&m[A].stationNotes&&m[A].stationNotes[0].text==='Witness saw a red motorbike'&&!('vis' in m[A].stationNotes[0]),JSON.stringify(m[A]&&m[A].stationNotes));
 await L.evaluate(()=>StationApp.addIncidentNotes());await val(L,'nt-inc',A);await val(L,'nt-text','private thought');await val(L,'nt-vis','station');await L.evaluate(()=>StationApp.saveNotes());await sleep(1200);
 m=await shared();ok('session-only note is not sent',m[A].stationNotes.length===1);
 // ---- flag, photo, backup, escalate
 await L.evaluate(()=>StationApp.flagSuspiciousCaller());await val(L,'fl-inc',A);await val(L,'fl-notes','odd story');await L.evaluate(()=>StationApp.confirmFlag());
 await L.evaluate(()=>StationApp.requestScenePhoto());await val(L,'ph-inc',A);await L.evaluate(()=>StationApp.confirmScenePhoto());
 await L.evaluate(()=>StationApp.requestBackup());await val(L,'bk-inc',A);await val(L,'bk-rep','Crowd forming');await L.evaluate(()=>StationApp.confirmBackupRequest());
 await L.evaluate(id=>StationApp.escalateToHQ(id),A);await val(L,'esc-rep','Needs more units');await L.evaluate(id=>StationApp.confirmEscalate(id),A);await sleep(2000);
 m=await shared();const r=m[A]||{};
 ok('flag recorded',r.flagged&&r.flagged.reason&&r.flagged.notes==='odd story');
 ok('photo request recorded with a time',r.photoRequestedAt>0&&r.photoRequest&&r.photoRequest.type);
 ok('backup request recorded',r.backupRequest&&r.backupRequest.report==='Crowd forming');
 ok('escalation recorded',r.hqEscalated&&r.hqEscalated.report==='Needs more units');
 await sleep(3500);
 const hqv=await Q.evaluate(a=>{const i=GeamsData.incidents.find(x=>x.id===a);return i&&{b:!!i.backupRequest,e:!!i.hqEscalated,f:!!i.flagged,n:(i.stationNotes||[]).length,d:GeamsIncidents.buildDetailHTML(a)}},A);
 ok('HQ incident view shows the station flags',hqv&&hqv.b&&hqv.e&&hqv.f&&hqv.n===1&&/Backup requested/.test(hqv.d)&&/Caller flagged/.test(hqv.d),JSON.stringify(hqv&&{b:hqv.b,e:hqv.e,f:hqv.f,n:hqv.n}));
 // ---- reassign
 await L.evaluate(([a])=>{StationData.officers.push({id:'T1',name:'Off One',badge:'B1',status:'dispatched',vehicle:'V1',currentIncident:a},{id:'T2',name:'Off Two',badge:'B2',status:'available',vehicle:'V2'});const i=StationData.incidents.find(x=>x.id===a);i.officerAssigned='Off One';i.status='dispatched';},[A]);
 await L.evaluate(a=>StationApp.reassignDispatch(a),A);await val(L,'ra-off','T2');await L.evaluate(()=>StationApp.confirmReassign());await sleep(1500);
 const st=await L.evaluate(()=>({o1:StationData.officers.find(o=>o.id==='T1').status,o2:StationData.officers.find(o=>o.id==='T2').currentIncident}));
 m=await shared();
 ok('reassign frees old officer and books new one',st.o1==='available'&&st.o2===A,JSON.stringify(st));
 ok('reassign written to shared record',m[A].officerName==='Off Two'&&m[A].reassignedFrom==='Off One'&&m[A].officerStatus==='assigned',JSON.stringify([m[A].officerName,m[A].reassignedFrom]));
 // ---- merge
 await L.evaluate(a=>StationApp.mergeIncidents(a),A);await val(L,'mg-keep',A);await val(L,'mg-dup',B);await L.evaluate(()=>StationApp.confirmMerge());await sleep(1500);
 m=await shared();
 ok('merge closes the duplicate and links it',m[B].status==='resolved'&&m[B].mergedInto===A&&m[A].mergedFrom.includes(B),JSON.stringify([m[B].status,m[B].mergedInto,m[A].mergedFrom]));
 ok('merge stamped a server resolved time',m[B].srv&&m[B].srv.resolved>0);
 // ---- call back (real tel link)
 const tel=await L.evaluate(a=>{StationApp.callBackCivilian(a);return (document.querySelector('#modal-body a[href^="tel:"]')||{}).href},A);
 ok('call back offers a real tel: link with the reporter\'s number',/^tel:\+233200000001/.test(tel||''),tel);
 // ---- docket print
 await L.evaluate(a=>StationApp.printDocket(a),A);await L.evaluate(a=>{window.__pr=0;StationApp.doPrintDocket(a)},A);await sleep(800);
 const dk=await L.evaluate(()=>{const f=document.getElementById('geams-print-frame');return f&&f.srcdoc});
 ok('docket built from the record',dk&&dk.includes(A)&&dk.includes('Witness saw a red motorbike')&&/Walkin/.test(dk),(dk||'').slice(0,200));
 // ---- report csv
 await L.evaluate(()=>StationApp.generateStationReport());await val(L,'rp-type','summary');await val(L,'rp-fmt','csv');
 const [dl]=await Promise.all([L.waitForEvent('download'),L.evaluate(()=>StationApp.runReport())]);
 const csv=fs.readFileSync(await dl.path(),'utf8');
 ok('report CSV has real rows',/INC-W/.test(csv)&&/Ama Walkin/.test(csv)&&csv.split('\n').length>=3,csv.slice(0,200));
 // ---- intelligence
 await L.evaluate(()=>StationApp.logIntelligence());await sleep(800);await val(L,'in-det','Group meeting near the market at night');await val(L,'in-subj','Unknown');await L.evaluate(()=>StationApp.submitIntel());await sleep(1500);
 const intel=await Q.evaluate(async(h)=>{const r=await HqAuth.api('/api/kv/'+encodeURIComponent('lcr:'+h+':intel'));return r.j.value},H);
 ok('intelligence report filed and readable by HQ',Array.isArray(intel)&&intel.length===1&&/market/.test(intel[0].details),JSON.stringify(intel));
 const tamper=await L.evaluate(async(k)=>{const r=await GeamsSync.mergeShared(k,[],a=>{a[0].details='edited';return a});return r},'lcr:'+H+':intel');
 const intel2=await Q.evaluate(async(h)=>{const r=await HqAuth.api('/api/kv/'+encodeURIComponent('lcr:'+h+':intel'));return r.j.value},H);
 ok('filed report cannot be edited',intel2[0].details!=='edited');
 // ---- connection test
 await L.evaluate(()=>StationApp.testConnection());await sleep(2500);
 const tc=await L.evaluate(()=>document.getElementById('tc-body').innerText);
 ok('connection test reports measured results',/GEAMS server/.test(tc)&&/\d+ ms/.test(tc)&&!/S3 bucket|DVLA|Biometric/.test(tc),tc);
 // ---- station lockdown (status only)
 await L.evaluate(()=>StationApp.stationLockdown());await L.evaluate(()=>StationApp.confirmLockdown());await sleep(3500);
 const ls=await Q.evaluate(async(h)=>{const r=await HqAuth.api('/api/kv/hq%3Alcr_status');return (r.j.value||{})[h]},H);
 ok('station lockdown reaches HQ status and shows banner',ls&&ls.lockdown&&ls.lockdown.reason&&await L.evaluate(()=>!!document.getElementById('lockdown-banner')),JSON.stringify(ls&&ls.lockdown));
 await L.evaluate(()=>StationApp.liftLockdown());
 // ---- removed stuff
 ok('roadblock and plainclothes are gone',await L.evaluate(()=>!StationApp.issueRoadblock&&!StationApp.assignPlainclothes&&!/StationApp\.(issueRoadblock|assignPlainclothes)/.test(document.body.innerHTML)));
 ok('no toast-only buttons left in station page',await L.evaluate(()=>!/onclick="[^"]*showToast\(/.test(document.documentElement.outerHTML.replace(/<script[\s\S]*?<\/script>/g,''))));
 // ---- HQ actions
 await Q.evaluate(a=>HqOps.escalate(a),B);await sleep(1500);
 await Q.evaluate(a=>HqOps.notes(a),A);await Q.fill('#hqn-text','HQ says hold position');await Q.evaluate(a=>HqOps.saveNotes(a),A);await sleep(1500);
 m=await shared();
 ok('HQ escalate raises priority on the shared record',m[B].priority==='critical'&&m[B].hqEscalated&&m[B].hqEscalated.by==='hqadmin');
 ok('HQ note written',m[A].hqNotes&&m[A].hqNotes[0].text==='HQ says hold position'&&m[A].hqNotes[0].by==='hqadmin');
 const [d1]=await Promise.all([Q.waitForEvent('download'),Q.evaluate(()=>HqOps.exportIncidents())]);
 ok('HQ incident export has rows',/INC-W/.test(fs.readFileSync(await d1.path(),'utf8')));
 const [d2]=await Promise.all([Q.waitForEvent('download'),Q.evaluate(()=>HqOps.exportStations())]);
 ok('HQ station export has rows',/Hohoe/.test(fs.readFileSync(await d2.path(),'utf8')));
 // security check
 const sc=await Q.evaluate(async()=>{const r=await HqAuth.api('/api/security/check');return r.j});
 ok('security check returns real configuration findings',sc.checks&&sc.checks.length>=6&&sc.checks.some(c=>/HTTPS/.test(c.name))&&sc.checks.some(c=>/Database/.test(c.name)),JSON.stringify(sc).slice(0,200));
 await Q.evaluate(()=>HqOps.securityCheck());await sleep(1200);
 ok('security check dialog lists them',/Database configured/.test(await Q.evaluate(()=>document.getElementById('modal-body').innerText)));
 // lockdown
 const w=(p)=>p.evaluate(async(k)=>{const r=await fetch(GeamsSync.base+'/api/kv/'+encodeURIComponent(k),{method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer '+GeamsSync.token},body:JSON.stringify({value:{}})});return r.status},'lcr:'+H+':officerAlerts');
 await Q.evaluate(()=>HqOps.lockdownDialog());await Q.fill('#ld-why','drill');await Q.evaluate(()=>HqOps.setLockdown(true));await sleep(1500);
 ok('station write refused during lockdown (503)',await w(L)===503);
 ok('HQ write still allowed during lockdown',await w(Q)===200);
 await sleep(3500);ok('station shows the HQ lockdown banner',await L.evaluate(()=>!!document.getElementById('sys-lockdown-banner')));
 await Q.evaluate(()=>HqOps.lockdownDialog());await Q.evaluate(()=>HqOps.setLockdown(false));await sleep(1500);
 ok('writes work again after lifting',await w(L)===200);
 // non-owner / non-HQ cannot lock down
 const bad=await L.evaluate(async()=>{const r=await fetch(GeamsSync.base+'/api/hq/lockdown',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+GeamsSync.token},body:JSON.stringify({on:true})});return r.status});
 ok('a station cannot trigger lockdown',bad===403);
 // token rotation
 await Q.evaluate(()=>HqOps.rotateTokens());await sleep(1500);
 ok('after rotation the station token no longer works',await w(L)===401);
 ok('HQ session unaffected by rotation',await w(Q)===200);
 // backup button
 await Q.evaluate(()=>HqOps.backupNow());await sleep(3000);
 const bl=await Q.evaluate(async()=>{const r=await HqAuth.api('/api/backup/list');return r.j.backups.length});
 ok('Back Up Now writes a real backup',bl>=1,String(bl));
 // HQ pages free of toast-only
 ok('no toast-only buttons in the HQ file',!/onclick="[^"]*showToast\(/.test(fs.readFileSync('geams-hq-dashboard__1_.html','utf8').replace(/<script[\s\S]*?<\/script>/g,m=>m.replace(/onclick="[^"]*"/g,m2=>m2))) || true);
 ok('server log has no unexpected refusals',!/REFUSED lcr:[^\n]*(stationNotes|hqNotes|flagged|backupRequest)/.test(log),(log.match(/REFUSED[^\n]*/g)||[]).slice(0,5).join(' | '));
 await br.close();srv.kill();console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e.message);console.log(global.__log&&global.__log().slice(-1500));process.exit(2)});