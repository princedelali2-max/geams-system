// A real deployment (demo stations OFF, one real control room): nothing built-in may appear or receive alerts.
const {chromium}=require('playwright');const {spawn}=require('child_process');const fs=require('fs');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+String(typeof x==='string'?x:JSON.stringify(x)).slice(0,300)))};
(async()=>{const R='/tmp/gdemooff';fs.rmSync(R,{recursive:true,force:true});fs.mkdirSync(R,{recursive:true});
const srv=spawn('node',['geams-server.js'],{env:{...process.env,PORT:'8253',GEAMS_DATA:R+'/d.json',GEAMS_HQ_USERS:R+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Audit-Pass-12345',GEAMS_BACKUP_HOURS:'0',GEAMS_ESCALATE_SECS:'0'},stdio:'ignore'});
for(let i=0;i<40;i++){await sleep(250);try{if((await fetch('http://localhost:8253/api/health')).ok)break}catch(e){}}
const B='http://localhost:8253';const J=async(m,p,t,b)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});let j={};try{j=await r.json()}catch(e){}return{s:r.status,j}};
ok('config says demo stations are off',/"demoStations":false/.test(await (await fetch(B+'/config.js')).text()));
const hq=(await J('POST','/api/hq/login',null,{username:'hqadmin',password:'Audit-Pass-12345'})).j.token;
const st=(await J('POST','/api/hq/stations/bulk',hq,{rows:[{name:'Hohoe Control Room',region:'Volta',town:'Hohoe',lat:7.152,lng:0.472}]})).j.created[0];
ok('built-in demo stations cannot log in',(await J('POST','/api/lcr/login',null,{stationId:'GH-GA-ACC-001-B9C1',passphrase:'accra2024'})).s!==200);
const civT=(await J('POST','/api/civilian/session',null,{secret:'demooff'+'x'.repeat(20)})).j.token;
const rec={id:'INC-DEMO01',type:'Crime',priority:'high',status:'new',location:'x',lat:5.55,lng:-0.2,civilianId:'CIV-1',civilianName:'A',createdAt:new Date().toISOString(),source:'civilian-app'};
let rr=await J('PUT','/api/kv/'+encodeURIComponent('lcr:GH-GA-ACC-001-B9C1:incidents'),civT,{value:{'INC-DEMO01':rec}});
ok('an alert filed with a demo (inactive) control room is refused, and the message says call 112',rr.s>=400&&/112/.test(JSON.stringify(rr.j)),rr);
rr=await J('PUT','/api/kv/'+encodeURIComponent('lcr:'+st.id+':incidents'),civT,{value:{'INC-DEMO02':{...rec,id:'INC-DEMO02'}}});ok('an alert for the real control room is accepted',rr.s===200,rr);
const br=await chromium.launch();const mk=async(w)=>{const c=await br.newContext({viewport:{width:w||1366,height:900}});await c.route(/cdnjs|unpkg|jsdelivr|tile|arcgis|openstreetmap|fonts/,r=>r.abort());return c.newPage()};
const C=await mk(390);await C.goto(B+'/geams-civilian-app.html');await sleep(6000);
const cv=await C.evaluate(()=>({dir:CivilianData.stationDirectory.map(s=>s.name),near:CivilianData.nearestStation(5.556,-0.204).station.name}));
ok('civilian in ACCRA is routed to the only real control room (Hohoe), not "Accra Central"',cv.near==='Hohoe Control Room'&&cv.dir.length===1,cv);
const Q=await mk();await Q.goto(B+'/geams-hq-dashboard__1_.html');await sleep(2500);await Q.fill('#hq-user','hqadmin');await Q.fill('#hq-pass','Audit-Pass-12345');await Q.click('#hq-login-btn');await sleep(5500);
const hs=await Q.evaluate(()=>GeamsData.stations.map(s=>s.name));ok('HQ lists only the real control room',hs.length===1&&hs[0]==='Hohoe Control Room',hs);
for(const [f,get] of [['fire-service',()=>FireData.STATION_DIRECTORY.map(s=>s.name)],['ambulance-service',()=>(typeof AmbulanceData!=='undefined'?AmbulanceData:FireData).STATION_DIRECTORY.map(s=>s.name)],['dispatch-app',()=>[...document.querySelectorAll('#su-lcr option')].filter(o=>o.value).map(o=>o.textContent)]]){
 const X=await mk();await X.goto(B+'/geams-'+f+'.html');await sleep(4500);const l=await X.evaluate(get).catch(e=>String(e));ok(f+' offers only the real control room',Array.isArray(l)&&l.length===1&&/Hohoe/.test(l[0]),l)}
await br.close();srv.kill('SIGKILL');console.log(fail?'FAILED '+fail:'passed all '+pass);process.exit(fail?1:0)})().catch(e=>{console.log('ERR',e);process.exit(2)});
